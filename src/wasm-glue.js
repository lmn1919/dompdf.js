/**
 * Hand-written JS glue for the dependency-free WASM module (no wasm-bindgen).
 *
 * WASM 二进制已内联为 base64（见 wasm-base64.ts），运行时通过 base64 解码 +
 * WebAssembly.instantiate 加载，无需 fetch 外部 .wasm 文件。
 * 这样打包后的 JS 库是单文件，可直接通过 CDN/UMD 引入。
 */
import { WASM_BASE64, WASM_BYTE_LENGTH } from './wasm-base64';
let instance = null;
let initPromise = null;
function exports() {
    if (!instance)
        throw new Error('wasm not initialized');
    return instance.exports;
}
/** base64 -> Uint8Array（浏览器和 Node 都可用，不依赖 atob 之外 API）。 */
export function decodeBase64(b64, len) {
    // 浏览器有 atob；Node 在 16+ 也支持，作为兜底用 Buffer（类型用 any 规避 @types/node 依赖）。
    let bin;
    if (typeof atob === 'function') {
        bin = atob(b64);
    }
    else {
        const g = globalThis;
        bin = g.Buffer.from(b64, 'base64').toString('binary');
    }
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++)
        out[i] = bin.charCodeAt(i) & 0xff;
    return out;
}
/** base64 string -> Uint8Array (length inferred from decoded content). */
export function base64ToBytes(b64) {
    let bin;
    if (typeof atob === 'function') {
        bin = atob(b64);
    }
    else {
        const g = globalThis;
        return g.Buffer.from(b64, 'base64');
    }
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i) & 0xff;
    return out;
}
export function initWasm() {
    if (instance)
        return Promise.resolve(instance);
    if (!initPromise) {
        initPromise = (async () => {
            const bytes = decodeBase64(WASM_BASE64, WASM_BYTE_LENGTH);
            // WebAssembly.instantiate(bytes, imports) 在浏览器/DOM lib 下返回
            // Promise<{ module, instance }>，但 WebWorker lib 下重载为 Promise<Instance>。
            // 用 WebAssembly.Module + WebAssembly.Instance 显式两步避免重载歧义。
            // TS 5.7+ Uint8Array.buffer 是 ArrayBufferLike，需断言为 BufferSource。
            const module = await WebAssembly.compile(bytes);
            instance = await WebAssembly.instantiate(module, {});
            return instance;
        })();
    }
    return initPromise;
}
function copyIn(wasm, data) {
    const ptr = wasm.alloc(data.length);
    new Uint8Array(wasm.memory.buffer, ptr, data.length).set(data);
    return ptr;
}
export async function renderPdf(snapshot) {
    await initWasm();
    const wasm = exports();
    const inPtr = copyIn(wasm, snapshot);
    const outPtr = wasm.render_pdf(inPtr, snapshot.length);
    const outLen = wasm.render_pdf_len();
    wasm.dealloc(inPtr, snapshot.length);
    if (outPtr === 0 || outLen === 0) {
        if (outPtr !== 0)
            wasm.free_pdf(outPtr, outLen);
        throw new Error('render_pdf failed: invalid snapshot or internal error');
    }
    // Copy out before freeing (memory may have grown during render; read fresh buffer).
    const out = new Uint8Array(outLen);
    out.set(new Uint8Array(wasm.memory.buffer, outPtr, outLen));
    wasm.free_pdf(outPtr, outLen);
    return out;
}
export async function inspectSnapshot(snapshot) {
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
export async function countPages(snapshot) {
    await initWasm();
    const wasm = exports();
    const inPtr = copyIn(wasm, snapshot);
    const total = wasm.count_pages(inPtr, snapshot.length);
    wasm.dealloc(inPtr, snapshot.length);
    return total;
}
//# sourceMappingURL=wasm-glue.js.map