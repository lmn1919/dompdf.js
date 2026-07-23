---
name: "dompdf-pdf-repair-loop"
description: "Generates PDF from a URL+selector, compares PDF vs HTML, applies targeted fixes, reruns diff, and asks whether to continue. Invoke when user wants an automated PDF diff/fix loop."
---

# DOMPDF PDF Repair Loop

输入一个网页 URL 和一个 CSS 选择器，自动完成以下闭环：

1. 打开页面并定位目标节点
2. 用 `dompdf` 只对该节点生成 PDF
3. 对比 HTML 截图与 PDF 渲染图
4. 分析差异并修改库代码
5. 重新构建、重新截图、重新对比
6. 输出本轮结果、文件路径和剩余差异
7. 明确询问用户是否继续下一轮修复

这个 skill 适用于：

- 用户给出 URL + 选择器，要求自动导出 PDF 并对比
- 用户要求“自动修复 PDF 与 HTML 的差异”
- 用户希望进行“对比 -> 修复 -> 复验 -> 再确认是否继续”的多轮闭环

## 目标

你不是只跑一次脚本，而是要把整个流程编排成一个可迭代的修复循环：

- 第一轮：拿到基线差异
- 中间轮：针对高置信问题做最小修复
- 每轮结束：给出结果并询问用户是否继续
- 用户确认继续后，再进入下一轮

## 输入约定

当用户触发本 skill 时，优先收集这些参数：

- `url`: 目标网页地址
- `selector`: 目标节点 CSS 选择器
- `removeSelectors`: 可选，导出前要移除的子节点选择器列表
- `pageLimit`: 可选，对比页数限制
- `skipInspect`: 可选，是否跳过 inspect
- `exportTimeoutMs`: 可选，导出超时
- `inspectTimeoutMs`: 可选，inspect 超时

如果用户没有提供 `selector`，必须先向用户确认，不要自动猜测一个复杂选择器直接开始修复。

## 关键文件

| 用途 | 文件 |
|---|---|
| 自动导出/对比脚本 | `scripts/pdf-diff-mvp.mjs` |
| HTML 示例桥接 | `examples/index.html` |
| PDF 差异图片与报告 | `tmp/pdf-diff-mvp/...` |
| DOM 快照采集 | `src/snapshot.ts` |
| 库入口 | `src/index.ts` |
| WASM 分页/绘制 | `wasm/src/paginate.rs` |
| WASM PDF 输出 | `wasm/src/pdf.rs` |
| WASM 快照解析 | `wasm/src/snapshot.rs` |

## 标准执行流程

### 第 1 步：确认参数

必须确认至少两个核心输入：

- `url`
- `selector`

可选输入有：

- `removeSelectors`
- `pageLimit`
- `skipInspect`
- `inspectTimeoutMs`
- `exportTimeoutMs`

如果用户没有提供可选项，可使用下列默认值：

- `pageLimit=3`
- `skipInspect=true`（外站优先）
- `inspectTimeoutMs=20000`
- `exportTimeoutMs=120000`

### 第 2 步：先构建库

在执行对比前先确保当前库产物是最新的：

```powershell
npm run build
```

若构建失败，先修构建错误，再继续。

### 第 3 步：执行一轮基线导出与对比

使用脚本：

```powershell
node scripts/pdf-diff-mvp.mjs --url "<URL>" --css-selector "<SELECTOR>" --page-limit <N> --out-dir "<DIR>"
```

按需追加：

```powershell
--remove "<SEL1,SEL2,...>"
--skip-inspect
--inspect-timeout-ms <N>
--export-timeout-ms <N>
```

如果是 PowerShell 且选择器里有 `#`，必须加引号：

```powershell
--css-selector "#document"
```

### 第 4 步：读取并分析结果

优先读取这些产物：

- `report.json`
- `inspect.txt`
- `expected-page-*.png`
- `actual-page-*.png`
- `diff-page-*.png`

重点看：

1. `summary.aggregateMismatchRatio`
2. `summary.maxMismatchRatio`
3. 每页 `mismatchRatio`
4. `inspect.txt` 是否超时、报错、节点数量异常

建立差异清单，格式示例：

```text
差异 1：第一页标题区域偏移，diff 图在顶部大面积着色
差异 2：代码块区域缺失，inspect 超时且 export 很慢
差异 3：图片过多导致导出过慢，目标节点过重
```

在建立差异清单前，先过滤“可忽略差异”。以下情况默认不作为修复目标：

- 字体度量差异导致的轻微字宽、字距、换行差异
- 字重不一致导致的粗细视觉差异
- 仅由字体 fallback 不同引起、但内容未缺失的文字样式差异

如果差异主要由上述原因造成，应在结果中标记为“已忽略字体相关视觉差异”，而不是进入核心修复流程。

### 第 5 步：选择修复策略

优先使用“最小充分修复”，按下面顺序推进：

#### 5.1 外围减负优先

先尝试不改核心渲染算法的方案：

- 缩小目标选择器
- 使用 `--remove` 移除重节点：`img,aside,pre,code,iframe` 等
- 跳过 inspect
- 降低 pageLimit

如果外围减负已经能显著降低差异或让导出跑通，优先采用。

#### 5.2 再做库代码修复

只有在确认是库本身的问题后，才修改：

- `src/snapshot.ts`
- `src/index.ts`
- `wasm/src/paginate.rs`
- `wasm/src/pdf.rs`
- `wasm/src/snapshot.rs`

典型问题与优先检查点：

- 文本截断/缺失：`snapshot.ts`、`paginate.rs`
- 分页错位：`paginate.rs`
- 裁切错误：`paginate.rs`
- 坐标/缩放问题：`snapshot.ts`、`paginate.rs`
- PDF 结构问题：`pdf.rs`

不要把以下问题当作本 skill 的默认修复目标：

- 字体度量和浏览器不完全一致
- 字重映射和浏览器不完全一致
- 因不同字体渲染引起、但不影响内容完整性的轻微文本视觉差异

只有当字体问题已经导致“内容缺失、严重重叠、无法阅读、分页明显错误”时，才允许继续下钻修复。

### 第 6 步：修改后重新验证

每次修复后必须重新执行完整链路：

1. 重新构建
2. 重新导出 PDF
3. 重新生成 diff
4. 重新读取 `report.json`
5. 对比本轮与上一轮指标

如果修改了 Rust/WASM 侧，必须重新：

```powershell
npm run build
```

### 第 7 步：每轮结束都必须询问用户

每一轮闭环完成后，必须向用户汇报：

1. 本轮修改了哪些文件
2. 为什么这么改
3. 本轮 diff 指标变化
4. 产物路径
5. 剩余问题

然后明确询问：

```text
是否继续下一轮对比修复？
```

如果用户没有明确同意，不要自动进入下一轮。

## 输出要求

每轮结束时，输出应至少包含：

- 本轮结论
- 修改文件列表
- 关键命令
- `report.json` 路径
- `inspect.txt` 路径
- diff 图片目录路径
- 本轮前后指标变化
- 是否建议继续

路径示例：

- `tmp/pdf-diff-mvp/<run-id>/report.json`
- `tmp/pdf-diff-mvp/<run-id>/inspect.txt`
- `tmp/pdf-diff-mvp/<run-id>/diff-page-1.png`

## 决策原则

### 优先级

1. 先让流程跑通
2. 再缩小差异
3. 再处理复杂边角问题

### 禁止事项

- 未经用户确认就无限循环修复
- 一次同时修改太多核心文件
- 不读 `report.json` 就声称“修好了”
- 差异未下降却继续堆改动
- 为了跑通而回退或覆盖用户已有修改
- 明知差异主要来自字体度量或字重不一致，仍继续把它当成必须修复项

## 推荐命令模板

### 基线跑一次

```powershell
node scripts/pdf-diff-mvp.mjs --url "<URL>" --css-selector "<SELECTOR>" --page-limit 3 --skip-inspect --out-dir "tmp/pdf-diff-mvp/manual-run"
```

### 带净化规则

```powershell
node scripts/pdf-diff-mvp.mjs --url "<URL>" --css-selector "<SELECTOR>" --remove "img,aside,pre,code,iframe" --page-limit 3 --skip-inspect --export-timeout-ms 180000 --out-dir "tmp/pdf-diff-mvp/manual-run"
```

## 交付模板

当你完成一轮后，使用类似结构汇报：

```text
本轮结果：
- 导出已跑通 / 仍超时 / 差异已下降
- 修改文件：...
- 平均差异：... -> ...
- 最大差异：... -> ...
- 报告路径：...
- 差异图路径：...

剩余问题：
- ...

已忽略差异：
- 字体度量/字重不一致造成的轻微视觉差异（如适用）

是否继续下一轮对比修复？
```
