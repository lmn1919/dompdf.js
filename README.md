# dompdf.js

Pure-frontend DOM-to-PDF engine powered by TypeScript, Web Workers, Rust, and WebAssembly.

[Documentation](https://dompdfjs.lisky.com.cn/docs.html) | [Live Demo](https://dompdfjs.lisky.com.cn/) | [PDF Editor](https://pdfmake.lisky.com.cn/editor) | [中文文档](./README_CN.md)

---

## Features

- **Pure Frontend Zero Dependencies**: No document uploads or backend servers required. All DOM geometry extraction and PDF compilation are completed locally in the browser.
- **High-Definition Vector Typesetting**: Produces searchable, selectable, and copyable high-fidelity vector text and paths, avoiding low-quality full-page screenshots.
- **High-Performance Architecture**: Compiled on background worker threads via WebAssembly and Web Workers—a 500-page long document exports in ~2 seconds.
- **Full-Featured**: Supports smart multi-page pagination, Chinese and custom TTF fonts (with built-in subset compression), text/image watermarks, dynamic headers and footers, SVG/Canvas/CSS styling, hyperlinks, interactive forms (AcroForm), and PDF security encryption.

## Installation

### npm

```bash
npm install dompdf.js
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

## Quick Start

### Generate and Preview PDF Blob

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

## Documentation

Comprehensive bilingual interactive documentation and detailed API references have been migrated to the standalone docs page:

- **Online Documentation:** [https://dompdfjs.lisky.com.cn/docs.html](https://dompdfjs.lisky.com.cn/docs.html)

Covered topics:

- Full export configuration options and API reference
- Page sizes, margins, custom dimensions, and advanced pagination controls
- Header and footer templates with dynamic page-number placeholders
- Text and image watermarks (opacity, layering, rotation, and per-page control)
- Unicode multilingual support, custom TTF font loading, and font subsetting
- Interactive forms (AcroForm) and static form exports
- PDF encryption (user/owner passwords, permissions)
- SVG, Canvas, advanced CSS effects, and cross-origin images
- Export progress callbacks and low-level Snapshot APIs

## Examples & Demos

- **[dompdf.js Studio](https://dompdfjs.lisky.com.cn/)**: Live HTML/CSS editing and real-time dual-pane PDF preview workbench.
- **[Documentation Center](https://dompdfjs.lisky.com.cn/docs.html)**: Comprehensive bilingual API manual and code examples.
- **[PDF Editor](https://pdfmake.lisky.com.cn/editor)**: Online PDF editor powered by dompdf.js.

## Community

<img src="./assets/wechatqrcode.jpg" alt="dompdf.js WeChat Community QR Code" width="300" />

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a PR, and run at least:

```bash
npm test
npm run build
```

## Security

Please report security issues according to [SECURITY.md](./SECURITY.md). Do not disclose unpatched vulnerabilities in public issues.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for recent version changes.

## License

This project is open-sourced under the [MIT License](./LICENSE).
