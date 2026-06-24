/**
 * dompdf — pure-frontend DOM-to-PDF.
 *
 * Pipeline: collectSnapshot (main thread, DOM) -> Worker -> WASM render_pdf -> PDF bytes.
 *
 * Public API mirrors dompdf.js: default export `dompdf(root, options) -> Promise<Blob>`,
 * plus named `exportPDF/renderToBytes/downloadPDF/inspect` for ergonomics.
 */
import { collectSnapshot, collectSnapshotData, encodeSnapshot, resolveRegion, resolvePerPageHFText, computePageBreaks, } from './snapshot';
// `?worker&inline` is resolved by the rollup inlineWorker plugin — the worker
// module is bundled separately and wrapped in a Blob URL, no extra chunk file.
import Dom2pdfWorker from './worker?worker&inline';
export { collectSnapshot, collectSnapshotData, encodeSnapshot, computePageBreaks, } from './snapshot';
let worker = null;
let seq = 0;
const pending = new Map();
function getWorker() {
    if (!worker) {
        worker = new Dom2pdfWorker();
        worker.onmessage = (e) => {
            const res = e.data;
            const resolve = pending.get(res.id);
            if (resolve) {
                pending.delete(res.id);
                resolve(res);
            }
        };
        worker.onerror = (e) => {
            console.error('dompdf worker error', e);
        };
    }
    return worker;
}
function callWorker(snapshot, op) {
    const id = ++seq;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        // Transfer the snapshot buffer (we don't need it on the main thread after).
        const transfer = snapshot.buffer.byteLength > 0 ? [snapshot.buffer] : [];
        getWorker().postMessage({ id, op, snapshot }, transfer);
    });
}
/**
 * Build the final snapshot bytes, handling function-form pageConfig via a
 * two-phase count_pages -> resolve -> encode flow.
 */
async function buildSnapshot(root, options) {
    const data = await collectSnapshotData(root, options);
    if (typeof options.pageConfig === 'function' && (options.pagination ?? false)) {
        // Phase 1: count pages with the sampled band heights.
        const prelim = encodeSnapshot(data, []);
        const countRes = await callWorker(prelim, 'countPages');
        if (!countRes.ok || typeof countRes.result !== 'number') {
            throw new Error(countRes.error || 'count_pages failed');
        }
        const totalPages = countRes.result;
        // Phase 2: resolve per-page HF text (JS resolves placeholders).
        const fn = options.pageConfig;
        const perPage = [];
        for (let p = 0; p < totalPages; p++) {
            const cfg = fn(p + 1, totalPages);
            if (!cfg) {
                perPage.push({ header: null, footer: null });
            }
            else {
                perPage.push({
                    header: cfg.header ? resolveRegion(cfg.header, false) : null,
                    footer: cfg.footer ? resolveRegion(cfg.footer, true) : null,
                });
            }
        }
        const resolved = resolvePerPageHFText(perPage, totalPages);
        return encodeSnapshot(data, resolved);
    }
    // Object-form / no pageConfig: placeholders resolved by Rust.
    return encodeSnapshot(data, []);
}
/** Collect a snapshot and render it to PDF bytes (off main thread). */
export async function renderToBytes(root, options) {
    const snapshot = await buildSnapshot(root, options ?? {});
    const res = await callWorker(snapshot, 'render');
    if (!res.ok || !res.result || typeof res.result === 'string') {
        throw new Error(res.error || 'render failed');
    }
    return res.result;
}
/** Render and return a Blob ready for download / preview. */
export async function exportPDF(root, options) {
    const bytes = await renderToBytes(root, options);
    const ab = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(ab).set(bytes);
    return new Blob([ab], { type: 'application/pdf' });
}
/** Trigger a browser download of the exported PDF. */
export async function downloadPDF(root, options, filename = 'export.pdf') {
    const blob = await exportPDF(root, options);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
/** Debug: return a WASM-side summary string (node/image/font/page counts). */
export async function inspect(root, options) {
    const snapshot = await buildSnapshot(root, options ?? {});
    const res = await callWorker(snapshot, 'inspect');
    if (!res.ok || typeof res.result !== 'string')
        throw new Error(res.error || 'inspect failed');
    return res.result;
}
/**
 * Default export — dompdf.js-compatible entry point.
 *
 *   dompdf(root, options) -> Promise<Blob>
 *
 * `onJspdfReady` / `onJspdfFinish` / `compress` / `encryption` are accepted for
 * API compatibility but are no-ops (this engine has no jsPDF instance and emits
 * uncompressed, unencrypted PDFs).
 */
const dompdfFn = (root, options) => exportPDF(root, options);
const dompdf = Object.assign(dompdfFn, {
    default: exportPDF,
    exportPDF,
    renderToBytes,
    downloadPDF,
    inspect,
    collectSnapshot,
    collectSnapshotData,
    encodeSnapshot,
    computePageBreaks,
});
// Browser-friendly global for direct <script> usage.
if (typeof globalThis !== 'undefined') {
    globalThis.dompdf = dompdf;
}
export default dompdf;
//# sourceMappingURL=index.js.map