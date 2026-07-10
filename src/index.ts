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
  watermarkNeedsPerPageResolution,
  resolveRegion,
  resolvePerPageHF,
  resolvePerPageHFText,
  resolvePerPageWatermark,
  resolvePerPageWatermarkText,
  resolveStaticPageConfigHF,
  resolveStaticWatermarkPages,
  computePageBreaks,
  type ExportOptions,
  type PageConfigOptions,
  type ResolvedPageHF,
  type ResolvedPageWatermark,
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
  watermarkNeedsPerPageResolution,
  resolvePerPageHF,
  resolveStaticPageConfigHF,
  resolvePerPageWatermark,
  resolveStaticWatermarkPages,
} from './snapshot';
export type {
  FontConfig,
  PageConfig,
  PageConfigOptions,
  PageRegionConfig,
  WatermarkConfig,
  WatermarkOptions,
} from './snapshot';

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
  const pagination = options.pagination ?? false;
  const needsPerPageHF = pageConfigNeedsPerPageResolution(options.pageConfig);
  const needsPerPageWatermark = watermarkNeedsPerPageResolution(options.watermark);

  if (!needsPerPageHF && !needsPerPageWatermark) {
    return encodeSnapshot(data, []);
  }

  let totalPages = 1;
  if (pagination) {
    // Phase 1: count pages with the sampled band heights.
    const prelim = encodeSnapshot(data, [], []);
    const countRes = await callWorker(prelim, 'countPages');
    if (!countRes.ok || typeof countRes.result !== 'number') {
      throw new Error(countRes.error || 'count_pages failed');
    }
    totalPages = countRes.result as number;
  }

  // Phase 2: resolve per-page HF / watermark text (JS resolves placeholders).
  let perPageHF: ResolvedPageHF[] = [];
  if (needsPerPageHF) {
    if (typeof options.pageConfig === 'function') {
      perPageHF = resolvePerPageHF(options.pageConfig as (p: number, t: number) => PageConfigOptions | null, totalPages);
    } else if (options.pageConfig) {
      perPageHF = resolveStaticPageConfigHF(options.pageConfig, totalPages);
    }
    perPageHF = resolvePerPageHFText(perPageHF, totalPages);
  }

  let perPageWatermark: (import('./snapshot').ResolvedWatermark | null)[] = [];
  if (needsPerPageWatermark) {
    let resolved: ResolvedPageWatermark[] = [];
    const watermarkImageCache = new Map<string, { imageId: number; width: number; height: number }>();
    if (typeof options.watermark === 'function') {
      resolved = await resolvePerPageWatermark(options.watermark, totalPages, data.images, watermarkImageCache);
    } else if (options.watermark) {
      resolved = await resolveStaticWatermarkPages(options.watermark, totalPages, data.images, watermarkImageCache);
    }
    perPageWatermark = resolvePerPageWatermarkText(resolved, totalPages);
  }

  return encodeSnapshot(data, perPageHF, perPageWatermark);
}

/** Collect a snapshot and render it to PDF bytes (off main thread). */
export async function renderToBytes(
  root: HTMLElement,
  options?: ExportOptions,
): Promise<Uint8Array> {
  const resolvedOptions = options ?? {};
  const snapshot = await buildSnapshot(root, resolvedOptions);
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
