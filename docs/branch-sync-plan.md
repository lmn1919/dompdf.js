# 分支差异分析与功能同步计划

- **当前分支**：`refactor/rust-engine`（HEAD `76b79f7`）
- **对照分支**：`main`（HEAD `327b1b9`，v1.3.1）
- **生成时间**：2026-06-30

---

## 一、分支定位

| 维度 | main（v1.3.1） | refactor/rust-engine |
|---|---|---|
| 渲染管线 | jsPDF + html2canvas 风格 TS 渲染 | DOM 快照 → Worker → Rust/WASM 渲染 |
| 入口 | `src/index.ts`（CanvasRenderer + paginate） | `src/index.ts`（worker + WASM `render_pdf`） |
| 构建 | webpack + babel + karma/jest | Rollup + `wasm/` Cargo 工程 |
| 测试体系 | `tests/reftests/` 50+ karma reftest | `scripts/pdf-diff/` 视觉 diff + 自动修复 |
| 依赖 | jspdf、html2canvas 等 | 无 jsPDF，自研 WASM |
| 文档站 | `www/` Gatsby 站 | 已移除 |

> 两个分支**无共同祖先**（`git merge-base main HEAD` 失败），属于完全分叉历史，不能简单 merge / cherry-pick，需要按"功能"维度逐项同步。

---

## 二、main 有、当前分支缺/弱的功能差异

| # | main 特性 | 当前分支状态 | 差距等级 |
|---|---|---|---|
| 1 | `pageBreak` 元素属性强制分页（`src/dom/element-container.ts` + `src/render/paginate.ts:188`） | 缺失。`computePageBreaks` 只做等高切分（`src/snapshot.ts:1915-1933`），无 CSS `break-before/after` 与 `pageBreak` 属性识别 | 高 |
| 2 | `divisionDisable` 元素禁分页（保持整块不跨页，`src/render/paginate.ts:195`） | 缺失。Rust 端 `wasm/src/paginate.rs` 无 break-inside:avoid 逻辑 | 高 |
| 3 | `activePageOffset` 跨页偏移追踪（`PageOffsetTracker`，`src/render/paginate.ts:22-46`） | 缺失。等高切分不累计偏移，长文档易累积误差 | 中 |
| 4 | `langFontConfig` 多语言字体匹配（PR #59 / #66） | 缺失。`FontConfig` 仅支持单/多字体，无按 `lang` 选择 | 中 |
| 5 | `iconFont` 图标字体导出（PR #52） | 部分支持。`FontConfig.iconFont` 字段保留，但 Rust TTF 路径未专门处理图标字体的私有映射 | 中 |
| 6 | `excludePage` 页眉页脚排除指定页（main 1.3.1, commit `79a0d45`） | 缺失。`PageConfig` 仅支持函数式逐页返回 null，无显式 exclude | 低-中 |
| 7 | `onJspdfReady` / `onJspdfFinish` 钩子（PR #40） | 字段保留为 no-op（`src/snapshot.ts:111-114`），但无 jsPDF 实例可暴露 | 低（架构差异） |
| 8 | PDF `encryption`（commit `f6c565f`） | 字段保留为 no-op，Rust 端 `wasm/src/snapshot.rs` 无 encrypt | 中 |
| 9 | dashed/dotted 边框空白页 bug 修复（PR #38） | 不适用（重写后架构不同），需在新管线上验证等价场景 | 低（验证类） |
| 10 | 跨域图片渲染容错（PR #36） | 需验证 `src/snapshot.ts` 图片采集的 CORS 失败路径 | 低（验证类） |
| 11 | karma reftest 测试体系（`tests/reftests/` 50+ 用例） | 已被 `scripts/pdf-diff/` 视觉 diff 体系替代，但用例覆盖度需对齐 | 中 |
| 12 | www 文档站（Gatsby） | 完全删除 | 低（产品决策） |

---

## 三、当前分支有、main 没有的增量能力（同步时需保留）

- Rust/WASM 渲染引擎（`wasm/src/`），无 jsPDF 依赖
- Worker 化渲染（`src/worker.ts`），主线程不阻塞
- PDF 视觉 diff + 自动修复体系（`scripts/pdf-diff/`）
- 渲染增强：box-shadow / text-justify / 节点透明度渐变 / object-fit / 渐变背景
- 字体能力：系统 CID 字体回退、逐字形字体回退、raw RGB 无损图片编码
- 快照协议 v6（`src/format.ts` + `wasm/src/snapshot.rs`）

---

## 四、差异功能同步计划

> **原则**：当前分支是下一代主干，目标是把 main 的**用户可感知功能**补齐到新引擎，**不回退架构**。不建议反向把 Rust 引擎合并回 main。

### 阶段 0：建立同步基线（前置）

- 在当前分支建立「main 功能对照清单」回归用例（直接复用 main 的 `tests/reftests/` 关键样例作为 pdf-diff 输入）。
- 用 `scripts/pdf-diff/run-all.mjs` 跑一遍，记录当前分支在分页 / 边框 / 图标字体 / 加密场景的 baseline。

### 阶段 1：分页能力对齐（高优先级，对应差距 #1 / #2 / #3）

#### 1.1 `pageBreak` 属性
- 在 `src/snapshot.ts` 采集阶段读取元素的 `pageBreak` data 属性或 `break-before/after` 计算样式。
- 写入快照协议（在 `src/format.ts` 增加 flag 位）。
- Rust 端 `wasm/src/paginate.rs` 识别 flag 并强制分页。

#### 1.2 `divisionDisable` / `break-inside:avoid`
- Rust 端 `wasm/src/paginate.rs` 分页算法增加"避免跨页"约束——元素若整体放不下当前页则前推到下一页。
- 快照协议增加 `avoid_break` 标记位。

#### 1.3 `activePageOffset` 等价物
- Rust 分页器维护跨页累计偏移，修正长文档累积误差。
- 对齐 main 的 `PageOffsetTracker` 行为（`src/render/paginate.ts:22-46`）。

**验收标准**：用 main 的 `tests/reftests/` 中分页用例做视觉 diff，DRM < 阈值。

### 阶段 2：字体能力对齐（中优先级，对应差距 #4 / #5）

#### 2.1 `langFontConfig`
- 扩展 `FontConfig`（`src/snapshot.ts:16`）增加 `lang` 字段。
- `wasm/src/font.rs` 按元素 `lang` 属性选择对应字体栈。

#### 2.2 `iconFont`
- Rust TTF 路径识别图标字体的私有码位区间，确保 `.notdef` 不被回退。

### 阶段 3：页眉页脚增强（低-中优先级，对应差距 #6）

- `excludePage`：在 `resolvePerPageHF`（`src/snapshot.ts:1955`）增加 `excludePages: number[]` 配置。
- 函数式 pageConfig 已天然支持（返回 null），仅需给对象式 pageConfig 增加该字段。

### 阶段 4：安全与兼容（中优先级，对应差距 #8 / #9 / #10）

#### 4.1 `encryption`
- 评估在 Rust 端 `wasm/src/pdf.rs` 实现 PDF 标准加密（RC4 / AES）。
- 或显式在文档声明不支持并移除 no-op 字段。

#### 4.2 跨域图片与 dashed/dotted 边框
- 用 main 的对应 reftest 用例跑 pdf-diff，发现问题即修。

### 阶段 5：架构性差异处理（低优先级 / 决策类，对应差距 #7 / #11 / #12）

#### 5.1 `onJspdfReady/Finish`
- 架构上不可兼容（无 jsPDF 实例）。
- 建议提供等价的 `onPdfBytesReady` 钩子替代，并在 README 明确迁移指引。

#### 5.2 测试体系
- 不回迁 karma。
- 需把 main reftest 用例的覆盖度迁移到 pdf-diff 体系。

#### 5.3 www 文档站
- 单独产品决策，不影响功能同步。

### 阶段 6：合并与发布

- 完成阶段 1-4 后，将 `refactor/rust-engine` 作为新主干合并到 `main`。
- 建议 fast-forward 或重建 main，避免 merge 噪音。
- 发布 **v2.0.0**（架构不兼容，主版本号 +1）。
- README / CHANGELOG 列明迁移指引。

---

## 五、优先级总览

| 阶段 | 内容 | 优先级 | 涉及差距 |
|---|---|---|---|
| 0 | 建立同步基线 | 前置 | — |
| 1 | 分页能力对齐 | 高 | #1 #2 #3 |
| 2 | 字体能力对齐 | 中 | #4 #5 |
| 3 | 页眉页脚增强 | 低-中 | #6 |
| 4 | 安全与兼容 | 中 | #8 #9 #10 |
| 5 | 架构性差异处理 | 低 / 决策 | #7 #11 #12 |
| 6 | 合并与发布 v2.0.0 | 收尾 | — |

---

## 六、建议下一步

从**阶段 1.2（`divisionDisable` / break-inside:avoid）**入手——它对实际导出质量影响最大，且改动集中在 `wasm/src/paginate.rs` 单文件，风险可控。
