# @bill_nee/dwg-reader

DSH（DeepSeek Harness）插件：可直接读取 AutoCAD DWG 格式图纸，无需安装 AutoCAD。

基于 [libredwg-web](https://github.com/mlightcad/libredwg-web) 0.8.2 WASM 编译，在浏览器/Node 环境中解析 DWG 文件，返回图层、实体、版本、编码、图幅等信息，并可导出 SVG 预览。

## 安装

在 DSH 工作台或终端执行：

```powershell
dsh plugin --profile desktop add @bill_nee/dwg-reader@1.1.0
```

安装后在 DSH 工作台插件管理中启用插件，即可使用 `read_dwg` 工具读取 DWG 图纸。

## 主要能力

| 能力 | 说明 |
|------|------|
| 读取 DWG | 支持 AutoCAD R14~R2018 等常见版本（AC1015~AC1032） |
| 图层信息 | 返回所有图层名称、颜色、冻结/关闭/锁定状态 |
| 实体统计 | 返回实体总数及按类型（LINE/TEXT/INSERT/HATCH/DIMENSION 等）分类统计 |
| 图纸版本 | 返回 ACADVER、版本号、版本描述（如 r2018/AC1032/AutoCAD Release 2018） |
| 代码页 | 返回 DWG 代码页（如 CP_ANSI_936） |
| 图幅信息 | 返回 EXTMIN/EXTMAX 边界框 |
| 导出 SVG | 可将 DWG 内容导出为 SVG 预览文件到指定路径 |
| 错误处理 | 对无效/损坏/非 DWG 文件给出明确错误提示 |

## 使用示例

在 DSH 工作台调用 `read_dwg` 工具：

```json
{
  "file_path": "E:\\2026 工程资料\\16 天喔蜜饯工厂\\03 CAD DESIGN\\02 HVAC DESIGN PLAN.dwg",
  "entities": true,
  "entity_limit": 50,
  "export_svg": true,
  "svg_output_path": "F:\\HAYNESS 工作区1\\hvac-plan.svg"
}
```

返回示例：

```json
{
  "file_path": "E:\\...\\02 HVAC DESIGN PLAN.dwg",
  "file_size": 123456,
  "version": { "type": "r2018", "hdr": "AC1032", "description": "AutoCAD Release 2018", "version": 33 },
  "codepage": 39,
  "codepageName": "CP_ANSI_936",
  "layer_count": 126,
  "entity_count": 1514,
  "unknown_entity_count": 0,
  "extents": { "min": { "x": 0, "y": 0, "z": 0 }, "max": { "x": 266000, "y": 286000, "z": 0 } },
  "layers": [ { "name": "HEPA BOX", "colorIndex": 5, ... }, ... ],
  "entities": [
    { "type": "INSERT", "handle": "...", "layer": "HEPA BOX", "blockName": "...", ... },
    ...
  ],
  "svg_path": "F:\\HAYNESS 工作区1\\hvac-plan.svg"
}
```

## 测试实例

已对真实工程图纸进行验证：

- **天喔蜜饯工厂暖通图纸**（r2018/AC1032）：1514 个实体，126 个图层，其中高效送风口（HEPA BOX 图层）108 个，方形散流器 18 个，射流空调 5 个。
- **植本清源空调设备图**（r2007/AC1021）：1762 个实体，14 个图层。
- **无效/损坏文件**：返回明确错误，不崩溃。

## 文件结构

```
dwg-reader-plugin/
├── lib/index.js          # 插件入口，注册 read_dwg 工具
├── cordis.patch.yml      # DSH bundle 插件清单
├── package.json          # npm 包清单
├── LICENSE               # GPL-3.0-only
├── README.md             # 本文件
├── icon.svg              # 插件图标
├── locale/en.json        # 英文元数据
├── locale/zh.json        # 中文元数据
└── vendor/libredwg-web/  # libredwg-web 0.8.2 WASM 库（已 vendored）
    ├── lib/              # JS 封装层
    └── wasm/             # libredwg-web.wasm（WebAssembly 解析核心）
```

## 许可

GPL-3.0-only。依赖 libredwg-web 同样为 GPL，公开分发请保留 LICENSE 并提供对应源码。

## 安装路径

- npm 公开包：`@bill_nee/dwg-reader@1.1.0`
- 安装命令：`dsh plugin --profile desktop add @bill_nee/dwg-reader@1.1.0`
- GitHub 源码：https://github.com/NIDEXIANG/dwg-reader-plugin-20261029
