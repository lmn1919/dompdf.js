# 整合 examples/index.html 与 examples/comparison.html 计划

## Summary
将 `examples/index.html`（单页回归对比页）与 `examples/comparison.html`（多模板 Benchmark 仪表盘）合并为一个统一的示例入口 `examples/index.html`，保留 `__DOMPDF_AUTOMATION__` 自动化桥以兼容 `scripts/pdf-diff/` 测试体系，并在新页面中提供跳转到 `examples/markdown-editor.html` 的链接。`examples/markdown-editor.html` 保持独立。

## Current State Analysis

### 已有文件职责

| 文件 | 行数 | 核心能力 | 是否必须保留 |
|---|---|---|---|
| `examples/index.html` | ~2064 | 单页 A4 测试内容（图片/表格/渐变/透明度/分页/中文/数学符号）、dompdf.js vs html2pdf.js 对比、分页线叠加、Inspect、**`__DOMPDF_AUTOMATION__` 自动化桥** | ✅ 必须保留，且自动化桥不可破坏 |
| `examples/comparison.html` | ~2605 | 三套模板切换（报告/长文/发票）、仪表盘式速度/体积对比、代码示例展示、PDF.js 空白检测 | 功能合并到 `index.html` 后可废弃 |
| `examples/markdown-editor.html` | ~1920 | Markdown 编辑器 + A4 实时预览 + 主题/水印/加密 | 保持独立，仅增加入口链接 |

### 重复与冗余
- 两者都加载 `dist/dompdf.js` 和 html2pdf.js CDN。
- 两者都测量并对比 dompdf.js 与 html2pdf.js 的耗时和文件大小。
- 两者都包含 A4 页面样本，但 `comparison.html` 的模板更丰富、UI 更现代。
- `index.html` 的 `#document` 内容被 `pdf-diff` 作为默认回归语料使用。

### 关键约束
- `scripts/pdf-diff/corpus.mjs` 默认使用 `http://127.0.0.1:${port}/examples/index.html` + `#document` 作为测试语料。
- `index.html` 暴露的 `__DOMPDF_AUTOMATION__` 接口包含 `ready/getMeta/inspect/exportPdf`，被 `scripts/pdf-diff/lib/oracle.mjs` 调用。
- 因此新 `index.html` 必须：
  1. 保留 `#document` 元素作为默认导出根。
  2. 继续暴露同名的 `__DOMPDF_AUTOMATION__` 全局对象，行为不变。

## Proposed Changes

### 1. 重写 `examples/index.html`（主入口）

#### 1.1 整体结构
采用 `comparison.html` 的仪表盘布局，但将原来的三套模板内嵌到 `#document` 容器内，通过模板切换按钮显示/隐藏：

```
body
├── header.toolbar
│   ├── title + subtitle
│   ├── actions:
│   │   ├── 模板切换下拉框（综合测试 / 英文报告 / 纯文本长文 / 中英发票）
│   │   ├── 导出 dompdf.js
│   │   ├── 导出 html2pdf.js
│   │   ├── 一键对比
│   │   ├── 查看结构
│   │   ├── 分页线
│   │   └── Markdown 编辑器入口（新窗口打开 markdown-editor.html）
│   └── status
├── main
│   ├── section.compare-shell   # 仪表盘：速度/体积/属性对比
│   └── article#document.doc    # A4 页面根，pdf-diff 默认选择器
│       ├── template-default    # 原 index.html 的综合测试页
│       ├── template-report     # 来自 comparison.html
│       ├── template-text       # 来自 comparison.html（含动态追加控件）
│       └── template-invoice    # 来自 comparison.html
```

#### 1.2 保留原 `index.html` 自动化桥
将原 `index.html` 中的 `__DOMPDF_AUTOMATION__` 实现整体迁移到新文件中，逻辑保持不变：
- `ready()` 返回字体加载完成后的 Promise。
- `getMeta(override)` 返回 selector/rootWidthPx/rootHeightPx/devicePixelRatio/pageBreaks/options。
- `inspect(override)` 调用 `api.inspect(doc, options)`。
- `exportPdf(override)` 调用 `api(doc, options)` 并返回 base64。

关键代码块直接复用，仅做以下适配：
- `currentOptions()` 需要感知当前激活模板：不同模板使用不同 `fontConfig`/`pageConfig`/`backgroundColor`。例如发票模板必须加载思源黑体并注入字体。
- 默认导出对象仍为 `document.getElementById('document')`，其内部显示的是当前激活模板。

#### 1.3 吸收 `comparison.html` 能力
- **模板切换逻辑**：`switchTemplate(type)` 显示对应模板，隐藏其他模板，重置对比指标。
- **动态追加控件**：仅在 `template-text` 激活时显示“批量追加文本”面板。
- **速度/体积仪表盘**：保留 `dashboard-grid` 及 `calculateDeltas` 计算逻辑。
- **引擎属性对比表**：保留 `panel-specs` 中的特性表格。
- **代码示例标签页**：保留 `panel-code` 中的 dompdf.js / html2pdf.js 调用示例。
- **PDF.js 空白页检测**：保留 `detectBlankPdf`，用于 html2pdf.js 输出异常时提示。

#### 1.4 新增 Markdown 编辑器入口
在 toolbar actions 右侧增加：

```html
<a href="./markdown-editor.html" target="_blank" class="btn-link">Markdown 编辑器 →</a>
```

### 2. 处理 `examples/comparison.html`

为避免外链或书签失效，将其改为**重定向页**：

```html
<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="refresh" content="0; url=./index.html">
    <title>Redirecting...</title>
  </head>
  <body>
    <p>示例已合并至 <a href="./index.html">index.html</a>。</p>
  </body>
</html>
```

这样保留文件名，但不再维护两份独立代码。

### 3. 不改动 `examples/markdown-editor.html`

仅在新 `index.html` 中增加一个跳转到它的链接。不修改其内部逻辑、样式或依赖。

### 4. 验证 pdf-diff 兼容性（不修改源码，仅验证）

运行 `npm run pdf-diff:run` 确认：
- `actual.pdf` 正常生成。
- `oracle.json` / `inspect.txt` 正常生成。
- `report.json` 中无异常失败。

## Assumptions & Decisions

1. **默认模板选择**：新 `index.html` 默认显示原 `index.html` 的综合测试页（`template-default`），这样 `#document` 的初始内容与当前 `pdf-diff` 默认语料视觉一致，降低回归风险。
2. **自动化桥不变**：`__DOMPDF_AUTOMATION__` 的 API 签名、返回值结构、字体加载时机完全复用现有实现。
3. **comparison.html 重定向**：不直接删除文件，而是改成重定向，避免破坏仓库历史或外部引用。
4. **CDN 依赖保留**：html2pdf.js、pdf.js 仍通过 CDN 加载；思源黑体仍为本地文件。
5. **样式统一**：新页面整体采用 `comparison.html` 的现代仪表盘配色，但 `#document` 内部保留原 `index.html` 的暖色调 A4 纸张风格（因为 pdf-diff 视觉对比对该页面已建立基线）。

## Verification Steps

1. 构建项目：
   ```bash
   npm run build
   ```
2. 启动本地服务并打开新 `examples/index.html`：
   ```bash
   npm run serve
   # 访问 http://127.0.0.1:8080/examples/index.html
   ```
3. 验证默认模板：
   - 页面加载后默认显示“综合测试”模板。
   - 点击“导出 dompdf.js”可下载 PDF。
   - 点击“导出 html2pdf.js”可下载 PDF。
   - 点击“开始对比”显示速度与体积对比。
   - 点击“查看结构”在控制台输出 inspect 摘要。
   - 点击“分页线”在 `#document` 上绘制分页虚线。
4. 验证模板切换：
   - 切换到“英文报告”“纯文本长文”“中英发票”模板。
   - 每个模板下都能正常导出 dompdf.js 和 html2pdf.js。
   - 纯文本模板下显示批量追加文本控件，追加后重新导出分页正确。
5. 验证 Markdown 入口：
   - 点击 toolbar 中的“Markdown 编辑器 →”，新标签页打开 `examples/markdown-editor.html`。
6. 验证重定向：
   - 访问 `http://127.0.0.1:8080/examples/comparison.html`，应自动跳转到 `index.html`。
7. 验证 pdf-diff 自动化桥：
   ```bash
   npm run pdf-diff:run
   ```
   - 命令成功退出。
   - `tmp/pdf-diff/<ts>/examples-document/report.json` 中 `summary.status` 不为 `error`。
   - 检查 `oracle.json` 中 `selector` 仍为 `#document`。
