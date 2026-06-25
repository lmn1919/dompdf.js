# dompdf.js PDF 对比-自动修复系统 · 设计与使用说明

> 一套面向 dompdf.js 引擎的**视觉/结构回归 + 根因定位 + 半自动修复**系统。
> 给定 URL + CSS 选择器，先用无头浏览器生成参照，再用本库导出 PDF，做结构化对比，
> 把差异分类并定位到具体的 Rust/WASM 核心方法，输出修复建议，并提供 LLM agent 接口。

---

## 目录

1. [系统定位与目标](#1-系统定位与目标)
2. [整体架构](#2-整体架构)
3. [分层设计（Tier 0–4）](#3-分层设计tier-04)
4. [目录与文件职责](#4-目录与文件职责)
5. [关键数据流](#5-关键数据流)
6. [参照系设计（为什么这样选 oracle）](#6-参照系设计为什么这样选-oracle)
7. [根因分类表](#7-根因分类表)
8. [LLM Agent 接口](#8-llm-agent-接口)
9. [安装与前置条件](#9-安装与前置条件)
10. [使用说明](#10-使用说明)
11. [输出产物说明](#11-输出产物说明)
12. [配置到 AI 编程工具](#12-配置到-ai-编程工具)
13. [典型工作流](#13-典型工作流)
14. [设计取舍与已知限制](#14-设计取舍与已知限制)
15. [扩展点](#15-扩展点)

---

## 1. 系统定位与目标

### 要解决的问题

`pdf-diff-mvp.mjs`（仓库原有的 MVP）只能给出一个像素差异百分比，回答不了：

- **差在哪里**（哪段文字、哪个元素、哪个坐标）？
- **为什么差**（是字体测量、分页、颜色、还是变换）？
- **该改哪个核心方法**（Rust/WASM 引擎里哪个函数）？

### 本系统的目标

| 目标 | 手段 |
|---|---|
| 可定位的差异 | 用结构化文本对比（文本项坐标/字号/行宽）替代纯像素 diff |
| 可归因的根因 | 把差异模式映射到引擎核心方法（Tier 3 分类表） |
| 可迭代的修复 | 半自动闭环：跑 → 定位 → 改源码 → 重建 → 比对 accept/regress |
| 可被 AI 工具调用 | JSON CLI + MCP server 双接口 |

### 不做的事

- **不自动改源码**（按设计选择为半自动：只定位 + 建议，由人确认后再改）。
- **不追求像素级零差异**——抗锯齿/子像素本就有噪声，像素 diff 只作回归闸门。
- **不动 `pdf-diff-mvp.mjs`** 与现有引擎源码；系统自包含在 `scripts/pdf-diff/`。

---

## 2. 整体架构

```
                    ┌─────────────────────────────────────────┐
                    │              语料 (corpus.mjs)            │
                    │   [{ name, url, selector, removeSelectors }]│
                    └────────────────────┬────────────────────┘
                                         │
            ┌────────────────────────────▼────────────────────────────┐
            │                    Tier 0  参照对 (oracle.mjs)            │
            │  无头浏览器打开 url → 注入 dist/dompdf.js + 自动化桥          │
            │  ┌──────────────┐ ┌──────────────┐ ┌───────────────────┐  │
            │  │ actual.pdf   │ │ ref.pdf      │ │ oracle.json       │  │
            │  │ (dompdf导出)  │ │ (Chromium打印)│ │ (Range文本盒真值)  │  │
            │  └──────────────┘ └──────────────┘ └───────────────────┘  │
            │  + inspect.txt (dompdf 内部布局树) + html-source.png        │
            └───────┬──────────────────┬───────────────────┬───────────┘
                    │                  │                   │
            ┌───────▼───────┐  ┌───────▼───────┐   ┌───────▼────────┐
            │ Tier 1 像素diff │  │ Tier 2 文本diff │   │  (交叉验证)     │
            │ rasterize +    │  │ pdfjs           │   │  inspect 树     │
            │ pixelmatch     │  │ getTextContent  │   │                │
            │ (回归闸门)      │  │ ↔ Range oracle  │   │                │
            └───────┬───────┘  └───────┬───────┘   └───────┬────────┘
                    │                  │                   │
                    └──────────────────▼───────────────────┘
                            ┌────────────────────┐
                            │  Tier 3 根因分类     │
                            │  classify.mjs        │
                            │  → categories[]      │
                            │  → 疑似核心方法        │
                            └─────────┬──────────┘
                                      │
                      ┌───────────────▼────────────────┐
                      │       Tier 4 修复闭环            │
                      │  fix-loop.mjs / baseline.mjs     │
                      │  → fix-suggestions.{md,json}     │
                      │  → --watch: 重建→重跑→accept/regress│
                      └───────────────┬────────────────┘
                                      │
                      ┌───────────────▼────────────────┐
                      │     LLM Agent 接口               │
                      │  agent.mjs (JSON CLI)            │
                      │  mcp-server.mjs (MCP stdio)      │
                      │  共用 lib/agent-core.mjs          │
                      └────────────────────────────────┘
```

---

## 3. 分层设计（Tier 0–4）

### Tier 0 — 参照对（`lib/oracle.mjs`）

为每个语料条目产出**四份共享同一字体的参照物**，保证可比：

| 产物 | 来源 | 用途 |
|---|---|---|
| `actual.pdf` | `__DOMPDF_AUTOMATION__.exportPdf({pagination:false})` | 被测对象（dompdf 引擎输出） |
| `ref.pdf` | Chromium `page.pdf()` 打印同节点 | 备用参照（headless 浏览器 PDF） |
| `oracle.json` | `Range.getClientRects()` 逐词文本盒 | **Tier 2 主真值**（浏览器自身布局） |
| `inspect.txt` | `__DOMPDF_AUTOMATION__.inspect()` | dompdf 内部布局树，交叉验证 |
| `html-source.png` | 目标节点分块截图拼接 | Tier 1 像素参照 |

**关键设计**：三者共用注入的 CJK 字体（SourceHanSansSC），经 `normalizeTargetFonts` 统一，避免字体差异成为噪声。导出用 `pagination:false`（单页长卷），便于文本对齐。

> **为什么不用 Chromium 的 PDF 做主 oracle？** Chromium 打印自带分页/缩放，会引入与 dompdf 无关的干扰。对**布局引擎**正确性，浏览器里 Range API 给出的文本盒位置才是最干净的真值。

### Tier 1 — 像素粗指标（`lib/rasterize.mjs` + `lib/pixeldiff.mjs`）

- `rasterizePdf`：pdfjs 把 PDF 栅格化为每页 PNG。
- `pixelDiffPages`：按页裁剪到内容区 + `pixelmatch`，输出 `mismatchRatio` + diff PNG。
- **定位**：仅作**回归闸门**，不作定位信号。即使输出正确，抗锯齿/子像素也会产生像素差，单看数字会误判。

### Tier 2 — 结构化文本对比（`lib/textdiff.mjs`）⭐ 核心

这是让"修复"变得可定位的关键层。

- `extractPdfTextItems`：pdfjs `getTextContent()` → `{ str, x, y, w, h, fontSize, fontName, page }`。
- `buildOracleSequence`：把逐词 Range 盒**按行归并**（同 baseline y ±3px 合为一行），使粒度与 dompdf 的行级文本项匹配。
- `alignTexts`：行级 LCS 对齐（按规范化字符串：去空白、小写）。
- `computeDeltas`：逐对算 `Δx / Δy / ΔfontSize / Δwidth`，超阈值记为 discrepancy。

**坐标转换要点**：dompdf 自上而下布局，文本坐标是 **top-origin**（不是 PDF 默认 bottom-origin）；actual 项需转回 target-root CSS-px 空间并减去内容区上偏移（margin + header）。

### Tier 3 — 根因分类（`lib/classify.mjs`）

把 Tier 2 的 discrepancies（+ Tier 1 像素差 + inspect 树）聚合成类别，每类映射到疑似核心方法。详见 [§7 根因分类表](#7-根因分类表)。

### Tier 4 — 修复闭环（`fix-loop.mjs` + `baseline.mjs`）

**半自动**（不改源码）：

1. 跑全流程 → 汇总 report；
2. `emitSuggestions`：按 severity 排序类别 → 写 `fix-suggestions.{md,json}`（类别 + 证据样本 + 疑似 `file:fn` + 改法 + 验证方法）；
3. `--watch`：监听 `wasm/src`、`src` 变化 → `npm run build` → 重跑 → 与上一轮比各类别计数，打印 **accept / regress / no-change**，历史落 `tmp/pdf-diff-runs/last.json`；
4. `baseline.mjs`：`--save` 建基线，`--check` 回归闸门（任一语料 mismatch/discrepancy 上升则非 0 退出，可入 CI）。

---

## 4. 目录与文件职责

```
scripts/pdf-diff/
├── corpus.mjs            语料配置（默认本地 examples #document）+ CLI 参数解析
├── run.mjs               单语料 Tier 0–3 全流程 → report.json（含 runEntry 可复用）
├── run-all.mjs           遍历语料 → aggregate-report.json
├── baseline.mjs          回归基线：--save / --check（CI 闸门）
├── fix-loop.mjs          Tier 4 编排：建议 + --watch 迭代
├── agent.mjs             LLM agent · JSON CLI 入口
├── mcp-server.mjs        LLM agent · MCP stdio server（手写 JSON-RPC，零依赖）
├── baseline.json         （运行时生成）回归基线快照
├── README.md             简要用法
└── lib/
    ├── fs-util.mjs       ensureDir/writeJson/base64/withTimeout
    ├── layout.mjs        页面尺寸/边距/缩放/布局度量（PX_TO_PT 等）
    ├── server.mjs        本地静态服务器 + rootDir
    ├── browser.mjs       chromium 启动 + 默认 CJK 字体配置
    ├── bridge.mjs        自动化桥注入 + 字体统一 + 节点截图（抽自 mvp）
    ├── oracle.mjs        ★ Tier 0：收集四份参照物
    ├── rasterize.mjs     Tier 1：pdfjs 栅格化 + getTextContent 抽取
    ├── pixeldiff.mjs     Tier 1：pixelmatch + 裁剪对齐
    ├── textdiff.mjs      ★ Tier 2：行级对齐 + Δ 计算
    ├── classify.mjs      ★ Tier 3：差异模式 → 类别 → 核心方法
    ├── report.mjs        组装单语料 report + 汇总 aggregate
    └── agent-core.mjs    ★ 5 个工具实现 + dispatchTool（CLI/MCP 共用）
```

带 ★ 的是系统的核心逻辑文件。

---

## 5. 关键数据流

以单语料一次运行为例（`run.mjs` → `runEntry`）：

```
corpus entry ──► launchBrowser + ensureServerForUrl
   │
   ▼
collectOracle (Tier 0)
   ├─ ensureAutomationBridge     注入 dist + 桥
   ├─ normalizeTargetFonts       统一 CJK 字体
   ├─ __DOMPDF_AUTOMATION__.exportPdf()  → actual.pdf
   ├─ page.evaluate(Range 遍历)          → oracle.json
   ├─ page.pdf()                         → ref.pdf
   ├─ __DOMPDF_AUTOMATION__.inspect()    → inspect.txt
   └─ captureLocatorScreenshot           → html-source.png
   │
   ▼  computeLayoutMetrics(meta)
   │
rasterizePdf(actual.pdf) ──► pixelDiffPages ──► Tier 1 (pixelDiff)
extractPdfTextItems(actual.pdf) ─┐
                                  ├─► diffTexts ──► Tier 2 (textDiff)
oracle.json ────────────────────┘
   │
   ▼
classify({textDiff, pixelDiff, inspectText, meta}) ──► Tier 3 (categories)
   │
   ▼
buildReport + writeReport ──► report.json
```

`run-all` 在外层循环 + 汇总；`fix-loop` 在最外层加 build/watch/建议/比对。

---

## 6. 参照系设计（为什么这样选 oracle）

| 候选 oracle | 优点 | 缺点 | 本系统取舍 |
|---|---|---|---|
| Chromium 打印 PDF | 真实浏览器输出 | 自带分页/缩放，引入无关噪声 | 仅作 `ref.pdf` 备用 |
| 节点截图 (html-source.png) | 直观 | 只能像素 diff，不可定位 | Tier 1 像素参照 |
| **Range.getClientRects() 文本盒** | **浏览器自身布局真值，无打印干扰，可逐词定位** | 需遍历+归并 | **Tier 2 主 oracle** ✅ |
| dompdf inspect() 树 | 引擎内部意图布局 | 是被测对象自己的视图，不能当真值 | 交叉验证用 |

**粒度匹配**：oracle 原本是逐词（1133 项），dompdf 输出是行级（36 项）——直接 LCS 只对上 5 个。因此 `buildOracleSequence` 把同 baseline y 的词归并成行（216 行），并额外保留行宽（`width = 末词右沿 − 首词左沿`），让行内 advance-width 漂移仍可通过 `Δwidth` 检测。

---

## 7. 根因分类表

`classify.mjs` 把差异聚合成下表类别，每类指向疑似 Rust/WASM 核心方法：

| 类别 | 触发模式 | 疑似核心方法 |
|---|---|---|
| `text-x-drift` | 行宽 `Δwidth` 偏差（advance-width 测量漂移） | `wasm/src/font.rs::text_width_units` / `ttf.rs` hmtx |
| `text-y-drift` | `Δy` 跨行累积 | `wasm/src/paginate.rs::paginate` |
| `page-break` | `Δy` 在分页处跳变（离群点） | `wasm/src/paginate.rs::assign_pages` |
| `font-size` | `ΔfontSize` 恒比/恒定 | `src/snapshot.ts` PX_TO_PT / `font.rs` 缩放 |
| `font-family` | 嵌入字体与页面不符 | `wasm/src/font.rs` 字体选择 / CID 嵌入 |
| `font-encoding` | **文本可见但不可提取**（大量 oracle 无匹配 + 低像素差） | `font.rs::encode_winansi / ToUnicode` / `ttf.rs` cmap |
| `color` | 像素差高但文本位置对齐 | `src/snapshot.ts` 颜色解析 / `paginate.rs` alpha |
| `image` | 含图且像素差高 | `wasm/src/snapshot.rs::Image` / `paginate.rs` 渲染 / CORS |
| `transform` | 整子树恒定 `Δx/Δy` | `wasm/src/paginate.rs` 变换矩阵 / `snapshot.ts` transform |
| `wrap` | 大量未匹配（换行差异） | `wasm/src/paginate.rs` 断行 / `font.rs` 测量 |

> `font-encoding` 是本系统的一个关键发现类：内容画出来了（像素差低）却不在 PDF 文本流里（pdfjs 提取不到），说明缺可用 ToUnicode/编码——这种 bug 纯像素 diff 完全发现不了。

每个类别输出：`{ category, count, severity, suspected:{file,fn,also}, hint, evidence, samples[] }`。

---

## 8. LLM Agent 接口

两种等价接口，共用 `lib/agent-core.mjs`，暴露 **5 个工具**：

| 工具 | 作用 | 输入 | 返回 |
|---|---|---|---|
| `pdf_diff_run` | 单语料 Tier 0–3 | `{url, selector, removeSelectors, skipInspect, threshold, pageLimit}` | report + summary + categories |
| `pdf_diff_all` | 语料库汇总 | `{url, selector}` | aggregate + outRoot |
| `pdf_diff_suggest` | Tier 4 建议 | `{url, selector, rebuild}` | suggestions[] + aggregate + 文件路径 |
| `pdf_diff_categories` | 从已有 report 读分类 | `{reportPath}` | categories[] + summary |
| `pdf_diff_capabilities` | 自描述工具清单 | `{}` | 工具列表 + schema |

### JSON CLI（`agent.mjs`）

任何能跑 shell 的 AI 工具都能用。stdout 永远是单个 JSON 对象，进度走 stderr（可 `2>/dev/null` 屏蔽），出错返回 `{error, message}` 且退出码 1。

### MCP server（`mcp-server.mjs`）

手写 JSON-RPC 2.0 over stdio，**零新依赖**。实现 `initialize` / `ping` / `tools/list` / `tools/call`。Claude Code / Cursor / Trae / Cline 等可当原生工具调用。

> **stdout 纯净性**：`runAll` 的 `console.log` 进度会污染 JSON-RPC 流，`agent-core` 用 `withStderrLogsAsync` 在工具调用期间把 `console.log` 重定向到 stderr——这是 CLI/MCP 都能干净输出的关键。

---

## 9. 安装与前置条件

```bash
# 1. 安装依赖（仓库已配置）
npm install

# 2. 安装无头浏览器（首次）
npm run playwright:install

# 3. 构建 dist（pdf-diff:* 脚本会自动先 build，也可手动）
npm run build
```

**环境要求**：Node.js（建议 ≥ 18）、可联网下载 chromium（首次）。本机 node 在 `C:\Program Files\nodejs`。

---

## 10. 使用说明

### 命令速查

```bash
# 单语料全流程（默认本地 examples/index.html #document）
npm run pdf-diff:run
# 自定义语料
node scripts/pdf-diff/run.mjs --url <url> --selector <css>

# 语料库汇总
npm run pdf-diff:all

# 回归基线（CI 闸门）
node scripts/pdf-diff/baseline.mjs --save   <aggregate-report.json>
node scripts/pdf-diff/baseline.mjs --check  <aggregate-report.json>   # 回归则退出码 1

# Tier 4 半自动修复闭环
node scripts/pdf-diff/fix-loop.mjs                 # 跑一次，输出建议
node scripts/pdf-diff/fix-loop.mjs --rebuild       # 先 npm run build 再跑
node scripts/pdf-diff/fix-loop.mjs --watch         # 监听源码变化，自动重建→重跑→对比

# LLM agent
npm run pdf-diff:agent -- capabilities
npm run pdf-diff:agent -- suggest --url <u> --selector <s> --rebuild
```

### CLI 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--url` | 本地 examples | 页面 URL |
| `--selector` / `--css-selector` | `#document` | CSS 选择器 |
| `--remove` | 空 | 逗号分隔的待清理选择器 |
| `--out-dir` | `tmp/pdf-diff/<ts>` | 输出目录 |
| `--port` | 4173 | 本地静态服务端口 |
| `--threshold` | 0.1 | pixelmatch 阈值 |
| `--page-limit` | 0（全部） | 限制对比页数 |
| `--skip-inspect` | false | 跳过 inspect 阶段（加速） |
| `--export-timeout-ms` | 120000 | 导出超时 |
| `--inspect-timeout-ms` | 20000 | inspect 超时 |
| `--rebuild` | false | （fix-loop/agent）先 build |
| `--watch` | false | （fix-loop）监听模式 |

### 语料配置

编辑 `scripts/pdf-diff/corpus.mjs` 的 `defaultCorpus`：

```js
export function defaultCorpus({ port = 4173 } = {}) {
  return [
    { name: 'examples-document', url: `http://127.0.0.1:${port}/examples/index.html`, selector: '#document', removeSelectors: [] },
    // 新增语料：
    // { name: 'my-page', url: 'https://example.com', selector: '#content' },
  ];
}
```

---

## 11. 输出产物说明

单次运行 `tmp/pdf-diff/<timestamp>/<name>/`：

| 文件 | 内容 |
|---|---|
| `actual.pdf` | dompdf 导出（被测） |
| `ref.pdf` | Chromium 打印（备用参照） |
| `html-source.png` | 节点截图（Tier 1 参照） |
| `oracle.json` | Range 文本盒真值（Tier 2） |
| `inspect.txt` | dompdf 内部布局树 |
| `pdf-page-*.png` | PDF 栅格化每页 |
| `expected/actual/diff-page-*.png` | 像素对比三件套 |
| **`report.json`** | **主报告**：tier1/tier2/tier3 + summary |

`report.json` 结构：

```jsonc
{
  "summary": { "status": "pass|needs-review", "aggregateMismatchRatio", "maxMismatchRatio",
               "discrepancyCount", "topCategories": [{category, severity, count, suspected}] },
  "tier1": { "pixelDiff": { comparedPages, aggregateMismatchRatio, pages[] } },
  "tier2": { "summary": { oracleItems, actualItems, aligned, unmatched*, meanD*, discrepancyCount },
             "discrepancies": [{text, oracle, actual, delta:{dx,dy,dFontSize,dWidth}}],
             "unmatched": { oracle[], actual[] } },
  "tier3": { "categories": [{category, count, severity, suspected, hint, evidence, samples[]}] },
  "output": { 实际文件绝对路径 }
}
```

汇总 `tmp/pdf-diff/<ts>/aggregate-report.json`：每条语料指标 + 跨语料 `categoryTotals`。

Tier 4 `tmp/pdf-diff-runs/`：`fix-suggestions.{md,json}` + `last.json`（上一轮快照，用于 accept/regress 比对）。

---

## 12. 配置到 AI 编程工具

### Claude Code（已配置）

仓库根 `.mcp.json` 已就绪，打开本项目自动发现。或手动：

```bash
claude mcp add pdf-diff node scripts/pdf-diff/mcp-server.mjs
```

### Trae（已配置）

写入 `C:\Users\lfc19\AppData\Roaming\Trae\User\mcp.json`：

```jsonc
"pdf-diff": {
  "command": "node",
  "args": ["C:\\Users\\lfc19\\Desktop\\test\\dompdf.js\\scripts\\pdf-diff\\mcp-server.mjs"]
}
```

> 用**绝对路径**：Trae 启动 MCP server 时 cwd 不一定是项目根，相对路径会找不到脚本。已验证从任意目录启动均正常。

### Cursor / Cline / 其他 MCP 客户端

同样在各自 MCP 配置里加：

```json
{
  "mcpServers": {
    "pdf-diff": { "command": "node", "args": ["<绝对路径>/scripts/pdf-diff/mcp-server.mjs"] }
  }
}
```

### 不支持 MCP 的 AI 工具

用 JSON CLI，让 AI 通过 shell 调：

```bash
node scripts/pdf-diff/agent.mjs suggest --url <u> --selector <s> --rebuild
```

> **生效条件**：MCP server 在 IDE 启动时加载，配置后需**重启 IDE / 重载窗口**才生效。

---

## 13. 典型工作流

### A. 人工排查一次差异

```bash
npm run pdf-diff:run                          # 跑单语料
# 看 report.json → summary.topCategories 指向根因
# 看 tier2.discrepancies 的 Δ 证据
# 看 diff-page-*.png 确认视觉
```

### B. 半自动修复迭代

```bash
node scripts/pdf-diff/baseline.mjs --save <agg.json>   # 建基线
node scripts/pdf-diff/fix-loop.mjs --watch             # 开监听
# 在 IDE 里改 wasm/src/font.rs 等
# 保存 → 自动 build → 重跑 → 终端打印 accept/regress
# 类别 count 下降 = accept，上升 = regress（回退）
node scripts/pdf-diff/baseline.mjs --check <agg.json>  # 收尾回归闸门
```

### C. AI agent 驱动（MCP 接入后）

对 AI 说：「用 pdf_diff_suggest 分析 examples 页的 #document，告诉我该改哪个核心方法」。
AI 内部流程：`pdf_diff_run` → 读 `categories` → 定位 `wasm/src/...` → 改源码 → `pdf_diff_suggest {rebuild:true}` → 比对 count → 重复至 `passCount` 达标。

### D. CI 回归

```bash
npm run pdf-diff:all
node scripts/pdf-diff/baseline.mjs --check <agg.json>   # 非 0 退出 = 阻断 CI
```

---

## 14. 设计取舍与已知限制

| 取舍 | 理由 |
|---|---|
| 主 oracle 用 Range 文本盒而非 Chromium PDF | 避免打印分页/缩放噪声，更干净的布局真值 |
| 文本对齐用行级 LCS（非逐词） | 粒度匹配 dompdf 输出；行内漂移靠 Δwidth 兜底 |
| Tier 4 半自动不改源码 | 安全：不会改坏构建/引入回归，由人确认 |
| 像素 diff 仅作闸门 | 抗锯齿/子像素本有噪声，不可作定位信号 |
| `lib/` 部分工具与 mvp 重复 | 不动 mvp，自包含；后续可统一迁移 |

**已知限制**：

- **复杂页面**（表格/浮动/绝对定位）文本对齐会有 `unmatchedOracle/unmatchedActual`——report 显式列出，不静默丢，但定位精度下降。
- **`font-encoding` 类**依赖"低像素差 + 高未匹配"判定，若同时有布局问题可能误判，需结合 `text-y-drift` 一起看。
- **Tier 4 建议置信度**：`hint` 标注方向，不保证 100% 正确，人工确认后再改。
- **MCP 路径**：绝对路径写死本机路径，迁仓库需同步改 Trae 等配置。
- **首次运行**较慢（chromium 启动 + 字体注入 + PDF 栅格化），后续可考虑缓存 oracle。

---

## 15. 扩展点

- **新增语料**：编辑 `corpus.mjs` 的 `defaultCorpus`。
- **新增根因类别**：在 `classify.mjs` 的 `SUSPECTED` / `HINTS` 加条目 + 在分类逻辑加触发条件。
- **接入更多 AI 工具**：`agent-core.mjs` 的 `dispatchTool` 是统一入口，任何新接口（HTTP API、WebSocket）包一层即可。
- **统一 mvp**：`pdf-diff-mvp.mjs` 后续可改为 import `lib/`，消除重复。
- **图形层对比**：Tier 2 目前只比文本，可扩展用 pdfjs `getOperatorList()` 比矩形填充/图片放置/clip path。
- **自动修复升级**：若要全自动，在 Tier 4 加一个「按建议直接改源码」的 agent 步骤（需更严格的回归闸门保护）。

---

*文档对应 `scripts/pdf-diff/` 系统当前实现。如结构变更，同步更新本文档。*
