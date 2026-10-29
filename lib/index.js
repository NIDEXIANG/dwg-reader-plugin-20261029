import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFParse } from "pdf-parse";
import { LibreDwg, Dwg_File_Type, DwgCodePage } from "../vendor/libredwg-web/lib/index.js";

const WASM_DIR = fileURLToPath(new URL("../vendor/libredwg-web/wasm", import.meta.url));
const MAX_DWG_BYTES = 512 * 1024 * 1024; // 512 MB 上限，超大图纸会先于 WASM 内存耗尽给出明确报错
const MAX_ENTITY_DETAIL = 2000;
const PYTHON_EXE = "D:\\dsh-home\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";
const DXF_SCRIPT = fileURLToPath(new URL("../scripts/read_dxf.py", import.meta.url));
const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100 MB PDF 上限
const OCR_TIMEOUT_MS = 180000; // OCR 单张图片 180 秒上限

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
        const entities = detailEntities.map((entity) => {
          const base = {
            type: entity.type || "UNKNOWN",
            handle: entity.handle != null ? entity.handle : null,
            layer: entity.layer != null ? entity.layer : null,
            colorIndex: typeof entity.colorIndex === "number" ? entity.colorIndex : null,
            lineType: entity.lineType != null ? entity.lineType : null,
            isInPaperSpace: !!entity.isInPaperSpace,
          };
          if (entity.type === "INSERT") {
            base.blockName = entity.name != null ? String(entity.name) : null;
            base.insertionPoint = entity.insertionPoint
              ? { x: entity.insertionPoint.x, y: entity.insertionPoint.y, z: entity.insertionPoint.z }
              : null;
            base.rotation = typeof entity.rotation === "number" ? entity.rotation : null;
            base.scale = entity.scale
              ? { x: entity.scale.x, y: entity.scale.y, z: entity.scale.z }
              : null;
            base.attribs = Array.isArray(entity.attribs)
              ? entity.attribs.map((a) => ({
                  tag: a.tag != null ? String(a.tag) : null,
                  text: a.text != null ? String(a.text) : null,
                  prompt: a.prompt != null ? String(a.prompt) : null,
                  value: a.value != null ? String(a.value) : null,
                  insertionPoint: a.insertionPoint
                    ? { x: a.insertionPoint.x, y: a.insertionPoint.y, z: a.insertionPoint.z }
                    : null,
                }))
              : [];
          }
          return base;
        });

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

function buildReadDxfTool(ctx) {
  return {
    name: "read_dxf",
    description:
      "读取 DXF 图纸文件（基于 Python ezdxf 桥接，无需安装 AutoCAD）。" +
      "返回 DXF 版本、图层表、块数量、实体统计（按类型计数）与可选实体明细。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        file_path: {
          type: "string",
          description: "DXF 文件路径（绝对路径或相对当前工作目录）。",
        },
        entities: {
          type: "boolean",
          description: "是否返回实体明细列表（默认 false，只返回统计）。",
        },
        entity_limit: {
          type: "integer",
          description: `实体明细最多返回条数（默认 200，上限 ${MAX_ENTITY_DETAIL}）。`,
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
          format: { type: "string", description: "文件格式（固定为 dxf）。" },
          dxfVersion: { type: "string", description: "DXF 版本代号（如 R2010）。" },
          header: { type: "object", additionalProperties: true, description: "图头关键变量。" },
          layerCount: { type: "integer", description: "图层数量。" },
          layers: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "图层表（名称/颜色/线型/开关状态）。",
          },
          blockCount: { type: "integer", description: "块定义数量。" },
          entityCount: { type: "integer", description: "实体总数。" },
          entityTypeCounts: {
            type: "object",
            additionalProperties: true,
            description: "按实体类型统计数量（如 { LINE: 120, TEXT: 8 }）。",
          },
          entities: {
            type: "array",
            items: { type: "object", additionalProperties: true },
            description: "实体明细（仅当 entities=true 时非空）。",
          },
          entitiesTruncated: { type: "boolean", description: "实体明细是否被截断。" },
          error: { type: "string", description: "错误信息；成功时为 null。" },
        },
      },
      render: (args, value) => {
        const lines = [];
        lines.push(`<path>${value.path}</path>`);
        lines.push(`<type>dxf</type>`);
        if (value.error) {
          lines.push(`<content>读取 DXF 失败：${value.error}</content>`);
          return [{ type: "text", text: lines.join("\n") }];
        }
        const sizeMb = (value.fileSizeBytes / 1024 / 1024).toFixed(2);
        lines.push(`<content>已解析 DXF：${value.fileName}（${sizeMb} MB）`);
        lines.push(`版本：${value.dxfVersion}`);
        lines.push(`图层：${value.layerCount} 个${value.layers.length ? " — " + value.layers.map((l) => l.name).join(", ") : ""}`);
        lines.push(`块定义：${value.blockCount} 个；实体：${value.entityCount} 个`);
        const typeLines = Object.entries(value.entityTypeCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20)
          .map(([t, n]) => `${t} ${n}`)
          .join("，");
        if (typeLines) lines.push(`实体构成：${typeLines}${Object.keys(value.entityTypeCounts).length > 20 ? "，…" : ""}`);
        if (value.header && value.header.$ACADVER) lines.push(`图版：${value.header.$ACADVER}`);
        if (value.entities && value.entities.length) {
          lines.push(`实体明细（${value.entities.length}${value.entitiesTruncated ? "，已截断" : ""}）：`);
          const shown = value.entities.slice(0, 50);
          for (const [i, e] of shown.entries()) {
            lines.push(
              `  ${i + 1}. ${e.type} handle=${e.handle} layer=${e.layer}` +
                (e.colorIndex != null ? ` color=${e.colorIndex}` : "") +
                (e.lineType != null ? ` linetype=${e.lineType}` : "")
            );
          }
          if (value.entities.length > shown.length) lines.push(`  …（其余 ${value.entities.length - shown.length} 条未显示）`);
        }
        lines.push(`</content>`);
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta: () => null,
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: "generic",
      title: `读取 DXF ${args.file_path || "(未指定路径)"}`,
      kind: "read",
      locations: [{ path: args.file_path || "" }],
    }),
    presentResult: (args, result) => {
      if (result && result.isError) return undefined;
      return {
        card: "generic",
        title: `DXF 解析完成：${args.file_path || ""}`,
        kind: "read",
        locations: [{ path: args.file_path || "" }],
      };
    },
    async execute(args, exec) {
      if (typeof args !== "object" || args === null) {
        throw new Error('invalid arguments: expected an object with a "file_path" string');
      }
      if (typeof args.file_path !== "string" || !args.file_path.trim()) {
        throw new Error('invalid arguments: "file_path" must be a non-empty string');
      }
      if (args.entities !== undefined && typeof args.entities !== "boolean") {
        throw new Error('invalid arguments: "entities" must be a boolean');
      }
      if (args.entity_limit !== undefined && (typeof args.entity_limit !== "number" || !Number.isInteger(args.entity_limit))) {
        throw new Error('invalid arguments: "entity_limit" must be an integer');
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

      const pythonArgs = [
        DXF_SCRIPT,
        args.file_path.trim(),
        String(args.entity_limit || 200),
        String(args.entities === true),
      ];

      const result = await new Promise((resolve, reject) => {
        const proc = spawn(PYTHON_EXE, pythonArgs, { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Python 进程退出码 ${code}: ${stderr || stdout}`));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (err) {
            reject(new Error(`DXF 结果解析失败: ${err.message}; stdout=${stdout.slice(0, 200)}`));
          }
        });
        proc.on("error", (err) => reject(new Error(`无法启动 Python 进程: ${err.message}`)));
      });

      if (result.error) {
        throw new Error(`cannot read "${displayPath}": ${result.error}`);
      }

      ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);

      return toJson({
        path: displayPath,
        fileName: displayPath.split(/[\\/]/).pop(),
        fileSizeBytes: result.fileSizeBytes ?? info.size !== undefined ? info.size : 0,
        format: result.format ?? "dxf",
        dxfVersion: result.dxfVersion ?? "",
        header: result.header ?? {},
        layerCount: result.layerCount ?? 0,
        layers: result.layers ?? [],
        blockCount: result.blockCount ?? 0,
        entityCount: result.entityCount ?? 0,
        entityTypeCounts: result.entityTypeCounts ?? {},
        entities: result.entities ?? [],
        entitiesTruncated: !!result.entitiesTruncated,
      });
    },
  };
}

export const inject = ["tools", "fs", "workingDirectory"];

export function apply(ctx, config) {
  const disposeDwg = ctx.tools.register(buildReadDwgTool(ctx));
  const disposeDxf = ctx.tools.register(buildReadDxfTool(ctx));
  const disposePdf = ctx.tools.register(buildReadPdfTool(ctx));
  const disposeImage = ctx.tools.register(buildReadImageTool(ctx));
  return () => {
    disposeDwg();
    disposeDxf();
    disposePdf();
    disposeImage();
  };
}

// ---------------------------------------------------------------------------
// ocr_image：图片头解析 + 内置 tesseract.js（WASM）OCR
// 不依赖外部 Tesseract 可执行文件或 Pillow；语言包可用 tessdata_prefix 指向本地目录，
// 缺省时依次探测常见 tessdata 目录，仍未命中则按需从 CDN 下载并缓存。
// ---------------------------------------------------------------------------

const COMMON_TESSDATA_DIRS = [
  process.env.TESSDATA_PREFIX,
  "D:\\Tools\\Tesseract-OCR\\tessdata",
  "C:\\Program Files\\Tesseract-OCR\\tessdata",
  "/usr/share/tesseract-ocr/4.00/tessdata",
  "/usr/share/tessdata",
  "/opt/homebrew/share/tessdata",
].filter(Boolean);

function be4(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
function be2(bytes, offset) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}
function le4(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}
function le2(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** 从文件头解析图片格式与像素尺寸；无法识别时返回 null。 */
function parseImageInfo(bytes) {
  if (!bytes || bytes.length < 12) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const colorType = bytes[25];
    const mode = { 0: "GRAY", 2: "RGB", 3: "PALETTE", 4: "GRAY+ALPHA", 6: "RGBA" }[colorType] ?? null;
    return { format: "PNG", width: be4(bytes, 16) || null, height: be4(bytes, 20) || null, mode };
  }
  // JPEG
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 10 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9) break;
      const segLen = be2(bytes, i + 2);
      if (segLen < 2) break;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const comps = bytes[i + 9];
        const mode = comps === 1 ? "GRAY" : comps === 3 ? "RGB" : comps === 4 ? "CMYK" : null;
        return { format: "JPEG", width: be2(bytes, i + 7) || null, height: be2(bytes, i + 5) || null, mode };
      }
      i += 2 + segLen;
    }
    return { format: "JPEG", width: null, height: null, mode: null };
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { format: "GIF", width: le2(bytes, 6) || null, height: le2(bytes, 8) || null, mode: null };
  }
  // BMP
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { format: "BMP", width: Math.abs(le4(bytes, 18)) || null, height: Math.abs(le4(bytes, 22)) || null, mode: null };
  }
  // WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunk === "VP8X") {
      return {
        format: "WEBP",
        width: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1,
        height: (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1,
        mode: null,
      };
    }
    if (chunk === "VP8L") {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return { format: "WEBP", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mode: null };
    }
    if (chunk === "VP8 ") {
      return { format: "WEBP", width: le2(bytes, 26) & 0x3fff, height: le2(bytes, 28) & 0x3fff, mode: null };
    }
    return { format: "WEBP", width: null, height: null, mode: null };
  }
  // TIFF（只读取第一个 IFD 的宽高标签）
  if ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4d && bytes[1] === 0x4d)) {
    const little = bytes[0] === 0x49;
    const u2 = (o) => (little ? le2(bytes, o) : be2(bytes, o));
    const u4 = (o) => (little ? le4(bytes, o) : be4(bytes, o));
    let width = null;
    let height = null;
    try {
      const ifd = u4(4);
      const count = u2(ifd);
      for (let k = 0; k < Math.min(count, 256); k += 1) {
        const entry = ifd + 2 + k * 12;
        const tag = u2(entry);
        const type = u2(entry + 2);
        const valueOffset = entry + 8;
        if (tag === 256) width = type === 3 ? u2(valueOffset) : u4(valueOffset);
        else if (tag === 257) height = type === 3 ? u2(valueOffset) : u4(valueOffset);
      }
    } catch {
      /* 无法解析时保留 null */
    }
    return { format: "TIFF", width: width || null, height: height || null, mode: null };
  }
  return null;
}

function checkTessdataDir(dir, codes) {
  if (!dir || !existsSync(dir)) return { dir, missing: codes };
  const missing = codes.filter((code) => {
    try {
      return !existsSync(join(dir, `${code}.traineddata`)) && !existsSync(join(dir, `${code}.traineddata.gz`));
    } catch {
      return true;
    }
  });
  return { dir, missing };
}

/** 解析语言包目录：优先显式 tessdata_prefix（缺失即报错），否则探测常见目录，最后才联网。 */
function resolveTessdataDir(codes, explicitDir) {
  if (explicitDir) {
    if (!existsSync(explicitDir)) {
      throw new Error(`tessdata_prefix 目录不存在: ${explicitDir}`);
    }
    const checked = checkTessdataDir(explicitDir, codes);
    if (checked.missing.length) {
      throw new Error(
        `tessdata_prefix 缺少语言包: ${checked.missing.map((c) => `${c}.traineddata`).join("、")}（目录 ${explicitDir}）`
      );
    }
    return explicitDir;
  }
  for (const dir of COMMON_TESSDATA_DIRS) {
    const checked = checkTessdataDir(dir, codes);
    if (checked.dir && checked.missing.length === 0) return checked.dir;
  }
  return null;
}

let ocrWorkerPromise = null;
let ocrWorkerKey = null;
let ocrWorkerLangs = "";

async function disposeOcrWorker() {
  const pending = ocrWorkerPromise;
  ocrWorkerPromise = null;
  ocrWorkerKey = null;
  ocrWorkerLangs = "";
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* 忽略清理失败 */
  }
}

/** 复用单个 OCR worker；语言变化时 reinitialize。 */
async function getOcrWorker(codes, key, options) {
  const joined = codes.join("+");
  if (ocrWorkerPromise !== null && ocrWorkerKey === key) {
    const worker = await ocrWorkerPromise;
    if (ocrWorkerLangs !== joined) {
      await worker.reinitialize(codes, 1);
      ocrWorkerLangs = joined;
    }
    return worker;
  }
  await disposeOcrWorker();
  ocrWorkerKey = key;
  ocrWorkerLangs = joined;
  ocrWorkerPromise = (async () => {
    const { createWorker } = await import("tesseract.js");
    return createWorker(codes, 1, options);
  })();
  return ocrWorkerPromise;
}

function raceWithAbort(promise, exec, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exec.signal) exec.signal.removeEventListener("abort", onAbort);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`OCR 超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)),
      timeoutMs
    );
    const onAbort = () => finish(reject, exec.signal.reason ?? new Error("aborted"));
    if (exec.signal) {
      if (exec.signal.aborted) {
        onAbort();
        return;
      }
      exec.signal.addEventListener("abort", onAbort);
    }
    promise.then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

async function runOcr(imagePath, codes, tessdataParam, exec) {
  const localDir = resolveTessdataDir(codes, tessdataParam);
  const options = localDir
    ? { langPath: localDir, gzip: false, cacheMethod: "none" }
    : { cachePath: join(tmpdir(), "dwg-reader-ocr-cache"), gzip: true };
  const key = localDir ? `local:${localDir}` : "cdn";
  const worker = await getOcrWorker(codes, key, options);
  const started = Date.now();
  const result = await raceWithAbort(worker.recognize(imagePath), exec, OCR_TIMEOUT_MS);
  const text = String(result?.data?.text ?? "").replace(/\r\n/g, "\n").trim();
  return {
    text,
    source: localDir ? "local" : "download",
    langPath: localDir ?? null,
    elapsedMs: Date.now() - started,
  };
}

function splitLangs(lang) {
  const raw = typeof lang === "string" && lang.trim() ? lang : "chi_sim+eng";
  const codes = raw.split(/[+,]/).map((s) => s.trim()).filter(Boolean);
  if (!codes.length) return ["chi_sim", "eng"];
  for (const code of codes) {
    if (!/^[a-z0-9_]+$/i.test(code)) {
      throw new Error(`invalid arguments: "lang" 含非法语言码 "${code}"（应为 chi_sim、eng、jpn 等）`);
    }
  }
  return codes;
}

function buildReadImageTool(ctx) {
  return {
    name: "ocr_image",
    description:
      "对图片/截屏做 OCR 文字提取（返回格式、像素尺寸、颜色模式与识别文字；不返回图片本体——看图请用内置 read_image）。" +
      "无需安装 Tesseract 或图片查看软件，内置 tesseract.js WASM。支持 PNG/JPEG/WebP/BMP/GIF/TIFF；" +
      "支持 Tesseract 全部语言（lang 参数，默认 chi_sim+eng），可用 tessdata_prefix 指向本地 traineddata 目录离线使用，" +
      "未提供时自动探测常见目录，仍无则联网下载并缓存。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        file_path: {
          type: "string",
          description: "图片文件路径（绝对路径或相对当前工作目录）。",
        },
        ocr: {
          type: "boolean",
          description: "是否执行 OCR 文字提取（默认 true）。",
        },
        lang: {
          type: "string",
          description:
            "OCR 语言码，+ 或逗号连接多个（默认 chi_sim+eng；支持 eng、chi_tra、jpn、kor、deu、fra、rus、spa、ita、por、ara、vie、tha、hin 等 Tesseract 全量语言）。",
        },
        tessdata_prefix: {
          type: "string",
          description:
            "本地 traineddata 目录（可选；提供后只读本地语言包、不联网。目录内需有 <语言码>.traineddata 或 .traineddata.gz；缺包会报错并列出缺项）。",
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
          format: { type: "string", description: "图片格式（如 PNG/JPEG）。" },
          width: { oneOf: [{ type: "integer" }, { type: "null" }], description: "图片宽度（像素）。" },
          height: { oneOf: [{ type: "integer" }, { type: "null" }], description: "图片高度（像素）。" },
          mode: { oneOf: [{ type: "string" }, { type: "null" }], description: "颜色模式（如 RGB/RGBA）。" },
          lang: { type: "string", description: "实际使用的 OCR 语言码。" },
          tessdataSource: { type: "string", description: "语言包来源：local（本地目录）/download（联网下载）/none（未启用 OCR）。" },
          ocrText: { type: "string", description: "OCR 提取的文字（可能为空）。" },
          ocrError: { oneOf: [{ type: "string" }, { type: "null" }], description: "OCR 错误信息；成功时为 null。" },
          ocrElapsedMs: { type: "integer", description: "OCR 耗时（毫秒）。" },
        },
      },
      render: (args, value) => {
        const lines = [];
        lines.push(`<path>${value.path}</path>`);
        lines.push(`<type>image</type>`);
        const sizeKb = (value.fileSizeBytes / 1024).toFixed(1);
        lines.push(`<content>已解析图片：${value.fileName}（${sizeKb} KB）`);
        const dims = value.width != null && value.height != null ? `${value.width}×${value.height}` : "未知";
        lines.push(`格式：${value.format}；尺寸：${dims}；模式：${value.mode ?? "未知"}`);
        if (value.ocrElapsedMs > 0) {
          const source = value.tessdataSource === "local" ? "本地语言包" : "联网下载语言包";
          lines.push(`OCR 语言：${value.lang}（${source}，耗时 ${(value.ocrElapsedMs / 1000).toFixed(1)} 秒）`);
        } else {
          lines.push("OCR：未启用");
        }
        if (value.ocrError) lines.push(`OCR 错误：${value.ocrError}`);
        if (value.ocrText) {
          const preview = value.ocrText.slice(0, 300);
          lines.push(`OCR 文字（${value.ocrText.length} 字符）：${preview}${value.ocrText.length > 300 ? "…" : ""}`);
        } else if (!value.ocrError) {
          lines.push("OCR 文字：无（未识别出文字）");
        }
        lines.push(`</content>`);
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta: () => null,
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: "generic",
      title: `读取图片 ${args.file_path || "(未指定路径)"}`,
      kind: "read",
      locations: [{ path: args.file_path || "" }],
    }),
    presentResult: (args, result) => {
      if (result && result.isError) return undefined;
      return {
        card: "generic",
        title: `图片解析完成：${args.file_path || ""}`,
        kind: "read",
        locations: [{ path: args.file_path || "" }],
      };
    },
    async execute(args, exec) {
      if (typeof args !== "object" || args === null) {
        throw new Error('invalid arguments: expected an object with a "file_path" string');
      }
      if (typeof args.file_path !== "string" || !args.file_path.trim()) {
        throw new Error('invalid arguments: "file_path" must be a non-empty string');
      }
      if (args.ocr !== undefined && typeof args.ocr !== "boolean") {
        throw new Error('invalid arguments: "ocr" must be a boolean');
      }
      if (args.lang !== undefined && typeof args.lang !== "string") {
        throw new Error('invalid arguments: "lang" must be a string');
      }
      if (args.tessdata_prefix !== undefined && typeof args.tessdata_prefix !== "string") {
        throw new Error('invalid arguments: "tessdata_prefix" must be a string');
      }
      const langCodes = splitLangs(args.lang);

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

      // 先读文件头判断格式与尺寸（最多 2 MB，足够覆盖 JPEG 的 SOF 段）
      const header = await ctx.fs.readBytes(target, exec.signal, 2 * 1024 * 1024);
      const parsed = parseImageInfo(header);
      if (!parsed) {
        throw new Error(`cannot read "${displayPath}": 无法识别的图片格式（支持 PNG/JPEG/WebP/BMP/GIF/TIFF）`);
      }

      let ocrText = "";
      let ocrError = null;
      let tessdataSource = "none";
      let ocrElapsedMs = 0;
      if (args.ocr !== false) {
        try {
          const ocr = await runOcr(args.file_path.trim(), langCodes, args.tessdata_prefix, exec);
          ocrText = ocr.text;
          tessdataSource = ocr.source;
          ocrElapsedMs = ocr.elapsedMs;
        } catch (error) {
          ocrError = error?.message ?? String(error);
          // OCR 失败或超时后 worker 可能仍卡在识别中，销毁以便下次重建
          await disposeOcrWorker();
        }
      }

      ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);

      return toJson({
        path: displayPath,
        fileName: displayPath.split(/[\\/]/).pop(),
        fileSizeBytes: info.size !== undefined ? info.size : 0,
        format: parsed.format,
        width: parsed.width,
        height: parsed.height,
        mode: parsed.mode,
        lang: langCodes.join("+"),
        tessdataSource,
        ocrText,
        ocrError,
        ocrElapsedMs,
      });
    },
  };
}

function buildReadPdfTool(ctx) {
  return {
    name: "read_pdf",
    description:
      "读取 PDF 文件（基于 pdf-parse，无需安装 Adobe Acrobat）。" +
      "返回 PDF 页数、元数据（标题/作者/创建日期等）与可选全文文本。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        file_path: {
          type: "string",
          description: "PDF 文件路径（绝对路径或相对当前工作目录）。",
        },
        extract_text: {
          type: "boolean",
          description: "是否提取全文文本（默认 true）。",
        },
        max_text_chars: {
          type: "integer",
          description: "提取文本的最大字符数（默认 50000，0 表示不限制）。",
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
          format: { type: "string", description: "文件格式（固定为 pdf）。" },
          pageCount: { type: "integer", description: "PDF 页数。" },
          metadata: { type: "object", additionalProperties: true, description: "PDF 元数据（标题、作者、创建日期等）。" },
          text: { type: "string", description: "提取的全文文本（可能被截断）。" },
          textLength: { type: "integer", description: "提取文本的字符数。" },
          textTruncated: { type: "boolean", description: "文本是否被截断。" },
          error: { type: "string", description: "错误信息；成功时为 null。" },
        },
      },
      render: (args, value) => {
        const lines = [];
        lines.push(`<path>${value.path}</path>`);
        lines.push(`<type>pdf</type>`);
        if (value.error) {
          lines.push(`<content>读取 PDF 失败：${value.error}</content>`);
          return [{ type: "text", text: lines.join("\n") }];
        }
        const sizeMb = (value.fileSizeBytes / 1024 / 1024).toFixed(2);
        lines.push(`<content>已解析 PDF：${value.fileName}（${sizeMb} MB）`);
        lines.push(`页数：${value.pageCount}`);
        if (value.metadata && Object.keys(value.metadata).length) {
          const metaLines = Object.entries(value.metadata)
            .filter(([, v]) => v != null && String(v).trim())
            .map(([k, v]) => `  ${k}: ${v}`)
            .join("\n");
          if (metaLines) lines.push(`元数据：\n${metaLines}`);
        }
        lines.push(`文本长度：${value.textLength} 字符${value.textTruncated ? "（已截断）" : ""}`);
        if (value.text) {
          const preview = value.text.slice(0, 300);
          lines.push(`文本预览：${preview}${value.text.length > 300 ? "…" : ""}`);
        }
        lines.push(`</content>`);
        return [{ type: "text", text: lines.join("\n") }];
      },
      presentationMeta: () => null,
    },
    isConcurrencySafe: () => false,
    presentCall: (args) => ({
      card: "generic",
      title: `读取 PDF ${args.file_path || "(未指定路径)"}`,
      kind: "read",
      locations: [{ path: args.file_path || "" }],
    }),
    presentResult: (args, result) => {
      if (result && result.isError) return undefined;
      return {
        card: "generic",
        title: `PDF 解析完成：${args.file_path || ""}`,
        kind: "read",
        locations: [{ path: args.file_path || "" }],
      };
    },
    async execute(args, exec) {
      if (typeof args !== "object" || args === null) {
        throw new Error('invalid arguments: expected an object with a "file_path" string');
      }
      if (typeof args.file_path !== "string" || !args.file_path.trim()) {
        throw new Error('invalid arguments: "file_path" must be a non-empty string');
      }
      if (args.extract_text !== undefined && typeof args.extract_text !== "boolean") {
        throw new Error('invalid arguments: "extract_text" must be a boolean');
      }
      if (args.max_text_chars !== undefined && (typeof args.max_text_chars !== "number" || !Number.isInteger(args.max_text_chars))) {
        throw new Error('invalid arguments: "max_text_chars" must be an integer');
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
      if (info.size !== undefined && info.size > MAX_PDF_BYTES) {
        throw new Error(
          `cannot read "${displayPath}": file is ${(info.size / 1024 / 1024).toFixed(1)} MB, ` +
            `超过 ${MAX_PDF_BYTES / 1024 / 1024} MB 上限`
        );
      }
      const bytes = await ctx.fs.readBytes(target, exec.signal, MAX_PDF_BYTES);
      ctx.emit("fs/observed", target, { kind: "present", version: info.version }, exec);

      let parser;
      try {
        parser = new PDFParse({ data: bytes });
      } catch (error) {
        throw new Error(`cannot parse "${displayPath}": 初始化 PDF 解析器失败: ${error.message}`);
      }

      let text = "";
      let textTruncated = false;
      let pageCount = 0;
      let metadata = {};
      try {
        const infoResult = await parser.getInfo();
        pageCount =
          infoResult.total != null
            ? Number(infoResult.total)
            : infoResult.info?.Pages != null
              ? Number(infoResult.info.Pages)
              : 0;
        metadata = infoResult.metadata ?? infoResult.info ?? {};
        if (args.extract_text !== false) {
          const textResult = await parser.getText();
          text = textResult?.text ?? "";
          const maxChars = args.max_text_chars ?? 50000;
          if (maxChars > 0 && text.length > maxChars) {
            text = text.slice(0, maxChars);
            textTruncated = true;
          }
        }
      } catch (error) {
        throw new Error(`cannot parse "${displayPath}": PDF 内容提取失败: ${error.message}`);
      }

      return toJson({
        path: displayPath,
        fileName: displayPath.split(/[\\/]/).pop(),
        fileSizeBytes: info.size !== undefined ? info.size : bytes.byteLength,
        format: "pdf",
        pageCount,
        metadata,
        text,
        textLength: text.length,
        textTruncated,
      });
    },
  };
}
