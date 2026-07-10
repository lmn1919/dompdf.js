/**
 * dompdf — pure-frontend DOM-to-PDF.
 *
 * Pipeline: collectSnapshot (main thread, DOM) -> Worker -> WASM render_pdf -> PDF bytes.
 *
 * Public API mirrors dompdf.js: default export `dompdf(root, options) -> Promise<Blob>`,
 * plus named `exportPDF/renderToBytes/downloadPDF/inspect` for ergonomics.
 */
import {
  collectSnapshot,
  collectSnapshotData,
  encodeSnapshot,
  pageConfigNeedsPerPageResolution,
  resolveRegion,
  resolvePerPageHF,
  resolvePerPageHFText,
  resolveStaticPageConfigHF,
  computePageBreaks,
  type ExportOptions,
  type PageConfigOptions,
  type ResolvedPageHF,
} from './snapshot';
// `?worker&inline` is resolved by the rollup inlineWorker plugin — the worker
// module is bundled separately and wrapped in a Blob URL, no extra chunk file.
import Dom2pdfWorker from './worker?worker&inline';

export type { ExportOptions } from './snapshot';
export {
  collectSnapshot,
  collectSnapshotData,
  encodeSnapshot,
  computePageBreaks,
  pageConfigNeedsPerPageResolution,
  resolvePerPageHF,
  resolveStaticPageConfigHF,
} from './snapshot';
export type { FontConfig, PageConfig, PageConfigOptions, PageRegionConfig } from './snapshot';

type DompdfApi = ((
  root: HTMLElement,
  options?: ExportOptions,
) => Promise<Blob>) & {
  default: typeof exportPDF;
  exportPDF: typeof exportPDF;
  renderToBytes: typeof renderToBytes;
  downloadPDF: typeof downloadPDF;
  inspect: typeof inspect;
  collectSnapshot: typeof collectSnapshot;
  collectSnapshotData: typeof collectSnapshotData;
  encodeSnapshot: typeof encodeSnapshot;
  computePageBreaks: typeof computePageBreaks;
};

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (res: WorkerResponse) => void>();

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: Uint8Array | string | number;
  error?: string;
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Dom2pdfWorker();
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
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

function callWorker(
  snapshot: Uint8Array,
  op: 'render' | 'inspect' | 'countPages',
): Promise<WorkerResponse> {
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
async function buildSnapshot(
  root: HTMLElement,
  options: ExportOptions,
): Promise<Uint8Array> {
  const data = await collectSnapshotData(root, options);

  if (pageConfigNeedsPerPageResolution(options.pageConfig) && (options.pagination ?? false)) {
    // Phase 1: count pages with the sampled band heights.
    const prelim = encodeSnapshot(data, []);
    const countRes = await callWorker(prelim, 'countPages');
    if (!countRes.ok || typeof countRes.result !== 'number') {
      throw new Error(countRes.error || 'count_pages failed');
    }
    const totalPages = countRes.result as number;
    // Phase 2: resolve per-page HF text (JS resolves placeholders).
    let perPage: ResolvedPageHF[] = [];
    if (typeof options.pageConfig === 'function') {
      perPage = resolvePerPageHF(options.pageConfig as (p: number, t: number) => PageConfigOptions | null, totalPages);
    } else if (options.pageConfig) {
      perPage = resolveStaticPageConfigHF(options.pageConfig, totalPages);
    }
    const resolved = resolvePerPageHFText(perPage, totalPages);
    return encodeSnapshot(data, resolved);
  }

  // Object-form / no pageConfig: placeholders resolved by Rust.
  return encodeSnapshot(data, []);
}

/** Collect a snapshot and render it to PDF bytes (off main thread). */
export async function renderToBytes(
  root: HTMLElement,
  options?: ExportOptions,
): Promise<Uint8Array> {
  const snapshot = await buildSnapshot(root, options ?? {});
  const res = await callWorker(snapshot, 'render');
  if (!res.ok || !res.result || typeof res.result === 'string') {
    throw new Error(res.error || 'render failed');
  }
  return res.result as Uint8Array;
}

/** Render and return a Blob ready for download / preview. */
export async function exportPDF(
  root: HTMLElement,
  options?: ExportOptions,
): Promise<Blob> {
  const bytes = await renderToBytes(root, options);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Blob([ab], { type: 'application/pdf' });
}

/** Trigger a browser download of the exported PDF. */
export async function downloadPDF(
  root: HTMLElement,
  options?: ExportOptions,
  filename = 'export.pdf',
): Promise<void> {
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
export async function inspect(
  root: HTMLElement,
  options?: ExportOptions,
): Promise<string> {
  const snapshot = await buildSnapshot(root, options ?? {});
  const res = await callWorker(snapshot, 'inspect');
  if (!res.ok || typeof res.result !== 'string') throw new Error(res.error || 'inspect failed');
  return res.result as string;
}

/**
 * Default export - dompdf.js-compatible entry point.
 *
 *   dompdf(root, options) -> Promise<Blob>
 *
 * Legacy clone/html2canvas/jsPDF options are accepted for upgrade compatibility
 * and normalized inside `snapshot.ts`. Unsupported behaviors emit warnings
 * instead of failing hard. `onJspdfReady` / `onJspdfFinish` are still no-ops
 * because this engine has no jsPDF instance. `compress` enables real DEFLATE
 * compression of PDF streams (content streams, fonts, raw-RGB images).
 */
const dompdfFn = (root: HTMLElement, options?: ExportOptions) => exportPDF(root, options);

const dompdf: DompdfApi = Object.assign(dompdfFn, {
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
  (
    globalThis as typeof globalThis & {
      dompdf?: DompdfApi;
    }
  ).dompdf = dompdf;
}

export default dompdf;
