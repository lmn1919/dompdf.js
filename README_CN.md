# dompdf.js

基于 TypeScript、Web Worker、Rust 和 WebAssembly 驱动的纯前端 DOM 转 PDF 引擎。

[文档](https://dompdfjs.lisky.com.cn/docs.html) | [在线演示](https://dompdfjs.lisky.com.cn/)| [pdf编辑器](https://pdfmake.lisky.com.cn/editor) | [English](./README.md)

---

## 核心特性

- **纯前端零依赖**：无需上传待导出文档或依赖后端服务器，所有 DOM 几何提取与 PDF 编译均在浏览器本地完成。
- **高清矢量排版**：输出可选择、可复制、可搜索的高保真矢量文本与路径，不采用低画质整页截图。
- **高性能架构**：通过 WebAssembly 与 Web Worker 在后台独立线程编译，500 页长文档约 2 秒即可完成导出。
- **功能完备**：支持智能多页分页、中文及自定义 TTF 字体（内置子集化压缩）、文字/图片水印、动态页眉页脚、SVG/Canvas/CSS 样式、超链接、交互式表单（AcroForm）与 PDF 安全加密。

## 安装

### npm

```bash
npm install dompdf.js
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

## 快速上手

### 生成并预览 PDF Blob

```ts
import dompdf from "dompdf.js";

const element = document.querySelector("#content");
const blob = await dompdf(element, {
  format: "a4",
  pagination: true,
  backgroundColor: "#ffffff",
});

const url = URL.createObjectURL(blob);
window.open(url, "_blank");
setTimeout(() => URL.revokeObjectURL(url), 30_000);
```

## 示例与 Demo

- **[dompdf.js Studio](https://dompdfjs.lisky.com.cn/)**：实时 HTML/CSS 编辑与 PDF 实时双栏预览工作台。
- **[文档中心](https://dompdfjs.lisky.com.cn/docs.html)**：完整双语 API 手册与代码示例。
- **[pdf编辑器](https://pdfmake.lisky.com.cn/editor)**：基于dompdf.js开发的在线PDF编辑器

## dompdf.js交流群

<img src="./assets/wechatqrcode.jpg" alt="dompdf.js 微信交流群二维码" width="300" />

## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，并至少运行：

```bash
npm test
npm run build
```

## 安全报告

安全问题请按照 [SECURITY.md](./SECURITY.md) 中的方式反馈，不要在公开 Issue 中披露尚未修复的漏洞。

## 变更记录

近期版本变化见 [CHANGELOG.md](./CHANGELOG.md)。

## 开源协议

本项目基于 [MIT License](./LICENSE) 开源。
