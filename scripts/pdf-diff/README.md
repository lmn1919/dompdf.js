# PDF 对比-自动修复（Tier 0–4）

在 `pdf-diff-mvp.mjs` 基础上补齐"对比 + 自动修复闭环"。给定 URL + 选择器，先用无头浏览器
生成参照（Chromium 打印 PDF + Range-API 文本盒真值），再用本库导出 PDF，结构化对比文本位置，
分类根因，输出修复建议（半自动，不改源码）。

## 分层

| Tier | 作用 | 输出 |
|---|---|---|
| 0 参照对 | dompdf `actual.pdf` + Chromium `ref.pdf` + `oracle.json`(Range 文本盒) + `inspect.txt` | `actual.pdf`/`ref.pdf`/`html-source.png`/`oracle.json`/`inspect.txt` |
| 1 粗指标 | 两 PDF 栅格化 pixelmatch（回归闸门） | `report.json` tier1，`*-page-*.png` |
| 2 结构化 diff | pdfjs `getTextContent` ↔ Range 真值，逐项 `Δx/Δy/ΔfontSize` | `report.json` tier2（discrepancies） |
| 3 根因分类 | 差异模式 → 类别 → 疑似 Rust/WASM 核心方法 | `report.json` tier3（categories） |
| 4 修复闭环 | 半自动：跑全流程 → `fix-suggestions.{md,json}`；`--watch` 重建后打印 accept/regress | `tmp/pdf-diff-runs/fix-suggestions.md` |

## 用法

```bash
# 1. 安装无头浏览器（首次）
npm run playwright:install

# 2. 单语料全流程（默认本地 examples/index.html #document）
npm run pdf-diff:run
#   自定义：node scripts/pdf-diff/run.mjs --url <url> --selector <css>

# 3. 语料汇总 + 回归基线
npm run pdf-diff:all
node scripts/pdf-diff/baseline.mjs --save tmp/pdf-diff/<ts>/aggregate-report.json
node scripts/pdf-diff/baseline.mjs --check tmp/pdf-diff/<ts>/aggregate-report.json   # 回归则非 0 退出

# 4. 半自动修复闭环
node scripts/pdf-diff/fix-loop.mjs                 # 跑一次，输出建议
node scripts/pdf-diff/fix-loop.mjs --rebuild       # 先 npm run build 再跑
node scripts/pdf-diff/fix-loop.mjs --watch         # 监听 wasm/src、src，变化后重建→重跑→对比
```

## LLM Agent 接口（供 AI 编程工具调用）

提供两种等价接口，均暴露 5 个工具：`pdf_diff_run` / `pdf_diff_all` /
`pdf_diff_suggest` / `pdf_diff_categories` / `pdf_diff_capabilities`。

### 1. JSON CLI（任何能跑 shell 的 AI 工具）

```bash
node scripts/pdf-diff/agent.mjs capabilities                              # 自描述工具清单
node scripts/pdf-diff/agent.mjs run --url <u> --selector <s>              # 单语料 Tier 0–3，输出 report JSON
node scripts/pdf-diff/agent.mjs all                                       # 语料汇总 JSON
node scripts/pdf-diff/agent.mjs suggest --rebuild                         # Tier 4 建议 JSON + 写 fix-suggestions.md
node scripts/pdf-diff/agent.mjs categories --report-path <report.json>    # 从已有 report 读分类
```

stdout 永远是单个 JSON 对象（人类进度走 stderr，可 `2>/dev/null` 屏蔽）。
出错时返回 `{ error, message }` 且退出码 1。

### 2. MCP server（Claude Code / Cursor / Cline 等原生工具调用）

仓库已带 `.mcp.json`，Claude Code 打开本项目会自动发现 `pdf-diff` server。
手动注册（用户级）：

```jsonc
// ~/.claude.json 或项目 .mcp.json
{
  "mcpServers": {
    "pdf-diff": { "command": "node", "args": ["scripts/pdf-diff/mcp-server.mjs"] }
  }
}
```

或命令行：`claude mcp add pdf-diff node scripts/pdf-diff/mcp-server.mjs`

注册后 AI 工具即可把 `pdf_diff_suggest` 等当普通工具调用，无需手写 shell。
MCP server 是手写 JSON-RPC over stdio，**无新依赖**。

### 典型 agent 工作流

1. `pdf_diff_run { url, selector }` → 拿到 `categories`（根因 + 疑似核心方法）
2. 读 `suggestions`/`hint` → AI 定位到 `wasm/src/font.rs::encode_winansi` 等
3. AI 改源码 → `npm run build`
4. `pdf_diff_suggest { rebuild: true }` → 比较类别 count 是否下降（accept/regress）
5. 重复直到 `pdf_diff_all` 的 `passCount` 达标

## 语料

`corpus.mjs` 默认一条本地 `examples/index.html` + `#document`。新增语料：编辑 `defaultCorpus`
或 `node scripts/pdf-diff/run-all.mjs --url <u> --selector <s>`。

## 类别 → 疑似核心方法

| 类别 | 疑似 |
|---|---|
| text-x-drift | `wasm/src/font.rs::text_width_units` / `ttf.rs` hmtx |
| text-y-drift | `wasm/src/paginate.rs::paginate` |
| page-break | `wasm/src/paginate.rs::assign_pages` |
| font-size | `src/snapshot.ts` PX_TO_PT / `font.rs` 缩放 |
| font-family | `wasm/src/font.rs` 字体选择 / CID 嵌入 |
| color | `src/snapshot.ts` 颜色解析 / `paginate.rs` alpha |
| image | `wasm/src/snapshot.rs::Image` / `paginate.rs` 渲染 / CORS |
| transform | `wasm/src/paginate.rs` 变换矩阵 / `snapshot.ts` transform |
| wrap | `wasm/src/paginate.rs` 断行 / `font.rs` 测量 |

## 注意

- Tier 2 文本对齐用 LCS，复杂页面会有 `unmatchedOracle/unmatchedActual`（显式列出，不静默丢）。
- Tier 4 半自动不保证建议正确，`hint` 标注方向，人工确认后再改源码。
- 不修改 `pdf-diff-mvp.mjs` 与现有源码；`lib/` 自包含，部分工具与 mvp 重复（后续可统一）。
