---
name: "pdf-diff-fixer"
description: "自动对比生成的 PDF 与 HTML 页面差异，定位并修复 PDF 渲染 bug。Invoke when user asks to compare PDF vs HTML, fix PDF rendering differences, or when PDF output doesn't match the HTML source."
---

# PDF Diff Fixer

自动对比 dom2pdf 库生成的 PDF 与 HTML 源页面差异，定位根因并修复，然后验证修复结果。

## When to Invoke

- 用户说"对比 PDF 和 HTML"、"PDF 显示不对"、"PDF 缺少内容"、"PDF 和页面不一致"
- 用户说"fix PDF"、"修复 PDF"、"为什么 PDF 里没有 XXX"
- diagnose-output.txt 中出现 `[TXT-SKIP]`、`slice OOB`、`draw_node vis=false` 异常
- 生成的 PDF 打开后文本缺失、截断、位置错乱、图片不显示

## 工具链与关键文件

| 用途 | 文件/命令 |
|---|---|
| 构建 WASM | `npm run build:wasm` (调用 `scripts/build-wasm.mjs`) |
| 运行诊断 | `node scripts/diagnose.mjs > diagnose-output.txt 2> err.log` |
| 基础冒烟 | `npm run verify` (调用 `scripts/verify.mjs`) |
| 诊断输出 | `diagnose-output.txt` |
| 诊断产物 PDF | `scripts/diagnose-output.pdf` |
| WASM 源码 | `packages/dom2pdf-wasm/src/{lib.rs,paginate.rs,snapshot.rs,pdf.rs,font.rs}` |
| 快照采集 | `packages/dom2pdf/src/snapshot.ts` (DOM→二进制快照) |
| 二进制编码 | `packages/dom2pdf/src/format.ts` (BinWriter) |
| WASM 胶水 | `packages/dom2pdf/src/wasm-glue.ts` |
| playground | `apps/playground/src/main.ts` |
| 设计规范 | `desgin.md` |

## 标准执行流程（必须按顺序）

### 步骤 1：构建 WASM 并运行诊断

```powershell
npm run build:wasm
node scripts/diagnose.mjs > diagnose-output.txt 2> err.log
```

如果 `build:wasm` 失败，先修 Rust 编译错误（常见：类型不匹配、borrow 错误），再继续。

### 步骤 2：读取诊断输出，构建差异清单

读取 `diagnose-output.txt`，关注三个区块：

1. **`=== Inspect ===` 区块**：列出每个节点的元数据。检查：
   - 每个文本节点的 `text=` 是否完整
   - 每个 line 的 `start`/`end` 是否在 `text` 字节长度范围内
   - `page=` 是否符合分页预期（跨页行应在下一页）
   - `draw_y` 是否合理

2. **`--- page N content ---` 区块**：PDF 内容流的明文解析。检查：
   - 每个 `TEXT` 操作的文本是否完整（未被截断）
   - 每个 `POS` 的 x/y 坐标是否符合预期
   - `CLIP`/`FILL`/`LINE`/`IMAGE` 操作是否齐全
   - 是否有节点在期望的页面缺失

3. **`=== Content streams ===` 区块**：按页面汇总绘制操作，便于整体核对。

构建差异清单，格式示例：
```
差异 1: 节点 #1 (h1 "Quarterly Product Report") 在 PDF 中缺失
差异 2: 节点 #9 文本被截断为 "This container has overflow: hidd"
差异 3: 节点 #10 (跨页行) 未出现在第 2 页
```

### 步骤 3：定位根因

对每个差异，按以下决策树定位根因：

#### 3.1 文本缺失/截断 / 同一行出现大空格
- **检查 Rust 端 `paginate.rs::draw_text_lines`**：
  - 是否有 `slice OOB` → `line.end` 超过 `txt.len()`
  - 是否有 `e <= s` → `line.start`/`line.end` 计算错误
  - 是否 `line.page != draw_page` → 分页错误
- **检查 TS 端 `snapshot.ts::collectTextLines`**：
  - `end: off[Math.min(end16, n)]` 中 `n` 是字符长度，`off` 数组长度是 `n+1`
  - `end16` 是否可能超过 `n`（RangeRect 的 end 可能大于文本长度）
  - `utf8Offsets` 函数是否正确计算每个字符的 UTF-8 字节偏移
  - **同一视觉行被多个 rect 分割**：当 HTML 源码在 `<p>` 内硬换行时，`Range.getClientRects()` 可能返回多个 top 相同但 left 不同的 rect。如果每个 rect 都生成一个独立 line，PDF 会在同一行画出多个文本段，中间出现大空格。修复：合并 top 相同（差 < 1px）的 rect 为一个 line。
- **修复策略**：
  - Rust 端添加 clamp：`let e = (line.end as usize).min(txt.len());`
  - TS 端确保 `end16 = Math.min(end16, n)` 再查 `off[end16]`
  - TS 端合并同一视觉行的多个 rect

#### 3.2 节点位置错误
- **检查 `paginate.rs::rect_pt`**：
  - 返回 `(x0, bottom, w, h)`，其中 `bottom = top_pt - h`
  - PDF 矩形 `x y w h re` 从 (x, y) 向右向上拉伸，所以 y=bottom 是对的
  - `top_pt = page_height_pt - margin_top - (node.y - page * content_h_px) * PX_TO_PT`
  - PX_TO_PT = 0.75 (96dpi → 72dpi)
- **检查图像 `cm` 指令**：
  - 格式 `q w 0 0 h x y cm /ImN Do Q`
  - w/h 是缩放后的尺寸（pt），x/y 是平移（左下角）
  - 图像原始坐标系是 (0,0)到(1,1)，变换后映射到 (x,y)到(x+w,y+h)

#### 3.3 clip 区域错误
- **检查 overflow:hidden box 的 clip 矩形**：
  - clip 应该是 `(x0, bottom, w, h)`，向上拉伸到 `top_pt`
  - 如果 clip 把正常内容裁掉了，说明 bottom/h 计算反了
- **检查 clip 栈的 push/pop 配对**：
  - `q` (push) 必须有对应的 `Q` (pop)
  - overflow:hidden 的 clip 应该包裹整个子树

#### 3.4 分页错误
- **检查 `paginate.rs::paginate` 函数**：
  - 跨页行（`line.page != 当前页`）应移至下一页
  - `content_h_px = (page_height_pt - margin_top - margin_bottom) / PX_TO_PT`
  - 行的 `page` 计算公式：`(line.y + line.h > (page+1) * content_h_px) ? page+1 : page`

#### 3.5 测试数据问题（仅 diagnose.mjs）
- `scripts/diagnose.mjs` 中硬编码的 `end` 值必须等于 `Buffer.byteLength(text, 'utf8')`
- 用 `node -e "console.log(Buffer.byteLength('text', 'utf8'))"` 验证

### 步骤 4：修复

- **Rust 修改后必须重新 `npm run build:wasm`**
- **TS 修改后必须重新 `npm run build:lib`**（如果测试的是打包产物）
- 一次只修一类问题，避免引入新 bug
- 优先用 clamp/防御性编码，而不是假设输入永远正确

### 步骤 5：验证修复

```powershell
npm run build:wasm
node scripts/diagnose.mjs > diagnose-output.txt 2> err.log
```

检查：
1. `diagnose-output.txt` 中每个 `[TXT-DRAW]` 的 seg 是否完整
2. 每个期望节点是否都出现在正确的页面
3. `npm run verify` 是否通过
4. 必要时在 playground (`npm run dev`) 中实际打开浏览器验证

## 常见 bug 模式速查

| 症状 | 根因 | 修复位置 |
|---|---|---|
| h1/标题缺失 | `line.end = text.length + 1` | `snapshot.ts` 或测试数据 |
| 文本末尾少几个字符 | `line.end` 比 UTF-8 字节长度大 | `snapshot.ts::collectTextLines` |
| 同一行出现大空格 | HTML 源码换行使 `Range.getClientRects()` 返回多个同 top rect | `snapshot.ts::collectTextLines` |
| 跨页行消失 | `line.page` 计算错误或 Rust 端 skip | `paginate.rs::draw_text_lines` |
| 图像位置偏移 | `cm` 参数顺序错或坐标系混淆 | `paginate.rs::draw_image` |
| clip 裁掉正常内容 | clip rect 上下颠倒 | `paginate.rs::rect_pt` |
| 文本全空白 | `encode_winansi` 返回空或 font size=0 | `paginate.rs::draw_text_lines` |
| 文字间距/字距不对 | 未采集 CSS `letter-spacing`/`word-spacing` | `snapshot.ts::makeFont` + `paginate.rs::draw_text_lines` |
| PDF 无法打开 | xref 偏移错误 | `paginate.rs::build_pdf` |

## 输出要求

完成修复后，向用户报告：
1. 修复了哪些差异（列出每个差异的根因）
2. 修改了哪些文件
3. 验证结果（diagnose-output.txt 的关键行）
4. 如果有未解决的差异，说明原因和下一步建议
