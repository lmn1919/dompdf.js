/**
 * Worker entry: receives a snapshot Uint8Array, runs WASM render/inspect off the main thread.
 *
 * Consumed via `import Dom2pdfWorker from './worker?worker&inline'` — the rollup
 * inlineWorker plugin bundles this file separately and wraps it in a Blob URL.
 */
import { renderPdf, inspectSnapshot, countPages } from './wasm-glue';
self.onmessage = async (e) => {
    const { id, op, snapshot } = e.data;
    try {
        if (op === 'inspect') {
            const result = await inspectSnapshot(snapshot);
            self.postMessage({ id, ok: true, result });
        }
        else if (op === 'countPages') {
            const result = await countPages(snapshot);
            self.postMessage({ id, ok: true, result });
        }
        else {
            const result = await renderPdf(snapshot);
            self.postMessage({ id, ok: true, result }, [result.buffer]);
        }
    }
    catch (err) {
        self.postMessage({
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
};
//# sourceMappingURL=worker.js.map