# dompdf.js

[English](./README.md) | [中文](./README_CN.md)

`dompdf.js` is a pure-frontend DOM-to-PDF engine powered by TypeScript, Web Workers, Rust, and WebAssembly. It reads the layout already computed by the browser and generates primarily vector-based PDFs directly in the browser, without a server, jsPDF, or a screenshot-based PDF pipeline.

It is designed for browser-side exports that need selectable text, long-document pagination, Chinese and custom fonts, headers and footers, watermarks, forms, compression, or encryption.

In representative long-document benchmarks, `dompdf.js` can generate a 500-page PDF in about two seconds. With suitable document structure and sufficient device resources, a single export can scale to tens of thousands of pages. Actual rendering time and page limits depend on DOM complexity, image count, font size, compression settings, browser, and device performance.

**Live demo:** [dompdfjs.lisky.com.cn](https://dompdfjs.lisky.com.cn)  
**Migration notes:** [docs/migration-compat.md](./docs/migration-compat.md)

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API](#api)
- [Export Options](#export-options)
- [Pagination and Page Sizes](#pagination-and-page-sizes)
- [Headers and Footers](#headers-and-footers)
- [Watermarks](#watermarks)
- [Fonts and Multilingual Text](#fonts-and-multilingual-text)
- [Form Export](#form-export)
- [PDF Encryption](#pdf-encryption)
- [PDF Metadata](#pdf-metadata)
- [Images and Cross-Origin Resources](#images-and-cross-origin-resources)
- [Progress Reporting](#progress-reporting)
- [Compatibility and Limitations](#compatibility-and-limitations)
- [Local Development](#local-development)

## Features

- Runs entirely in the browser without uploading the document being exported
- Produces searchable, selectable vector text instead of full-page screenshots
- Uses Web Workers and WASM for PDF rendering to reduce main-thread blocking
- Optimized for large documents: about two seconds for 500 pages in representative benchmarks, with extreme workloads reaching tens of thousands of pages
- Supports both continuous single-page output and standard paginated documents
- Supports A/B/C series, Letter, Legal, Tabloid, and custom page sizes
- Supports headers, footers, page-number placeholders, and per-page configuration
- Supports text and image watermarks, under/over layering, and per-page control
- Supports Unicode, TTF fonts, font subsetting, bold, italic, icon fonts, and language-based font fallback
- Supports images, SVG, Canvas, backgrounds, borders, rounded corners, shadows, opacity, gradients, and other common visual effects
- Preserves hyperlinks as PDF link annotations
- Supports static form appearance and interactive PDF AcroForm fields
- Supports DEFLATE compression, user and owner passwords, and PDF permission flags
- Provides `Blob`, `Uint8Array`, direct-download, and low-level snapshot APIs
- Includes TypeScript declarations

> `dompdf.js` reconstructs the page from geometry already computed by the browser, so CSS layout remains the browser's responsibility. The PDF renderer preserves common visual effects where possible, but it is not a complete browser rendering engine. Complex filters, animations, video, and some advanced CSS may be rasterized or degraded.

## Installation

### npm

```bash
npm install dompdf.js
```

The runtime requires a modern browser with Web Workers, WebAssembly, `Blob`, and related Web APIs. The package requires Node.js 18+ for installation, builds, and development, but its export APIs depend on the DOM and cannot be called directly in a plain Node.js environment.

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

When loaded through a `<script>` tag, the API is exposed globally as `dompdf`.

## Quick Start

### Get a PDF Blob

The default export returns a `Promise<Blob>`:

```ts
import dompdf from 'dompdf.js';

const element = document.querySelector<HTMLElement>('#capture');
if (!element) throw new Error('Could not find #capture');

const blob = await dompdf(element, {
  format: 'a4',
  pagination: true,
  backgroundColor: '#ffffff',
});

const url = URL.createObjectURL(blob);
window.open(url, '_blank');

// Revoke the URL after the preview has had time to load.
setTimeout(() => URL.revokeObjectURL(url), 30_000);
```

### Download Directly

```ts
import { downloadPDF } from 'dompdf.js';

const element = document.querySelector<HTMLElement>('#capture');
if (element) {
  await downloadPDF(element, {
    format: 'a4',
    pagination: true,
    compress: true,
  }, 'report.pdf');
}
```

### CDN Usage

```html
<button id="export">Export PDF</button>
<section id="capture">Content to export</section>

<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
<script>
  document.querySelector('#export').addEventListener('click', async () => {
    await dompdf.downloadPDF(
      document.querySelector('#capture'),
      { format: 'a4', pagination: true },
      'example.pdf',
    );
  });
</script>
```

## API

### `dompdf(root, options?)`

The default export and simplest entry point. It behaves the same as `exportPDF`.

```ts
function dompdf(
  root: HTMLElement,
  options?: ExportOptions,
): Promise<Blob>;
```

### `exportPDF(root, options?)`

Collects the DOM, generates the PDF, and returns a `Blob` with the MIME type `application/pdf`. Use it for previews, uploads, or a custom download flow.

```ts
import { exportPDF } from 'dompdf.js';

const blob = await exportPDF(element, options);
```

### `renderToBytes(root, options?)`

Returns the raw PDF bytes. Use it with the File System API, an upload endpoint, or another binary-processing pipeline.

```ts
import { renderToBytes } from 'dompdf.js';

const bytes: Uint8Array = await renderToBytes(element, options);
```

### `downloadPDF(root, options?, filename?)`

Generates the PDF and triggers a browser download. The default filename is `export.pdf`.

```ts
import { downloadPDF } from 'dompdf.js';

await downloadPDF(element, options, 'invoice.pdf');
```

### `inspect(root, options?)`

Returns a WASM-side snapshot summary containing node, image, font, and page counts. It is intended for diagnostics and does not create a downloadable PDF.

```ts
import { inspect } from 'dompdf.js';

console.log(await inspect(element, { pagination: true }));
```

### Advanced Snapshot APIs

The package also exports these lower-level functions:

- `collectSnapshot(root, options?) -> Promise<Uint8Array>`: collect and encode a DOM snapshot
- `collectSnapshotData(root, options?)`: return the intermediate data before encoding
- `encodeSnapshot(data, perPageHF, perPageWatermark?) -> Uint8Array`: encode intermediate data
- `computePageBreaks(root, options?) -> number[]`: calculate page-break Y coordinates relative to the root element
- `pageConfigNeedsPerPageResolution` and `watermarkNeedsPerPageResolution`: determine whether a configuration needs per-page resolution
- `resolvePerPageHF` and `resolveStaticPageConfigHF`: resolve per-page headers and footers
- `resolvePerPageWatermark` and `resolveStaticWatermarkPages`: resolve per-page watermarks

These APIs are intended for diagnostics, pagination overlays, and custom pipelines. The snapshot binary format is an internal protocol; normal application code should prefer `dompdf`, `exportPDF`, `renderToBytes`, or `downloadPDF`.

Common methods are also attached to the default export, so these forms are equivalent:

```ts
import dompdf, { renderToBytes } from 'dompdf.js';

const bytesA = await dompdf.renderToBytes(element);
const bytesB = await renderToBytes(element);
```

## Export Options

The following options have implemented behavior:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `format` | `string \| [number, number]` | `'a4'` | Page-size name or `[width, height]` in pt |
| `pageWidthPt` | `number` | From `format` | Override page width directly |
| `pageHeightPt` | `number` | From `format` | Override page height directly |
| `marginPt` | `number \| [top, right, bottom, left]` | `0` | PDF margins in pt |
| `pagination` | `boolean` | `false` | Paginate using the configured page height |
| `backgroundColor` | `string \| null` | `null` | Page background; `null` means transparent |
| `precision` | `number` | `2` | Decimal places retained for PDF coordinates |
| `compress` | `boolean` | `false` | Compress PDF streams with DEFLATE |
| `jpegQuality` | `number` | `0.85` | JPEG quality used when converting images |
| `useCORS` | `boolean` | `false` | Load cross-origin images with anonymous CORS |
| `ignoreElements` | `(element) => boolean` | None | Skip an element and its content when it returns `true` |
| `fontConfig` | `FontConfig \| FontConfig[]` | None | Register custom fonts |
| `langFontConfig` | `FontConfig[]` | None | Configure Unicode-range font fallback |
| `pageConfig` | Object or per-page function | See below | Header and footer configuration |
| `watermark` | Object or per-page function | None | Text or image watermark |
| `form` | `boolean \| FormOptions` | Static mode | Form-control export behavior |
| `encryption` | `PdfEncryptionOptions` | None | PDF passwords and permissions |
| `metadata` | `PdfMetadataOptions` | None | PDF document properties (Info dictionary) |
| `onProgress` | `(progress) => void` | None | Export progress callback |

See [`src/snapshot.ts`](./src/snapshot.ts) and the published package's `dist/types` directory for the complete TypeScript definitions.

## Pagination and Page Sizes

### Continuous and Paginated Modes

- `pagination: false`: create one content-driven continuous page, useful for receipts, screenshot replacement, and continuous documents
- `pagination: true`: create a multi-page PDF using the available area left by the page size, margins, header, and footer

```ts
await dompdf(element, {
  format: 'a4',
  pagination: true,
  marginPt: [36, 36, 36, 36],
});
```

For stable pagination, keep the export container's CSS width close to the target page's content width. A4 is approximately `794px x 1123px` at 96 DPI; configured margins must be subtracted from that width.

See [page_sizes.md](./page_sizes.md) for common dimensions. Supported names include:

- `a0` through `a10`
- `b0` through `b10`
- `c0` through `c10`
- `letter` and `government-letter`
- `legal`, `junior-legal`, and `government-legal`
- `tabloid` and `ledger`

For landscape A4, swap the dimensions explicitly:

```ts
await dompdf(element, {
  format: [842.25, 595.5],
  pagination: true,
});
```

You can also override `format` with `pageWidthPt` and `pageHeightPt`. The `orientation` option is currently retained only for legacy compatibility and does not swap the page dimensions automatically.

### Forced Breaks and Avoiding Splits

Add a `pageBreak` attribute to request a page break before an element:

```html
<section>First-page content</section>
<section pageBreak>Start on a new page</section>
```

Add a `divisionDisable` attribute to keep an element on one page where possible:

```html
<article divisionDisable>
  This block will be kept together when possible.
</article>
```

An element taller than the entire available page area may still be split so that the content remains placeable.

## Headers and Footers

### Static Configuration

```ts
await dompdf(element, {
  pagination: true,
  pageConfig: {
    excludePages: [1],
    header: {
      content: 'Quarterly Operations Report',
      height: 48,
      contentColor: '#334155',
      contentFontSize: 11,
      contentPosition: 'centerLeft',
      padding: [0, 24, 0, 24],
    },
    footer: {
      content: 'Page ${currentPage} / ${totalPages}',
      height: 48,
      contentColor: '#64748b',
      contentFontSize: 10,
      contentPosition: 'center',
      padding: [0, 24, 0, 24],
    },
  },
});
```

`content` supports these placeholders:

- `${currentPage}`: current page number, starting at 1
- `${totalPages}`: total number of pages

`contentPosition` supports:

- `center`, `centerLeft`, and `centerRight`
- `centerTop` and `centerBottom`
- `leftTop` and `leftBottom`
- `rightTop` and `rightBottom`
- `[x, y]` for custom coordinates

`padding` uses the order `[top, right, bottom, left]`. `excludePage` accepts one page number or an array, while `excludePages` accepts an array of page numbers.

When pagination is enabled without an explicit `pageConfig`, the current version reserves an empty `50px` header band and renders `${currentPage}/${totalPages}` in a `50px` footer. Pass `pageConfig` explicitly when you need full control.

### Slots (Phase 1)

`header` / `footer` now support `slots`, so you can place multiple text blocks inside the same region and control font, color, and position per slot:

```ts
await dompdf(element, {
  pagination: true,
  pageConfig: {
    header: {
      height: 48,
      padding: [8, 24, 0, 24],
      slots: [
        {
          content: 'Quarterly Business Review',
          position: 'leftTop',
          color: '#334155',
          fontSize: 11,
          fontFamily: 'Source Han Sans SC',
          fontWeight: 700,
        },
        {
          content: 'Page ${currentPage} / ${totalPages}',
          position: { x: '100%', y: 0, anchor: 'rightTop' },
          color: '#64748b',
          fontSize: 10,
        },
      ],
    },
  },
});
```

Notes:

- `slots` take precedence over legacy `content / contentPosition`
- `position` supports both semantic presets and coordinate objects
- Coordinate objects use the header/footer inner box top-left as the origin; `x/y` accept numbers, `'50%'`, and `'100%-24'`
- `anchor` defaults to `leftTop`

Available slot fields:

- `content`: text content, with `${currentPage}` / `${totalPages}` placeholders
- `position`: a semantic preset or `{ x, y, anchor }`
- `color`: text color
- `fontSize`: font size in px
- `fontFamily`: font family name; pair it with a registered font in `fontConfig`
- `fontWeight`: font weight
- `italic`: whether italic styling is enabled

Coordinate examples:

```ts
slots: [
  {
    content: 'Top-left title',
    position: 'leftTop',
  },
  {
    content: 'Top-right page number',
    position: { x: '100%', y: 0, anchor: 'rightTop' },
  },
  {
    content: 'Bottom-right note',
    position: { x: '100%-24', y: '100%-10', anchor: 'rightBottom' },
  },
]
```

In this model:

- `x: '100%'` targets the right edge of the inner region
- `x: '100%-24'` moves `24px` left from that edge
- `y: '100%-10'` moves `10px` upward from the bottom edge of the inner region
- `anchor` defines which point of the text box is aligned to the coordinate

### Per-Page Configuration

The function form is called for every page after the total page count is known. Return `null` to disable the header and footer for a page:

```ts
await dompdf(element, {
  pagination: true,
  pageConfig(pageNum, totalPages) {
    if (pageNum === 1) return null;

    return {
      header: {
        content: 'Internal Use Only',
        height: 40,
        contentPosition: 'rightTop',
      },
      footer: {
        content: `${pageNum} / ${totalPages}`,
        height: 40,
        contentPosition: 'center',
      },
    };
  },
});
```

The function signature accepted by `PageRegionConfig.content` is a legacy compatibility entry point and does not receive an operable PDF renderer. For dynamic content, use `pageConfig(pageNum, totalPages)` and return string content.

## Watermarks

### Text Watermarks

```ts
await dompdf(element, {
  pagination: true,
  watermark: {
    text: 'INTERNAL ${currentPage}/${totalPages}',
    color: 'rgba(185, 28, 28, 0.14)',
    fontFamily: 'Helvetica',
    fontSize: 28,
    fontWeight: 700,
    angle: -35,
    spacing: [180, 130],
    offset: [40, 40],
    layer: 'under',
    excludePages: [1],
  },
});
```

Text-watermark defaults include angle `35`, font size `28px`, color `rgba(0, 0, 0, 0.12)`, spacing `[160, 120]`, offset `[36, 36]`, and layer `under`.

### Image Watermarks

```ts
await dompdf(element, {
  pagination: true,
  useCORS: true,
  watermark: {
    imageUrl: '/assets/company-mark.png',
    imageWidth: 120,
    opacity: 0.1,
    angle: -30,
    spacing: [220, 160],
    layer: 'over',
  },
});
```

Image watermarks support `imageWidth`, `imageHeight`, and `opacity`. If only width or height is supplied, the other dimension is calculated from the source aspect ratio.

### Per-Page Watermarks

```ts
await dompdf(element, {
  pagination: true,
  watermark(pageNum) {
    if (pageNum === 1) return null;
    return {
      text: pageNum % 2 === 0 ? 'EVEN PAGE' : 'ODD PAGE',
      color: 'rgba(30, 64, 175, 0.12)',
      layer: 'under',
    };
  },
});
```

## Fonts and Multilingual Text

For non-Latin text, explicitly embed a TTF font. The most reliable approach is to load the font first and pass it through `fontBytes`:

```ts
import dompdf from 'dompdf.js';

const fontBuffer = await fetch('/fonts/SourceHanSansSC-Regular.ttf').then((response) => {
  if (!response.ok) throw new Error(`Font request failed: ${response.status}`);
  return response.arrayBuffer();
});

await dompdf(element, {
  fontConfig: {
    fontFamily: 'SourceHanSansSC-Regular',
    fontBytes: new Uint8Array(fontBuffer),
    fontStyle: 'normal',
    fontWeight: 400,
  },
});
```

`fontConfig` accepts one font or an array. Its main fields are:

| Field | Description |
| --- | --- |
| `fontFamily` | Required; should match the exported element's CSS `font-family` |
| `fontBytes` | Decoded TTF bytes; recommended |
| `fontBase64` | Base64-encoded TTF data |
| `fontStyle` | `normal` or `italic` |
| `fontWeight` | A weight such as `400` or `700` |
| `iconFont` | Whether to treat the font as an icon font |

The type definition retains `fontUrl`, but the current collector does not fetch it. Load URL-based fonts yourself and pass them as a `Uint8Array`.

### Language-Based Font Fallback

`langFontConfig` selects fonts by Unicode range and can define a default fallback:

```ts
await dompdf(element, {
  langFontConfig: [
    {
      fontFamily: 'SourceHanSansSC-Regular',
      fontBytes: chineseFontBytes,
      charRange: [[0x3400, 0x9fff]],
    },
    {
      fontFamily: 'NotoSans-Regular',
      fontBytes: fallbackFontBytes,
      isDefault: true,
    },
  ],
});
```

The repository includes [`examples/SourceHanSansSC-Regular.ttf`](./examples/SourceHanSansSC-Regular.ttf) for local demos and verification. In production, verify the font's license and avoid registering duplicate copies of large complete fonts.

## Form Export

Form values are captured from the DOM state at the start of the export, rather than from the initial HTML attributes.

```ts
await dompdf(element, {
  pagination: true,
  form: {
    mode: 'hybrid',
    include: [
      'text',
      'textarea',
      'select',
      'checkbox',
      'radio',
      'date-time',
      'range',
      'color',
      'file',
      'progress',
      'meter',
    ],
  },
});
```

Modes:

- `static`: the default; preserve only the control's current visual appearance
- `interactive`: create AcroForm fields for controls with a natural PDF mapping
- `hybrid`: preserve the static appearance and add interactive fields

Current interactive-field mappings:

- Text-like `input` elements and `textarea`
- `select`
- `checkbox`
- `radio`

The following types retain a static appearance but do not produce equivalent interactive fields:

- `date`, `time`, `month`, `week`, and `datetime-local`
- `range`, `color`, and `file`
- `progress` and `meter`

`form: true` still uses the default static mode. To generate interactive fields, explicitly set `mode: 'interactive'` or `mode: 'hybrid'`.

## PDF Encryption

```ts
await dompdf(element, {
  encryption: {
    userPassword: 'reader-password',
    ownerPassword: 'owner-password',
    userPermissions: ['print', 'copy'],
  },
});
```

Available permissions:

- `print`: allow printing
- `modify`: allow modifications
- `copy`: allow copying content
- `annot-forms`: allow annotations and form filling

Unknown permission names cause an error. Whether PDF permissions are strictly enforced ultimately depends on the reader; permission flags are not a substitute for access control over sensitive data.

## PDF Metadata

Set document properties shown in the PDF reader's document info panel:

```ts
await dompdf(element, {
  metadata: {
    title: 'Quarterly Report',
    author: 'Alice',
    subject: 'Q1 summary',
    keywords: ['report', 'finance'],
    creator: 'my-app',
    producer: 'my-app',
  },
});
```

- All fields are optional; `keywords` accepts a string or a string array (arrays are joined with spaces).
- When `metadata` is provided, `producer` defaults to `dompdf.js`, and `creationDate`/`modDate` are automatically set to the export time.
- Values are written as UTF-16BE strings, so Chinese and other non-ASCII text is supported.
- When `metadata` is omitted, no Info dictionary is written and the output stays byte-compatible with previous versions.

## Images and Cross-Origin Resources

Same-origin images, data URLs, Canvas content, and readable SVGs can participate directly in an export. Cross-origin images require correct CORS response headers from the resource server:

```ts
await dompdf(element, {
  useCORS: true,
  jpegQuality: 0.9,
});
```

Notes:

- `useCORS: true` only requests images with anonymous CORS; it cannot bypass server policy
- The image server will normally need to return `Access-Control-Allow-Origin`
- Wait for images and fonts to finish loading before exporting
- Unreadable images may be skipped or degraded
- Legacy html2canvas options such as `proxy`, `allowTaint`, and `imageTimeout` do not provide their original behavior

You can wait for document fonts and images before exporting:

```ts
await document.fonts.ready;

await Promise.all(
  Array.from(element.querySelectorAll('img')).map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }),
);
```

## Progress Reporting

`onProgress` reports these stages:

- `collecting`: collecting the DOM and resources
- `countingPages`: determining the total page count for per-page headers, footers, or watermarks
- `rendering`: generating the PDF in WASM
- `done`: export completed

```ts
await dompdf(element, {
  pagination: true,
  onProgress(progress) {
    switch (progress.stage) {
      case 'collecting':
        console.log('Collecting the document');
        break;
      case 'countingPages':
        console.log(`Counting pages: ${progress.totalPages ?? '...'}`);
        break;
      case 'rendering':
        console.log(
          `Rendering: ${progress.currentPage ?? 0}/${progress.totalPages ?? '?'}`,
        );
        break;
      case 'done':
        console.log(`Export complete: ${progress.totalPages ?? 1} pages`);
        break;
    }
  },
});
```

Not every export emits a `countingPages` stage. It is used only when a configuration needs the total page count in advance.

## Compatibility and Limitations

### Browser Compatibility

The runtime depends on:

- DOM and CSSOM
- Web Workers
- WebAssembly
- `Blob` and `URL.createObjectURL`
- `TextEncoder` and `TextDecoder`

Use a recent Chromium, Firefox, or Safari release. The library cannot collect a page directly in Node.js, during server-side rendering, or inside a Worker without a DOM. Next.js, Nuxt, and other SSR applications should call the export APIs only on the client.

### Legacy Compatibility Options

The project has migrated from `html2canvas + jsPDF` to `DOM snapshot + Worker + WASM`. The following options are accepted by the types and runtime, but do not currently provide equivalent legacy behavior. Some emit a warning:

- `onJspdfReady` and `onJspdfFinish`
- `foreignObjectRendering`, `allowTaint`, `proxy`, and `imageTimeout`
- `logging` and `cache`
- `windowWidth`, `windowHeight`, `scrollX`, and `scrollY`
- `x`, `y`, `width`, `height`, and `scale`
- `canvas`, `removeContainer`, and `onclone`
- `pdfFileName`, `floatPrecision`, `orientation`, and `putOnlyUsedFonts`

`ignoreElements` does have implemented behavior and can replace some legacy clone-stage filtering. See the [migration notes](./docs/migration-compat.md) for the full migration path.

### Known Boundaries

- Animations, video, iframes, and browser-plugin content cannot be exported with their full dynamic behavior
- Some complex filters, blend modes, masks, and advanced CSS are degraded or rasterized
- Very high-resolution images and complete CJK fonts increase collection time, memory use, and PDF size
- `fontUrl` and `putOnlyUsedFonts` currently have compatibility signatures only; callers must load font URLs themselves
- The renderer callback accepted by `PageRegionConfig.content` is a compatibility signature and does not expose an operable jsPDF instance
- Code that depends on jsPDF plugins or modifies a live jsPDF instance after export must be migrated

## FAQ

### Why is Chinese text blank or rendered as boxes?

Browser fonts are not embedded into the PDF automatically. Register a TTF containing the required characters through `fontConfig.fontBytes`, and ensure the element's CSS `font-family` matches `fontFamily`.

### Why do page breaks differ from the browser preview?

Keep the export container width close to the target page's content width, and wait for fonts and images to load before exporting. Margins, headers, and footers all reduce the usable area on each page.

### How do I export a landscape page?

Use a custom `[width, height]` pair or `pageWidthPt/pageHeightPt`. Do not rely on the currently compatibility-only `orientation` option.

### Why is a cross-origin image missing from the PDF?

Set `useCORS: true` and verify that the image server permits cross-origin reads. A frontend CORS option alone cannot bypass missing server response headers.

### How can I reduce PDF size?

Enable `compress: true`, avoid images far larger than their displayed dimensions, reduce `jpegQuality` where appropriate, and register only the fonts and weights the document needs.

## How It Works

1. The main thread walks the target element and reads browser-computed layout, styles, text, images, and form state.
2. TypeScript encodes the collected result into a compact binary snapshot.
3. The snapshot is transferred to a Web Worker.
4. Rust/WASM performs pagination, font subsetting, drawing, and PDF object generation.
5. The main thread receives the PDF bytes and returns a `Uint8Array`, a `Blob`, or starts a download, depending on the API used.

This architecture avoids drawing the entire document into one Canvas and keeps the main PDF-generation work off the main thread.

## Examples

- [`examples/index.html`](./examples/index.html): comprehensive feature demo
- [`examples/comparison.html`](./examples/comparison.html): comparison with other frontend PDF approaches
- [`examples/markdown-editor.html`](./examples/markdown-editor.html): Markdown editing and live export
- [`userscript/dompdf-page-exporter.user.js`](./userscript/dompdf-page-exporter.user.js): userscript for full-page, single-node, and exclusion-based exports; see [`userscript/README.md`](./userscript/README.md) for installation

Run `npm run serve` from the repository root before opening an example. Do not open examples directly through `file://`, because browser security policies may block modules, fonts, and cross-origin resources.

## Local Development

### Requirements

- Node.js 18+
- Rust toolchain
- `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run build
npm test
npm run serve
```

Common scripts:

| Command | Purpose |
| --- | --- |
| `npm run build:wasm` | Compile the Rust/WASM module |
| `npm run build` | Build the published bundles and TypeScript declarations |
| `npm run dev` | Watch the source and rebuild continuously |
| `npm test` | Build WASM and run the PDF smoke verification |
| `npm run verify` | Same as `npm test`; run the verification script |
| `npm run serve` | Start a static server on port `8080` |

`npm test` currently runs [`scripts/verify.mjs`](./scripts/verify.mjs), which verifies basic pagination, PDF structure, images, Chinese font subsetting, opacity, and composite glyphs.

## Project Structure

```text
dompdf.js/
|-- src/                  # TypeScript API, DOM collection, Worker, and WASM bridge
|-- wasm/                 # Rust pagination, fonts, compression, encryption, and PDF writer
|-- dist/                 # Built package artifacts
|-- examples/             # Browser demos and example fonts
|-- docs/                 # Migration notes and PDF-diff documentation
`-- scripts/              # Build, verification, and PDF-diff tooling
```

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting a pull request, and run at least:

```bash
npm test
npm run build
```

## Security

Report security issues as described in [SECURITY.md](./SECURITY.md). Do not disclose an unpatched vulnerability in a public issue.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for recent version changes.

## License

This project is licensed under the [MIT License](./LICENSE).
