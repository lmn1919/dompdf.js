# Legacy API Migration Guide

This project has moved from the old `html2canvas + jsPDF` pipeline to the new
`DOM snapshot + Worker + WASM` pipeline. To reduce upgrade friction, the public
API is being aligned with legacy `dompdf.js` step by step.

This guide summarizes the current compatibility status.

## Already aligned

These APIs are available and have working behavior in the current branch:

- `dompdf(root, options) -> Promise<Blob>`
- `fontConfig`
- `iconFont`
- `langFontConfig`
- `encryption`
- `pagination`
- `pageConfig` object form
- `pageConfig(pageNum, totalPages)` function form
- `excludePage` / `excludePages` on object-form `pageConfig`
- `pageBreak` attribute
- `divisionDisable` attribute
- `backgroundColor`
- `compress`
- `putOnlyUsedFonts`

## Signature-compatible with warnings

These options are accepted so old code does not fail at call time, but the new
engine does not provide the old behavior yet. A runtime warning is emitted.

- `onJspdfReady`
- `onJspdfFinish`
- `foreignObjectRendering`
- `allowTaint`
- `proxy`
- `imageTimeout`
- `logging`
- `cache`
- `windowWidth`
- `windowHeight`
- `scrollX`
- `scrollY`
- `x`
- `y`
- `width`
- `height`
- `scale`
- `canvas`
- `removeContainer`
- `onclone`
- `pdfFileName`
- `floatPrecision`
- `orientation`

## Requires migration

These usage patterns are tied to the old `jsPDF/html2canvas` architecture and
should be migrated to the new engine model:

- Direct mutation of a live `jsPDF` instance inside `onJspdfReady`
- Final-pass edits inside `onJspdfFinish`
- Features that depend on html2canvas clone-stage hooks
- Proxy- or canvas-driven workflows specific to the old raster pipeline

## Recommended upgrade path

1. Upgrade first and keep old options in place.
2. Watch runtime warnings to see which options are only signature-compatible.
3. Replace old `jsPDF`-specific customization with current export hooks or
   post-processing code around the generated `Blob` / bytes.
4. Prefer `fontConfig` / `langFontConfig` for multilingual text and keep
   object-form `pageConfig` for common header/footer cases.

## Notes

- The new engine generates vector-first PDFs instead of canvas-based image PDFs.
- Some old option names still exist only to avoid breaking upgrades.
- This document should be updated whenever compatibility status changes.
