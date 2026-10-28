import { fileURLToPath } from "node:url";
import { LibreDwg, Dwg_File_Type, DwgCodePage } from "../vendor/libredwg-web/lib/index.js";

const WASM_DIR = fileURLToPath(new URL("../vendor/libredwg-web/wasm", import.meta.url));
const MAX_DWG_BYTES = 512 * 1024 * 1024; // 512 MB 上限，超大图纸会先于 WASM 内存耗尽给出明确报错
const MAX_ENTITY_DETAIL = 2000;

let libreDwgPromise;

function getLibreDwg() {
  if (!libreDwgPromise) {
    libreDwgPromise = LibreDwg.create(WASM_DIR);
  }
  return libreDwgPromise;
}

async function sessionResolveOptions(ctx, exec) {
  const cwd =
    exec.agent === undefined
      ? undefined
      : await ctx.workingDirectory.ensure(exec.agent, exec.signal).catch(() => undefined);
  return {
    ...(cwd !== undefined ? { cwd } : {}),
    signal: exec.signal,
  };
}

function dateToIso(value) {
  if (value instanceof Date) return value.toISOString();
  return value ? String(value) : null;
}

function pointToObj(point) {
  if (!point) return null;
  return { x: point.x, y: point.y, z: point.z };
}

/**
 * 把返回值收敛为纯 JSON：丢掉 undefined 属性，避免 snapshot 校验失败。
 */
function toJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildReadDwgTool(ctx) {
  return {
    name: "read_dwg",
    description:
      "直接读取 AutoCAD DWG 图纸文件（基于 libredwg WASM 解析，无需安装 AutoCAD）。" +
      "返回图纸版本、编码、图层表、块数量、实体统计（按类型计数）与可选实体明细；" +
      "可选导出 SVG 预览。适用于查看 DWG 的图层/实体构成、核对图纸信息。注意：DXF 暂不支持，" +
      "大图纸（>100MB）可能因 WASM 内存不足失败。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        file_path: {
          type: "string",
          description: "DWG 文件路径（绝对路径或相对当前工作目录）。",
        },
        entities: {
          type: "boolean",
          description: "是否返回实体明细列表（默认 false，只返回统计）。",
        },
        entity_limit: {
          type: "integer",
          description: `实体明细最多返回条数（默认 200，上限 ${MAX_ENTITY_DETAIL}）。`,
        },
        export_svg: {
          type: "boolean",
          description: "是否同时导出 SVG 预览文件（默认 false）。",
        },
        svg_output_path: {
          type: "string",
          description: "SVG 输出路径；缺省时写到 DWG 同目录下的同名 .svg 文件。",
        },
      },
      required: ["file_path"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          path: { type: "string", description: "解析后的文件路径。" },
          fileName: { type: "string", description: "文件名。" },
          fileSizeBytes: { type: "integer", description: "文件字节数。" },
          versionType: { type: "string", description: "DWG 版本代号（如 AC1018 / r2007）。" },
          versionDescription: { type: "string", description: "版本描述（如 AutoCAD 2007）。" },
          codepage: { type: "integer", description: "编码页枚举值（未知为 -1）。" },
          codepageName: { type: "string", description: "编码页名称（如 CP_ANSI_936）。" },
          header: { type: "object", additionalProperties: true, description: "图头关键变量。" },
          layerCount: { type: "integer", description: "图层数量。" },
          layers: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "图层表（名称/颜色/线型/开关状态）。",
          },
          blockCount: { type: "integer", description: "块记录数量。" },
          entityCount: { type: "integer", description: "实体总数。" },
          entityTypeCounts: {
            type: "object",
            additionalProperties: true,
            description: "按实体类型统计数量（如 { LINE: 120, TEXT: 8 }）。",
          },
          unknownEntityCount: { type: "integer", description: "无法识别类型而被跳过的实体数。" },
          thumbnailPresent: { type: "boolean", description: "图纸是否带缩略图。" },
          entities: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "实体明细（仅当 entities=true 时非空）。",
          },
          entitiesTruncated: { type: "boolean", description: "实体明细是否被截断。" },
          svgPath: {
            oneOf: [{ type: "string" }, { type: "null" }],
            description: "导出的 SVG 文件路径；未导出时为 null。",
          },
        },
      },
      render: (args, value) => {
        const lines = [];
        lines.push(`<path>${value.path}</path>`);
        lines.push(`<type>dwg</type>`);
        const sizeMb = (value.fileSizeBytes / 1024 / 1024).toFixed(2);
        lines.push(`<content>已解析 DWG：${value.fileName}（${sizeMb} MB）`);
        lines.push(`版本：${value.versionDescription}（${value.versionType}）`);
        lines.push(`编码：${value.codepageName}`);
        lines.push(`图层：${value.layerCount} 个${value.layers.length ? " — " + value.layers.map((l) => l.name).join(", ") : ""}`);
        lines.push(`块记录：${value.blockCount} 个；实体：${value.entityCount} 个`);
        const typeLines = Object.entries(value.entityTypeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([t, n]) => `${t} ${n}`)
          .join("，");
        if (typeLines) lines.push(`实体构成：${typeLines}${Object.keys(value.entityTypeCounts).length > 20 ? "，…" : ""}`);
        if (value.unknownEntityCount) lines.push(`未识别实体：${value.unknownEntityCount} 个`);
        if (value.header && value.header.extmin && value.header.extmax) {
          lines.push(
            `图幅范围：X ${value.header.extmin.x}~${value.header.extmax.x}，Y ${value.header.extmin.y}~${value.header.extmax.y}`
          );
        }
        if (value.svgPath) lines.push(`SVG 预览：${value.svgPath}`);
        if (value.entities && value.entities.length) {
          lines.push(`实体明细（${value.entities.length}${value.entitiesTruncated ? "，已截断" : ""}）：`);
          const shown = value.entities.slice(0, 50);
          for (const [i, e] of shown.entries()) {
            lines.push(
              `  ${i + 1}. ${e.type} handle=${e.handle} layer=${e.layer}` +
                (e.colorIndex != null ? ` color=${e.colorIndex}` : "") +
                (e.lineType != null ? ` linetype=${e.lineType}` : "") +
                (e.isInPaperSpace ? " (图纸空间)" : "")
            );
          }
          if (value.entities.length > shown.length) lines.push(`  …（其余 ${value.entities.length - shown.length} 条未显示）`);
        }
        lines.push(`</content>`);
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta: () => null,
    },
    isConcurrencySafe: () => false, // WASM 单例 + tmp.dwg 固定文件名，串行执行
    presentCall: (args) => ({
      card: "generic",
      title: `读取 DWG ${args.file_path || "(未指定路径)"}`,
      kind: "read",
      locations: [{ path: args.file_path || "" }],
    }),
    presentResult: (args, result) => {
      if (result && result.isError) return undefined;
      return {
        card: "generic",
        title: `DWG 解析完成：${args.file_path || ""}`,
        kind: "read",
        locations: [{ path: args.file_path || "" }],
      };
    },
    async execute(args, exec) {
      if (typeof args !== "object" || args === null) {
        throw new Error(`invalid arguments: expected an object with a "file_path" string`);
      }
      if (typeof args.file_path !== "string" || !args.file_path.trim()) {
        throw new Error('invalid arguments: "file_path" must be a non-empty string');
      }
      if (args.entities !== undefined && typeof args.entities !== "boolean") {
        throw new Error('invalid arguments: "entities" must be a boolean');
      }
      if (args.export_svg !== undefined && typeof args.export_svg !== "boolean") {
        throw new Error('invalid arguments: "export_svg" must be a boolean');
      }
      if (args.entity_limit !== undefined && (typeof args.entity_limit !== "number" || !Number.isInteger(args.entity_limit))) {
        throw new Error('invalid arguments: "entity_limit" must be an integer');
      }
      if (args.svg_output_path !== undefined && typeof args.svg_output_path !== "string") {
        throw new Error('invalid arguments: "svg_output_path" must be a string');
      }

      const resolveOptions = await sessionResolveOptions(ctx, exec);
      const target = await ctx.fs.resolve(args.file_path.trim(), resolveOptions);
      const info = await ctx.fs.stat(target, exec.signal);
      const displayPath = ctx.fs.processPath(target);
      if (!info) {
        ctx.emit("fs/observed", target, { kind: "absent" }, exec);
        throw new Error(`cannot read "${displayPath}": not found`);
      }
      if (info.type !== "file") {
        throw new Error(`cannot read "${displayPath}": not a regular file`);
      }
      if (info.size !== undefined && info.size > MAX_DWG_BYTES) {
        throw new Error(
          `cannot read "${displayPath}": file is ${(info.size / 1024 / 1024).toFixed(1)} MB, ` +
            `超过 ${MAX_DWG_BYTES / 1024 / 1024} MB 上限`
        );
      }
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_DWG_BYTES);
      ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);

      if (displayPath.toLowerCase().endsWith(".dxf")) {
        throw new Error(`cannot read "${displayPath}": DXF 暂不受支持（本插件当前仅解析 DWG）`);
      }

      let dwg;
      try {
        dwg = await getLibreDwg();
      } catch (error) {
        throw new Error(`cannot read "${displayPath}": 初始化 DWG 解析引擎失败: ${error.message}`);
      }

      const dataPtr = dwg.dwg_read_data(bytes, Dwg_File_Type.DWG);
      if (!dataPtr) {
        throw new Error(`cannot read "${displayPath}": not a valid DWG file (decode failed)`);
      }
      try {
        const version = dwg.dwg_get_version_type(dataPtr) || {};
        const codepage = dwg.dwg_get_codepage(dataPtr);
        const converted = dwg.convertEx(dataPtr);
        const database = converted.database;
        const stats = converted.stats || {};

        if (!database || (!database.entities.length && !database.tables.LAYER.entries.length)) {
          throw new Error(`cannot read "${displayPath}": 未解析出任何图层或实体，可能不是有效的 DWG`);
        }

        const header = database.header || {};
        const headerSummary = {};
        if (header.ACADVER != null) headerSummary.acadver = String(header.ACADVER);
        if (header.DWGCODEPAGE != null) headerSummary.dwgcodepage = String(header.DWGCODEPAGE);
        if (header.INSUNITS != null) headerSummary.insunits = header.INSUNITS;
        if (header.EXTMIN) headerSummary.extmin = pointToObj(header.EXTMIN);
        if (header.EXTMAX) headerSummary.extmax = pointToObj(header.EXTMAX);
        const tdc = dateToIso(header.TDCREATE);
        const tdu = dateToIso(header.TDUPDATE);
        if (tdc) headerSummary.created = tdc;
        if (tdu) headerSummary.updated = tdu;
        if (header.CLAYER) headerSummary.currentLayer = String(header.CLAYER);

        const layers = database.tables.LAYER.entries.map((layer) => ({
          name: layer.name,
          colorIndex: typeof layer.colorIndex === "number" ? layer.colorIndex : null,
          colorName: layer.colorName != null ? layer.colorName : null,
          lineType: layer.lineType != null ? layer.lineType : null,
          frozen: !!layer.frozen,
          off: !!layer.off,
          locked: !!layer.locked,
          plot: layer.plotFlag != null ? !!layer.plotFlag : null,
        }));

        const entityTypeCounts = {};
        for (const entity of database.entities) {
          const t = entity.type || "UNKNOWN";
          entityTypeCounts[t] = (entityTypeCounts[t] || 0) + 1;
        }

        const limit = Math.min(Math.max(1, args.entity_limit || 200), MAX_ENTITY_DETAIL);
        const detailEntities = args.entities ? database.entities.slice(0, limit) : [];
        const entities = detailEntities.map((entity) => ({
          type: entity.type || "UNKNOWN",
          handle: entity.handle != null ? entity.handle : null,
          layer: entity.layer != null ? entity.layer : null,
          colorIndex: typeof entity.colorIndex === "number" ? entity.colorIndex : null,
          lineType: entity.lineType != null ? entity.lineType : null,
          isInPaperSpace: !!entity.isInPaperSpace,
        }));

        let svgPath = null;
        if (args.export_svg) {
          let svgText;
          try {
            svgText = dwg.dwg_to_svg(database);
          } catch (error) {
            throw new Error(`cannot export SVG for "${displayPath}": ${error.message}`);
          }
          const svgDisplay =
            args.svg_output_path && args.svg_output_path.trim()
              ? args.svg_output_path.trim()
              : displayPath.replace(/\.dwg$/i, "") + ".dwg.svg";
          const svgTarget = await ctx.fs.resolve(svgDisplay, resolveOptions);
          let sandboxPolicy;
          if (ctx.fs.sandboxMode !== undefined) {
            const policyService = ctx.get("sandboxPolicy");
            if (policyService) {
              try {
                sandboxPolicy = policyService.resolve({
                  ...(exec.agent ? { session: exec.agent.session } : {}),
                });
              } catch {}
            }
          }
          const intent = await ctx.waterfall("fs/write-intent", svgTarget, exec, () => undefined);
          let outcome;
          try {
            outcome = await ctx.fs.writeText(svgTarget, svgText, intent, exec.signal, sandboxPolicy);
          } catch (error) {
            throw new Error(
              `cannot write SVG "${svgDisplay}": ${error.message}（可改用 svg_output_path 指向工作区内的路径）`
            );
          }
          ctx.emit("fs/observed", svgTarget, { kind: "present", version: outcome.version }, exec);
          svgPath = ctx.fs.processPath(svgTarget);
        }

        return toJson({
          path: displayPath,
          fileName: displayPath.split(/[\\/]/).pop(),
          fileSizeBytes: info.size !== undefined ? info.size : bytes.byteLength,
          versionType: version.type != null ? String(version.type) : "",
          versionDescription: version.description != null ? String(version.description) : "",
          codepage: typeof codepage === "number" ? codepage : -1,
          codepageName: DwgCodePage[codepage] != null ? String(DwgCodePage[codepage]) : "CP_UNKNOWN",
          header: headerSummary,
          layerCount: layers.length,
          layers,
          blockCount: database.tables.BLOCK_RECORD.entries.length,
          entityCount: database.entities.length,
          entityTypeCounts,
          unknownEntityCount: stats.unknownEntityCount || 0,
          thumbnailPresent: !!database.thumbnailImage,
          entities,
          entitiesTruncated: !!args.entities && database.entities.length > limit,
          svgPath,
        });
      } finally {
        try {
          dwg.dwg_free(dataPtr);
        } catch {}
      }
    },
  };
}

export const inject = ["tools", "fs", "workingDirectory"];

export function apply(ctx, config) {
  const dispose = ctx.tools.register(buildReadDwgTool(ctx));
  return () => dispose();
}
