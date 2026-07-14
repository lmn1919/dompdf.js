# dompdf.js

[English](./README.md) | [中文](./README_CN.md)

`dompdf.js` 是一个纯前端 DOM 转 PDF 引擎，底层由 Rust、WebAssembly 和 TypeScript 驱动。它不依赖 jsPDF，直接在浏览器中生成矢量 PDF，适合长文档、可选中文本、自定义字体以及重分页场景。

**在线演示：** [dompdfjs.lisky.com.cn](https://dompdfjs.lisky.com.cn)  
**旧版 API 迁移说明：** [docs/migration-compat.zh-CN.md](./docs/migration-compat.zh-CN.md)

## 亮点

- Rust + WASM 渲染流水线
- 生成可选中文本的矢量 PDF
- 支持大文档分页
- 支持自定义字体与 Unicode 文本
- 支持页眉页脚
- 支持压缩与 PDF 加密
- 纯浏览器侧运行，无需服务端

## 安装

仓库名和 npm 包名均为 `dompdf.js`。

### npm

```bash
npm install dompdf.js
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

## 快速开始

```js
import dompdf from 'dompdf.js';

const element = document.querySelector('#capture');
const blob = await dompdf(element, {
  format: 'a4',
  pagination: true,
});

const url = URL.createObjectURL(blob);
const a = document.createElement('a');
a.href = url;
a.download = 'example.pdf';
a.click();
URL.revokeObjectURL(url);
```

## 工作原理

1. 主线程遍历 DOM 并采集快照。
2. Web Worker 接收快照并整理渲染数据。
3. Rust/WASM 模块写出 PDF 字节流。
4. 浏览器以 `Blob` 形式返回导出结果。

这种结构绕开了 canvas 截图链路的瓶颈，同时能在导出时保持界面可响应。

## 当前能力

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 分页 | 稳定 | 支持多页输出和大文档 |
| 文本渲染 | 稳定 | 支持 Unicode、自定义字体、对齐、行高 |
| 图片 | 稳定 | 支持位图、SVG、data URL |
| 背景与边框 | 稳定 | 支持背景色、渐变、圆角边框 |
| 页眉页脚 | 稳定 | 支持对象配置和按页回调 |
| 压缩 | 稳定 | WASM 写 PDF 时进行真实 DEFLATE 压缩 |
| 加密 | 稳定 | 支持用户/所有者密码和权限控制 |
| 旧版 jsPDF 钩子 | 仅兼容 | `onJspdfReady` / `onJspdfFinish` 会被接受，但实际不生效 |

## 分页说明

通过 `pagination: true` 开启分页。为了获得更稳定的结果，建议让待导出容器的 CSS 宽度与目标纸张宽度对应。A4 在 96 DPI 下的推荐宽度是 `794px`。

常见纸张尺寸和像素参考见 [page_sizes.md](./page_sizes.md)。

```js
await dompdf(document.querySelector('#capture'), {
  pagination: true,
  format: 'a4',
  pageConfig: {
    header: {
      content: '文档页眉',
      height: 50,
      contentFontSize: 12,
      contentPosition: 'center',
    },
    footer: {
      content: '第 ${currentPage} / ${totalPages} 页',
      height: 50,
      contentFontSize: 12,
      contentPosition: 'center',
    },
  },
});
```

### 更细的分页控制

- `divisionDisable`：尽量让一个区块保持在同一页
- `pageBreak`：在元素前强制分页
- `excludePage` / `excludePages`：指定哪些页跳过页眉页脚

## 字体配置

非拉丁文本建议显式嵌入字体。

```js
import dompdf from 'dompdf.js';

const fontBuffer = await fetch('/fonts/SourceHanSansSC-Regular.ttf').then((res) =>
  res.arrayBuffer(),
);

await dompdf(document.querySelector('#capture'), {
  fontConfig: {
    fontFamily: 'SourceHanSansSC-Regular',
    fontBytes: new Uint8Array(fontBuffer),
    fontStyle: 'normal',
    fontWeight: 400,
  },
});
```

仓库内提供了一个本地示例字体文件 [`examples/SourceHanSansSC-Regular.ttf`](./examples/SourceHanSansSC-Regular.ttf)，可用于 demo 和验证脚本。

## 兼容性说明

为了便于旧项目迁移，当前引擎保留了一部分历史参数入口，但其中有少数只做“接受参数、不报错”的兼容处理：

- `onJspdfReady`
- `onJspdfFinish`
- 依赖旧版 jsPDF 实例做二次修改的用法

迁移建议请参考 [docs/migration-compat.zh-CN.md](./docs/migration-compat.zh-CN.md)。

## 本地开发

### 环境要求

- Node.js 18+
- Rust 工具链
- `wasm32-unknown-unknown` target

### 常用命令

```bash
npm install
npm run build
npm test
npm run serve
```

`npm test` 会先构建 WASM，再执行 [`scripts/verify.mjs`](./scripts/verify.mjs) 中的 smoke 验证。

## 示例页面

- [`examples/index.html`](./examples/index.html)：功能型演示页
- [`examples/comparison.html`](./examples/comparison.html)：与其他前端 PDF 方案对比
- [`examples/markdown-editor.html`](./examples/markdown-editor.html)：Markdown 编辑器与实时导出示例

## 项目结构

```text
dompdf.js/
├── src/                  # TypeScript 入口与快照流水线
├── wasm/                 # Rust PDF 写入器
├── dist/                 # 发布产物
├── examples/             # 本地演示
├── docs/                 # 设计说明和迁移文档
└── scripts/              # 构建与验证脚本
```

## 参与贡献

提交 PR 前请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 安全报告

安全问题请按 [SECURITY.md](./SECURITY.md) 中的方式反馈。

## 变更记录

近期版本变化见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
