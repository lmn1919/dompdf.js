/**
 * Hand-written JS glue for the dependency-free WASM module (no wasm-bindgen).
 *
 * WASM 二进制已内联为 base64（见 wasm-base64.ts），运行时通过 base64 解码 +
 * WebAssembly.instantiate 加载，无需 fetch 外部 .wasm 文件。
 * 这样打包后的 JS 库是单文件，可直接通过 CDN/UMD 引入。
 */
import { WASM_BASE64, WASM_BYTE_LENGTH } from './wasm-base64';
import type { ExportProgress } from './snapshot';

export interface WasmExports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  dealloc(ptr: number, n: number): void;
  render_pdf(ptr: number, len: number): number;
  render_pdf_encrypted(ptr: number, len: number, encPtr: number, encLen: number): number;
  render_pdf_len(): number;
  free_pdf(ptr: number, len: number): void;
  count_pages(ptr: number, len: number): number;
  inspect(ptr: number, len: number): number;
  inspect_len(): number;
}

let instance: WebAssembly.Instance | null = null;
let initPromise: Promise<WebAssembly.Instance> | null = null;
let activeProgressReporter: ((progress: ExportProgress) => void) | null = null;

function exports(): WasmExports {
  if (!instance) throw new Error('wasm not initialized');
  return instance.exports as unknown as WasmExports;
}

/** base64 -> Uint8Array（浏览器和 Node 都可用，不依赖 atob 之外 API）。 */
export function decodeBase64(b64: string, len: number): Uint8Array {
  // 浏览器有 atob；Node 在 16+ 也支持，作为兜底用 Buffer（类型用 any 规避 @types/node 依赖）。
  let bin: string;
  if (typeof atob === 'function') {
    bin = atob(b64);
  } else {
    const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } };
    bin = g.Buffer!.from(b64, 'base64').toString('binary');
  }
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/** base64 string -> Uint8Array (length inferred from decoded content). */
export function base64ToBytes(b64: string): Uint8Array {
  let bin: string;
  if (typeof atob === 'function') {
    bin = atob(b64);
  } else {
    const g = globalThis as unknown as { Buffer?: { from(s: string, enc: string): Uint8Array } };
    return g.Buffer!.from(b64, 'base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

export function initWasm(): Promise<WebAssembly.Instance> {
  if (instance) return Promise.resolve(instance);
  if (!initPromise) {
    initPromise = (async () => {
      const bytes = decodeBase64(WASM_BASE64, WASM_BYTE_LENGTH);
      // WebAssembly.instantiate(bytes, imports) 在浏览器/DOM lib 下返回
      // Promise<{ module, instance }>，但 WebWorker lib 下重载为 Promise<Instance>。
      // 用 WebAssembly.Module + WebAssembly.Instance 显式两步避免重载歧义。
      // TS 5.7+ Uint8Array.buffer 是 ArrayBufferLike，需断言为 BufferSource。
      const module = await WebAssembly.compile(bytes as unknown as BufferSource);
      instance = await WebAssembly.instantiate(module, {
        env: {
          report_progress(currentPage: number, totalPages: number): void {
            if (!activeProgressReporter) return;
            activeProgressReporter({
              stage: 'rendering',
              currentPage: Math.max(1, Math.trunc(currentPage)),
              totalPages: Math.max(1, Math.trunc(totalPages)),
            });
          },
        },
      });
      return instance;
    })();
  }
  return initPromise;
}

function copyIn(wasm: WasmExports, data: Uint8Array): number {
  const ptr = wasm.alloc(data.length);
  new Uint8Array(wasm.memory.buffer, ptr, data.length).set(data);
  return ptr;
}

export async function renderPdf(
  snapshot: Uint8Array,
  encryption?: Uint8Array,
  onProgress?: (progress: ExportProgress) => void,
): Promise<Uint8Array> {
  await initWasm();
  const wasm = exports();
  const inPtr = copyIn(wasm, snapshot);
  const encPtr = encryption ? copyIn(wasm, encryption) : 0;
  const encLen = encryption?.length ?? 0;
  activeProgressReporter = onProgress ?? null;
  try {
    const outPtr = encryption
      ? wasm.render_pdf_encrypted(inPtr, snapshot.length, encPtr, encLen)
      : wasm.render_pdf(inPtr, snapshot.length);
    const outLen = wasm.render_pdf_len();
    if (outPtr === 0 || outLen === 0) {
      if (outPtr !== 0) wasm.free_pdf(outPtr, outLen);
      throw new Error('render_pdf failed: invalid snapshot or internal error');
    }
    // Copy out before freeing (memory may have grown during render; read fresh buffer).
    const out = new Uint8Array(outLen);
    out.set(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
    wasm.free_pdf(outPtr, outLen);
    return out;
  } finally {
    activeProgressReporter = null;
    wasm.dealloc(inPtr, snapshot.length);
    if (encPtr !== 0) wasm.dealloc(encPtr, encLen);
  }
}

export async function inspectSnapshot(snapshot: Uint8Array): Promise<string> {
  await initWasm();
  const wasm = exports();
  const inPtr = copyIn(wasm, snapshot);
  const ptr = wasm.inspect(inPtr, snapshot.length);
  const len = wasm.inspect_len();
  wasm.dealloc(inPtr, snapshot.length);
  const bytes = new Uint8Array(wasm.memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

/** Count pages for a snapshot (function-form pageConfig needs totalPages). */
export async function countPages(snapshot: Uint8Array): Promise<number> {
  await initWasm();
  const wasm = exports();
  const inPtr = copyIn(wasm, snapshot);
  const total = wasm.count_pages(inPtr, snapshot.length);
  wasm.dealloc(inPtr, snapshot.length);
  return total;
}
