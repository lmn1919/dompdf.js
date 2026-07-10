# 旧版 API 迁移说明

项目已经从旧版的 `html2canvas + jsPDF` 流水线迁移到新的
`DOM 快照 + Worker + WASM` 流水线。为了尽量降低升级成本，当前分支正在逐步把
`dompdf.js` 的公开 API 与旧版对齐。

这份文档用于说明当前兼容状态。

## 已对齐

以下 API 在当前分支里已经可用，并且具备实际行为：

- `dompdf(root, options) -> Promise<Blob>`
- `fontConfig`
- `iconFont`
- `langFontConfig`
- `encryption`
- `pagination`
- `pageConfig` 对象形式
- `pageConfig(pageNum, totalPages)` 函数形式
- 对象形式 `pageConfig` 下的 `excludePage` / `excludePages`
- `pageBreak` 属性
- `divisionDisable` 属性
- `backgroundColor`
- `compress`
- `putOnlyUsedFonts`

## 兼容签名，但会给出 warning

以下参数现在会被接受，这样旧代码在调用时不会直接报错；但当前引擎还没有提供旧版等价行为，运行时会输出 warning：

- `onJspdfReady`
- `onJspdfFinish`
- `foreignObjectRendering`
- `allowTaint`
- `proxy`
- `imageTimeout`
- `logging`
- `cache`
- `windowWidth`
- `windowHeight`
- `scrollX`
- `scrollY`
- `x`
- `y`
- `width`
- `height`
- `scale`
- `canvas`
- `removeContainer`
- `onclone`
- `pdfFileName`
- `floatPrecision`
- `orientation`

## 需要迁移的用法

以下用法和旧版 `jsPDF/html2canvas` 架构耦合较深，升级到当前引擎后仍建议显式迁移：

- 在 `onJspdfReady` 里直接操作 live `jsPDF` 实例
- 在 `onJspdfFinish` 里做最终 PDF 修改
- 依赖 html2canvas clone 阶段的自定义逻辑
- 依赖旧版栅格化流程的 proxy 或 canvas 定制链路

## 建议升级路径

1. 先升级版本，保留现有旧参数。
2. 观察运行时 warning，确认哪些参数目前只是兼容签名。
3. 将旧版依赖 `jsPDF` 的定制逻辑逐步迁移到当前的导出前后处理流程。
4. 多语言文本优先使用 `fontConfig` / `langFontConfig`，常见页眉页脚场景优先使用对象形式 `pageConfig`。

## 备注

- 当前引擎输出的是以矢量文本为主的 PDF，而不是旧版基于 canvas 的图片式 PDF。
- 一些旧参数目前保留只是为了避免升级时直接中断。
- 后续每次兼容状态变化，都应同步更新这份文档。
