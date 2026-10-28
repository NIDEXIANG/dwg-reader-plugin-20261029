# @bill_nee/dwg-reader

DSH (DeepSeek Harness) 插件：可直接读取 AutoCAD DWG 格式图纸，无需安装 AutoCAD。

基于 [libredwg-web](https://github.com/mlightcad/libredwg-web) 0.8.2 WASM 编译，在浏览器/Node 环境中解析 DWG 文件，返回图层、实体、版本、编码、图幅等信息，并可导出 SVG 预览。

## 安装

```powershell
dsh plugin --profile desktop add @bill_nee/dwg-reader@1.1.0
```

安装后在 DSH 工作台插件管理中启用插件，即可使用 `read_dwg` 工具读取 DWG 图纸。

## 主要能力

- 读取 DWG（AutoCAD R14~R2018 等常见版本）
- 返回图层列表、实体类型与数量、图纸版本（ACADVER）、代码页、图幅
- 导出 SVG 预览到指定路径
- 对无效/损坏文件给出明确错误

## 许可

GPL-3.0-only。依赖 libredwg-web 同样为 GPL，公开分发请保留 LICENSE 并提供对应源码。
