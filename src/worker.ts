/**
 * Worker entry: receives a snapshot Uint8Array, runs WASM render/inspect off the main thread.
 *
 * Consumed via `import Dom2pdfWorker from './worker?worker&inline'` — the rollup
 * inlineWorker plugin bundles this file separately and wraps it in a Blob URL.
 */
import { renderPdf, inspectSnapshot, countPages } from './wasm-glue';

self.onmessage = async (e: MessageEvent) => {
  const { id, op, snapshot } = e.data as {
    encryption?: Uint8Array;
    id: number;
    op: 'render' | 'inspect' | 'countPages';
    snapshot: Uint8Array;
  };
  try {
    if (op === 'inspect') {
      const result = await inspectSnapshot(snapshot);
      (self as unknown as Worker).postMessage({ id, ok: true, result });
    } else if (op === 'countPages') {
      const result = await countPages(snapshot);
      (self as unknown as Worker).postMessage({ id, ok: true, result });
    } else {
      const result = await renderPdf(snapshot, e.data.encryption);
      (self as unknown as Worker).postMessage(
        { id, ok: true, result },
        [result.buffer],
      );
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
