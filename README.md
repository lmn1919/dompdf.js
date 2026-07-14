# dompdf.js

[English](./README.md) | [中文](./README_CN.md)

`dompdf.js` is a pure-frontend DOM-to-PDF engine powered by Rust, WebAssembly, and TypeScript. It renders vector PDFs directly in the browser without depending on jsPDF, and is designed for long documents, editable text, custom fonts, and pagination-heavy layouts.

**Live demo:** [dompdfjs.lisky.com.cn](https://dompdfjs.lisky.com.cn)  
**Migration notes:** [docs/migration-compat.md](./docs/migration-compat.md)

## Highlights

- Rust + WASM rendering pipeline
- Vector PDF output with selectable text
- Pagination support for large documents
- Custom font embedding with Unicode text
- Header/footer rendering
- PDF compression and encryption
- Browser-only architecture, no server required

## Installation

The repository and npm package are both named `dompdf.js`.

### npm

```bash
npm install dompdf.js
```

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

## Quick Start

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

## How It Works

1. The main thread walks the DOM and records a snapshot.
2. A Web Worker receives the snapshot and prepares render data.
3. A Rust/WASM module writes PDF bytes.
4. The browser returns the result as a `Blob`.

This architecture avoids canvas screenshot bottlenecks and keeps the UI responsive during export.

## Supported Capabilities

| Capability | Status | Notes |
| --- | --- | --- |
| Pagination | Stable | Supports multi-page output and large documents |
| Text rendering | Stable | Unicode text, custom fonts, alignment, line height |
| Images | Stable | Raster images, SVG, data URLs |
| Backgrounds and borders | Stable | Background color, gradients, border radius |
| Header/footer | Stable | Object form and per-page callback form |
| Compression | Stable | Real DEFLATE compression in the WASM writer |
| Encryption | Stable | User/owner password and permission flags |
| Legacy jsPDF hooks | Compatibility only | `onJspdfReady` / `onJspdfFinish` are accepted but are no-ops |

## Pagination Notes

Enable pagination with `pagination: true`. For best results, set the DOM container width to match the target page width in CSS pixels. A4 width at 96 DPI is `794px`.

See [page_sizes.md](./page_sizes.md) for common page sizes and pixel references.

```js
await dompdf(document.querySelector('#capture'), {
  pagination: true,
  format: 'a4',
  pageConfig: {
    header: {
      content: 'Document Header',
      height: 50,
      contentFontSize: 12,
      contentPosition: 'center',
    },
    footer: {
      content: 'Page ${currentPage} / ${totalPages}',
      height: 50,
      contentFontSize: 12,
      contentPosition: 'center',
    },
  },
});
```

### Fine-grained page control

- `divisionDisable`: keep a block together on one page
- `pageBreak`: force a new page before an element
- `excludePage` / `excludePages`: skip header/footer on selected pages

## Font Configuration

For non-Latin text, embed a font explicitly.

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

The repo ships an example font file at [`examples/SourceHanSansSC-Regular.ttf`](./examples/SourceHanSansSC-Regular.ttf) for local demos and verification.

## Important Compatibility Notes

This project intentionally keeps a small set of legacy options for upgrade compatibility. A few of them are accepted but not implemented in the new rendering architecture:

- `onJspdfReady`
- `onJspdfFinish`
- jsPDF instance mutation patterns from the legacy pipeline

See [docs/migration-compat.md](./docs/migration-compat.md) for migration guidance.

## Local Development

### Requirements

- Node.js 18+
- Rust toolchain
- `wasm32-unknown-unknown` target

### Common commands

```bash
npm install
npm run build
npm test
npm run serve
```

`npm test` builds the WASM module and runs the smoke verification script in [`scripts/verify.mjs`](./scripts/verify.mjs).

## Examples

- [`examples/index.html`](./examples/index.html): feature-focused playground
- [`examples/comparison.html`](./examples/comparison.html): compare dompdf.js with other client-side generators
- [`examples/markdown-editor.html`](./examples/markdown-editor.html): Markdown editor with live preview and PDF export

## Project Structure

```text
dompdf.js/
├── src/                  # TypeScript entry and snapshot pipeline
├── wasm/                 # Rust PDF writer
├── dist/                 # Published build output
├── examples/             # Local demos
├── docs/                 # Design notes and migration docs
└── scripts/              # Build and verification scripts
```

## Contributing

Please read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Security

Please report vulnerabilities according to [SECURITY.md](./SECURITY.md).

## Changelog

Recent project changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## License

This project is licensed under the [MIT License](./LICENSE).
