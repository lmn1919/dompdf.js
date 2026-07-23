# dompdf.js 生成进度回调实施计划

## Summary

为 `dompdf.js` 新增正式的导出进度回调能力，覆盖：

- 主线程 DOM 快照采集阶段的状态通知
- 分页总页数预计算结果通知
- Worker + Rust/WASM 渲染阶段的按页生成进度通知
- 示例页 `examples/index.js` 的状态文案联动展示

本次按“库 API + 示例页”范围规划，并采用“精确分页进度”方案：当 `pagination: true` 且传入进度回调时，回调可拿到 `stage`、`totalPages`、`currentPage`，从而支持“页面解析中 / 总页数 / 已生成到第几页”的 UI 表达。

## Current State Analysis

### 1. 当前导出链路

- `src/index.ts`
  - `renderToBytes()` 当前流程为 `buildSnapshot()` -> `callWorker(snapshot, 'render')`
  - `buildSnapshot()` 已支持两阶段逻辑：必要时先 `countPages`，再回填按页页眉页脚/水印
  - Worker 返回协议当前只有最终响应 `WorkerResponse`，没有中途进度消息
- `src/worker.ts`
  - 当前只处理 `render | inspect | countPages` 三类操作
  - `postMessage` 仅在任务完成或失败时回传一次
- `src/wasm-glue.ts`
  - 当前 `renderPdf()` / `countPages()` / `inspectSnapshot()` 只有最终结果接口，没有进度桥接
- `wasm/src/lib.rs`
  - `render_pdf()` 内部是 `parse -> paginate::paginate -> paginate::build_pdf`
  - `count_pages()` 已能返回精确总页数
- `wasm/src/paginate.rs`
  - `assign_pages()` 负责统一分页归属计算
  - `build_pdf()` 能拿到完整 `pages: &[PagePlan]`，并在 `for (i, p) in pages.iter().enumerate()` 中逐页写入内容流和页对象
  - 这里是“当前生成到第几页”最稳定的渲染期埋点位置

### 2. 当前公开 API 状态

- `src/snapshot.ts` 的 `ExportOptions` 里还没有正式进度回调
- 仅保留了兼容签名 `onJspdfReady` / `onJspdfFinish`，但它们是 no-op
- `README.md` / `README_CN.md` / `docs/migration-compat.zh-CN.md` 也尚未描述任何进度回调能力

### 3. 示例页现状

- `examples/index.js` 目前只有 `setStatusLoading()` / `setStatus()` 文案切换
- `window.exportDompdf()` 调用 `renderWithDompdf()` 时没有消费任何中途状态
- 页面已有状态区域，无需新增结构，优先复用现有状态文本

## Proposed Changes

### A. 新增正式进度回调 API

#### 文件

- `src/snapshot.ts`
- `src/index.ts`

#### 改动内容

1. 在 `src/snapshot.ts` 中为 `ExportOptions` 新增正式字段：
   - `onProgress?: (progress: ExportProgress) => void`
2. 在 `src/index.ts` 中导出新的类型：
   - `ExportProgressStage`
   - `ExportProgress`

#### 建议事件模型

```ts
type ExportProgressStage =
  | 'collecting'
  | 'countingPages'
  | 'rendering'
  | 'done';

interface ExportProgress {
  stage: ExportProgressStage;
  totalPages?: number;
  currentPage?: number;
}
```

#### 语义约定

- `collecting`
  - 主线程正在执行 `collectSnapshotData()`
  - 不保证页数信息
- `countingPages`
  - 已进入页数预计算
  - 完成后至少回调一次带 `totalPages`
- `rendering`
  - 已进入 WASM 真正写 PDF 阶段
  - 当开启分页时，回调 `currentPage` 与 `totalPages`
  - 页码使用 1-based，直接对齐用户 UI 认知
- `done`
  - PDF 字节已生成完成，最终状态收口

#### 为什么这样设计

- 不复用 `onJspdfReady/onJspdfFinish`，避免把真实可用能力继续挂在“兼容层 no-op”语义下
- `stage + totalPages + currentPage` 足够支撑示例页和业务侧自定义 loading UI
- 事件结构保持轻量，避免一次规划就引入复杂的百分比估算体系

### B. 主线程链路接入进度调度

#### 文件

- `src/index.ts`

#### 改动内容

1. 为 `buildSnapshot()` 增加进度回调参数，并在以下节点触发：
   - 调用 `collectSnapshotData()` 前：`stage: 'collecting'`
   - 进入页数预计算前：`stage: 'countingPages'`
   - 得到页数后：`stage: 'countingPages', totalPages`
2. 调整页数预计算策略：
   - 当前只有 `pageConfig` / `watermark` 需要按页解析时才调用 `countPages`
   - 改为：当 `pagination: true` 且存在 `onProgress` 时，也执行一次 `countPages`
   - 若本来就需要 `countPages`，则复用同一次结果，不重复计算
3. 扩展 `callWorker()`，让它既能等待最终结果，也能消费同 `id` 的中途进度消息
4. 在 `renderToBytes()` / `exportPDF()` 的完成路径补发：
   - `stage: 'done', totalPages, currentPage: totalPages`

#### 关键决策

- 为了满足“精确总页数”，接受在分页导出 + 进度回调场景下多一次页数预计算
- 单页模式不强造 `totalPages/currentPage` 语义，最多表现为 `done` 或 `totalPages: 1`
  - 实施时建议统一为 `totalPages: 1, currentPage: 1`，让 UI 处理更简单

### C. Worker 消息协议扩展

#### 文件

- `src/index.ts`
- `src/worker.ts`

#### 改动内容

1. 将当前单一 `WorkerResponse` 协议拆成两类消息：
   - 终态消息：`type: 'result'`
   - 进度消息：`type: 'progress'`
2. `src/index.ts` 为每个请求 `id` 同时保存：
   - 终态 Promise resolver
   - 可选的 `onProgress` 处理器
3. `src/worker.ts` 在执行 `render` 时，把 WASM 侧收到的进度即时 `postMessage` 回主线程

#### 约束说明

- 现有共享 Worker 设计可以继续保留
- 当前渲染主体是同步 CPU 计算，同一 Worker 实际只会串行处理一个重型 `render`
- 因此可使用“当前活动请求 id + 进度转发”的实现，不需要为这次功能重构成多 Worker 架构

### D. WASM 进度桥接

#### 文件

- `src/wasm-glue.ts`
- `wasm/src/lib.rs`
- `wasm/src/paginate.rs`

#### 改动内容

1. `src/wasm-glue.ts`
   - 为 WASM 初始化增加 import 回调，例如 `env.report_progress`
   - 在 `renderPdf()` 中允许传入 JS 侧进度监听器
   - 将来自 WASM 的 `(currentPage, totalPages)` 转成结构化事件
2. `wasm/src/lib.rs`
   - 新增对宿主回调的导入声明
   - 在 `render_pdf_inner()` 里把 `paginate()` 拿到的 `pages.len()` 传递给后续 PDF 构建阶段
3. `wasm/src/paginate.rs`
   - 为 `build_pdf()` 增加可选进度上报能力
   - 在逐页写 content/page object 的稳定循环中上报：
     - 开始写某页后或完成某页后
     - `currentPage = i + 1`
     - `totalPages = pages.len()`

#### 埋点位置建议

- 优先在 `build_pdf()` 的逐页 content/page object 生成循环内上报
- 不把进度挂在更细粒度的字体/图片对象写入阶段，避免大量噪声回调和不稳定节奏

#### 为什么不用百分比

- 当前流水线天然有“阶段 + 页数”的准确信号
- 百分比如果混合 DOM 采集、页数预计算、PDF 写出三段，容易出现回跳或与实际感知不一致

### E. 示例页联动展示

#### 文件

- `examples/index.js`

#### 改动内容

1. 在 `renderWithDompdf()` 或其调用链中传入 `onProgress`
2. 复用现有状态栏，按阶段更新文案，建议格式：
   - `正在解析页面...`
   - `正在计算总页数... 共 X 页`
   - `正在生成 PDF... 第 Y / X 页`
   - `dompdf.js 导出完成 · ...`
3. 保持 `html2pdf.js` 分支现状不变，避免制造“两个引擎进度口径一致”的误导

#### UI 范围控制

- 本次不新增新的进度条 DOM
- 只增强状态文本，降低改动面，先验证 API 与体验是否符合预期

### F. 文档同步

#### 文件

- `README.md`
- `README_CN.md`
- `docs/migration-compat.md`
- `docs/migration-compat.zh-CN.md`

#### 改动内容

1. 在中英文 README 的快速示例或能力说明中加入 `onProgress`
2. 在迁移文档中说明：
   - `onProgress` 是新的正式导出回调
   - 与 `onJspdfReady/onJspdfFinish` 不同，它有真实行为
3. 补一段分页导出示例，演示如何在业务侧展示总页数与当前页

## Assumptions & Decisions

- 已确认本次范围为“库 API + 示例页”
- 已确认优先支持“精确分页进度”
- 进度回调以新增正式 API `onProgress` 的方式提供，不复用旧兼容钩子
- 进度模型以“阶段 + 页数”为核心，不额外设计百分比
- 对于 `pagination: true` 且传入 `onProgress` 的场景，允许执行一次页数预计算以换取精确总页数
- 示例页只改状态文案，不额外新增视觉组件
- 进度回调默认视为 best-effort UI 信号，不参与 PDF 内容正确性判定

## Verification Steps

### 1. 类型与构建验证

- 运行 `npm run build`
- 确认 `dist/types` 中暴露了新的 `onProgress` 相关类型
- 确认 Rollup 打包后的 Worker/WASM 路径仍正常

### 2. 基础功能验证

- 运行 `npm test`
- 使用 `examples/index.html` 导出普通样本，确认状态依次经历：
  - collecting
  - countingPages
  - rendering
  - done

### 3. 分页精度验证

- 在轻量、重压测、10000 页样本三档下分别验证：
  - `countingPages` 返回的 `totalPages` 为正数
  - `rendering` 的 `currentPage` 单调递增
  - 最终 `currentPage === totalPages`
- 对比最终导出 PDF 的真实页数与回调页数是否一致

### 4. 回归验证

- 不传 `onProgress` 时，导出结果与当前行为保持一致
- `pagination: false` 时不出现异常回调风暴
- 含 `pageConfig` / `watermark` 的按页配置仍可正常解析
- 错误场景下仍能进入现有错误处理分支，不出现 pending Promise 泄漏
