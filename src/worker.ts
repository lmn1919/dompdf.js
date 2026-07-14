/**
 * Worker entry: receives a snapshot Uint8Array, runs WASM render/inspect off the main thread.
 *
 * Consumed via `import Dom2pdfWorker from './worker?worker&inline'` — the rollup
 * inlineWorker plugin bundles this file separately and wraps it in a Blob URL.
 */
import type { ExportProgress } from './snapshot';
import { renderPdf, inspectSnapshot, countPages } from './wasm-glue';

interface WorkerResultMessage {
  type: 'result';
  id: number;
  ok: boolean;
  result?: Uint8Array | string | number;
  error?: string;
}

interface WorkerProgressMessage {
  type: 'progress';
  id: number;
  progress: ExportProgress;
}

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
      const message: WorkerResultMessage = { type: 'result', id, ok: true, result };
      (self as unknown as Worker).postMessage(message);
    } else if (op === 'countPages') {
      const result = await countPages(snapshot);
      const message: WorkerResultMessage = { type: 'result', id, ok: true, result };
      (self as unknown as Worker).postMessage(message);
    } else {
      const result = await renderPdf(snapshot, e.data.encryption, (progress) => {
        const message: WorkerProgressMessage = { type: 'progress', id, progress };
        (self as unknown as Worker).postMessage(message);
      });
      const message: WorkerResultMessage = { type: 'result', id, ok: true, result };
      (self as unknown as Worker).postMessage(
        message,
        [result.buffer],
      );
    }
  } catch (err) {
    const message: WorkerResultMessage = {
      type: 'result',
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    (self as unknown as Worker).postMessage(message);
  }
};
