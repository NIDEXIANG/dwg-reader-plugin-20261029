# @bill_nee/dwg-reader

DSH（DeepSeek Harness）插件：直接读取 DWG/DXF 图纸、PDF 与图片/截屏，无需安装 AutoCAD、Tesseract 等外部软件。

基于 [libredwg-web](https://github.com/mlightcad/libredwg-web) 0.8.2 WASM 解析 DWG；DXF 经 Python ezdxf 桥接；PDF 用 pdf-parse；图片 OCR 使用内置 **tesseract.js（WASM）**，语言包可指向本地 tessdata，也可按需联网下载，支持 Tesseract 全量语言（100+ 种）。

## 安装

在 DSH 工作台或终端执行：

```powershell
dsh plugin --profile desktop add @bill_nee/dwg-reader@1.5.2
```

安装后在 DSH 工作台插件管理中启用插件，即可使用 `read_dwg`、`read_dxf`、`read_pdf`、`ocr_image` 四个工具（`read_image` 为 DSH 内置看图工具，本插件用 `ocr_image` 与其并存，避免同名冲突）。

## 工具与参数

| 工具 | 说明 |
|------|------|
| `read_dwg` | 解析 DWG：版本/代码页/图层/块/实体统计与明细，可导出 SVG 预览 |
| `read_dxf` | 解析 DXF（ezdxf 桥接）：版本、图层、块、实体统计与明细（**需本机已安装 Python 与 ezdxf**） |
| `read_pdf` | 解析 PDF：页数、元数据、可选全文文本 |
| `ocr_image` | 图片/截屏 OCR：格式、像素尺寸、颜色模式 + 识别文字（PNG/JPEG/WebP/BMP/GIF/TIFF） |

`ocr_image` 关键参数：

```json
{
  "file_path": "F:\\HAYNESS 工作区1\\测试用资源\\截屏.png",
  "ocr": true,
  "lang": "chi_sim+eng",
  "tessdata_prefix": "D:\\Tools\\Tesseract-OCR\\tessdata"
}
```

- `lang`：Tesseract 语言码，`+` 或逗号连接，默认 `chi_sim+eng`；如 `eng`、`chi_tra`、`jpn`、`kor`、`deu`、`fra`、`rus`、`spa`、`ara`、`vie`、`tha` 等。
- `tessdata_prefix`：本地 traineddata 目录。提供后只读本地语言包、不联网；目录缺包会报错并列出缺项。
- 未提供 `tessdata_prefix` 时，依次探测 `TESSDATA_PREFIX` 环境变量、`D:\Tools\Tesseract-OCR\tessdata`、`C:\Program Files\Tesseract-OCR\tessdata`、`/usr/share/tesseract-ocr/4.00/tessdata` 等常见目录；均未命中才联网下载并缓存到系统临时目录。

## 主要能力

| 能力 | 说明 |
|------|------|
| 读取 DWG | 支持 AutoCAD R14~R2018 等常见版本（AC1015~AC1032） |
| 图层信息 | 返回所有图层名称、颜色、冻结/关闭/锁定状态 |
| 实体统计 | 返回实体总数及按类型（LINE/TEXT/INSERT/HATCH/DIMENSION 等）分类统计 |
| INSERT 明细 | 返回块名、插入点、旋转、缩放及块属性（tag/text/value） |
| 图纸版本 | 返回 ACADVER、版本号、版本描述（如 r2007/AC1021） |
| 图幅信息 | 返回 EXTMIN/EXTMAX 边界框 |
| 导出 SVG | 可将 DWG 内容导出为 SVG 预览文件到指定路径 |
| 内置 OCR | tesseract.js WASM，无需安装 Tesseract 可执行文件；多语言、可离线 |
| 错误处理 | 对无效/损坏/非目标格式文件给出明确错误提示 |

## 前置依赖（重要）

- **DWG / PDF / 图片 OCR**：纯 JavaScript + WASM，无需安装 AutoCAD 或 Tesseract，直接可用。
- **DXF**：基于 Python ezdxf 桥接，**需本机已安装 Python 3 与 `ezdxf` 包**。Python 解释器优先读环境变量 `DXF_PYTHON_EXE`，其次 `DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe`，再次回退系统 `python`。缺少 `ezdxf` 时会给明确报错，请先 `pip install ezdxf`。

## 使用示例

```json
{
  "file_path": "E:\\2026 工程资料\\16 天喔蜜饯工厂\\03 CAD DESIGN\\02 HVAC DESIGN PLAN.dwg",
  "entities": true,
  "entity_limit": 50,
  "export_svg": true,
  "svg_output_path": "F:\\HAYNESS 工作区1\\hvac-plan.svg"
}
```

## 测试实例

- **天喔蜜饯工厂暖通图纸**（r2018/AC1032）：1514 个实体、126 个图层。
- **植本清源空调设备图**（r2007/AC1021）：1762 个实体、14 个图层。
- **截屏 OCR**：本地 tessdata（chi_sim+eng）约 4 秒识别 4500+ 字符；`ocr=false` 仅解析尺寸不识别。
- **无效/损坏文件**：返回明确错误，不崩溃。

## 文件结构

```
dwg-reader-plugin/
├── lib/index.js          # 插件入口，注册 read_dwg / read_dxf / read_pdf / ocr_image
├── scripts/read_dxf.py   # DXF 解析桥接（ezdxf）
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

GPL-3.0-only。依赖 libredwg-web 为 GPL，tesseract.js 为 Apache-2.0；公开分发请保留 LICENSE 并提供对应源码。

## 安装路径

- npm 公开包：`@bill_nee/dwg-reader@1.5.2`
- 安装命令：`dsh plugin --profile desktop add @bill_nee/dwg-reader@1.5.2`
- GitHub 源码：https://github.com/NIDEXIANG/dwg-reader-plugin-20261029
