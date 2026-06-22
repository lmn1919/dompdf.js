/**
 * Worker: receives a snapshot Uint8Array, runs WASM render/inspect off the main thread.
 *
 * 此文件会被字符串化内联到主包中（见 worker-inline.ts），
 * 这样 Vite 库模式构建后的 JS 包不依赖额外的 chunk 文件。
 */
import { renderPdf, inspectSnapshot, countPages } from './wasm-glue';

self.onmessage = async (e: MessageEvent) => {
  const { id, op, snapshot } = e.data as {
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
      const result = await renderPdf(snapshot);
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

// 标记此模块为 worker 入口，Vite 会以 `?worker&inline` 方式打包。
export {};
