// End-to-end smoke test for the WASM PDF writer (no browser needed).
// Builds a Snapshot v3, calls render_pdf + count_pages, and validates the PDF.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const wasmPath = path.join(root, 'packages/dom2pdf-wasm/pkg/dom2pdf_wasm.wasm');
const wasmBytes = readFileSync(wasmPath);

// ---- minimal binary encoder (mirrors packages/dom2pdf/src/format.ts) ----
class Bin {
  constructor(cap = 1024) {
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
    this.pos = 0;
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.dv = new DataView(this.buf.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v | 0, true); this.pos += 4; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  utf8(s) { this.bytes(Buffer.from(s, 'utf8')); }
  utf8Len(s) { return Buffer.byteLength(s, 'utf8'); }
  result() { return this.buf.subarray(0, this.pos); }
}

// flag bits (match Rust snapshot.rs)
const F_BG = 0x01, F_BORDER = 0x02, F_RADIUS = 0x04, F_OVERFLOW = 0x08,
  F_OPACITY = 0x10, F_FONT = 0x20, F_IMAGE = 0x40, F_RENDER_MODE = 0x80;

function writeHF(w, hf) {
  const clen = w.utf8Len(hf.content);
  w.u16(clen); w.utf8(hf.content);
  w.f32(hf.heightPx);
  w.f32(hf.color[0]); w.f32(hf.color[1]); w.f32(hf.color[2]); w.f32(hf.color[3]);
  w.f32(hf.fontSizePx);
  w.u8(hf.position);
  if (hf.position === 9) { w.f32(hf.custom[0]); w.f32(hf.custom[1]); }
  w.f32(hf.padding[0]); w.f32(hf.padding[1]); w.f32(hf.padding[2]); w.f32(hf.padding[3]);
}
function writeOptHF(w, hf) {
  if (hf) { w.u8(1); writeHF(w, hf); } else { w.u8(0); }
}

/**
 * Build a v3 snapshot.
 * opts: { pagination, header, footer, fontBytes?, fontFamily?, chinese? }
 */
function buildSnapshot(opts = {}) {
  const w = new Bin();
  // header
  w.bytes(Buffer.from('D2P1'));
  w.u32(3); // version 3
  w.f32(595.28); // pageWidthPt
  w.f32(841.89); // pageHeightPt
  w.f32(36); w.f32(36); w.f32(36); w.f32(36); // margins

  // config block
  w.u8(2); // precision
  w.u8(opts.pagination ? 1 : 0);
  const bg = [1, 1, 1, 1];
  w.u8(opts.background ? 1 : 0);
  if (opts.background) { w.f32(bg[0]); w.f32(bg[1]); w.f32(bg[2]); w.f32(bg[3]); }
  const headerH = opts.header ? opts.header.heightPx : 0;
  const footerH = opts.footer ? opts.footer.heightPx : 0;
  w.f32(headerH); w.f32(footerH);
  const hasStatic = opts.header || opts.footer;
  w.u8(hasStatic ? 1 : 0);
  if (hasStatic) { writeOptHF(w, opts.header || null); writeOptHF(w, opts.footer || null); }

  // fonts block
  const fonts = opts.fontBytes ? [{
    family: opts.fontFamily, style: 0, weight: 400, iconFont: false, bytes: opts.fontBytes,
  }] : [];
  w.u32(fonts.length);
  for (const f of fonts) {
    w.u16(w.utf8Len(f.family)); w.utf8(f.family);
    w.u8(f.style); w.u16(f.weight); w.u8(f.iconFont ? 1 : 0);
    w.u32(f.bytes.length); w.bytes(f.bytes);
  }

  // per-page HF block (empty for object form)
  w.u32(0);

  // nodes
  const text = opts.chinese ? '你好，PDF！中文测试。' : 'Hello, PDF!';
  const tlen = w.utf8Len(text);
  w.u32(3); // nodeCount

  // node 0: box with bg
  w.u32(0); w.i32(-1); w.u8(0);
  w.f32(0); w.f32(0); w.f32(500); w.f32(60);
  w.u16(F_BG);
  w.f32(0.1); w.f32(0.2); w.f32(0.8); w.f32(1);

  // node 1: text
  w.u32(1); w.i32(0); w.u8(1);
  w.f32(10); w.f32(10); w.f32(480); w.f32(20);
  w.u16(F_FONT);
  const fam = opts.fontBytes ? opts.fontFamily : 'Helvetica';
  w.u16(w.utf8Len(fam)); w.utf8(fam);
  w.f32(16); w.u16(400); w.u8(0);
  w.f32(0); w.f32(0); w.f32(0); w.f32(1);
  w.f32(20); w.u8(0); w.f32(0); w.f32(0);
  w.u32(tlen); w.utf8(text);
  w.u32(1);
  w.f32(10); w.f32(10); w.f32(200); w.f32(20);
  w.u32(0); w.u32(tlen);

  // node 2: image
  w.u32(2); w.i32(0); w.u8(2);
  w.f32(10); w.f32(80); w.f32(100); w.f32(50);
  w.u16(F_IMAGE);
  w.u32(1); w.u8(0);

  // image 1
  w.u32(1); // imageCount
  const jpeg = Buffer.from('FAKEJPEGBYTES', 'latin1');
  w.u32(1); w.u32(100); w.u32(50); w.u32(jpeg.length); w.bytes(jpeg);

  return w.result();
}

const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const ex = instance.exports;

function render(snap) {
  const inPtr = ex.alloc(snap.length);
  new Uint8Array(ex.memory.buffer, inPtr, snap.length).set(snap);
  const outPtr = ex.render_pdf(inPtr, snap.length);
  const outLen = ex.render_pdf_len();
  ex.dealloc(inPtr, snap.length);
  if (!outPtr || !outLen) {
    const ip2 = ex.alloc(snap.length);
    new Uint8Array(ex.memory.buffer, ip2, snap.length).set(snap);
    const p2 = ex.inspect(ip2, snap.length);
    const l2 = ex.inspect_len();
    const msg = new TextDecoder().decode(new Uint8Array(ex.memory.buffer, p2, l2));
    throw new Error('render_pdf returned empty. inspect says:\n' + msg);
  }
  const pdf = new Uint8Array(ex.memory.buffer, outPtr, outLen).slice();
  ex.free_pdf(outPtr, outLen);
  return pdf;
}

function countPages(snap) {
  const inPtr = ex.alloc(snap.length);
  new Uint8Array(ex.memory.buffer, inPtr, snap.length).set(snap);
  const n = ex.count_pages(inPtr, snap.length);
  ex.dealloc(inPtr, snap.length);
  return n;
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS: ${name}`);
  } else {
    console.error(`  FAIL: ${name} ${extra}`);
    failures++;
  }
}

// ---- Test 1: paginated Latin doc with header/footer ----
console.log('Test 1: paginated Latin doc with static header/footer');
const header = {
  content: 'dom2pdf report', heightPx: 50,
  color: [0.2, 0.2, 0.2, 1], fontSizePx: 12, position: 0, custom: null, padding: [0, 24, 0, 24],
};
const footer = {
  content: 'Page ${currentPage}/${totalPages}', heightPx: 50,
  color: [0.2, 0.2, 0.2, 1], fontSizePx: 12, position: 0, custom: null, padding: [0, 24, 0, 24],
};
const snap1 = buildSnapshot({ pagination: true, background: true, header, footer });
const total1 = countPages(snap1);
check('count_pages returns >= 1', total1 >= 1, `(got ${total1})`);
const pdf1 = render(snap1);
const latin1 = Buffer.from(pdf1).toString('latin1');
check('PDF header %PDF-1.4', latin1.startsWith('%PDF-1.4'));
check('has %%EOF', latin1.includes('%%EOF'));
check('has Catalog', latin1.includes('/Type /Catalog'));
check('has Pages', latin1.includes('/Type /Pages'));
check('has Page', latin1.includes('/Type /Page'));
check('has Helvetica font', latin1.includes('/Helvetica'));
check('has startxref', latin1.includes('startxref'));
check('has Image XObject', latin1.includes('/Subtype /Image'));
check('has DCTDecode', latin1.includes('/Filter /DCTDecode'));
check('image referenced via Do', latin1.includes('/Im1 ') && latin1.includes(' Do'));
// footer placeholder resolved on page 1: "Page 1/<total>"
const footerHex = Buffer.from('Page 1/', 'latin1').toString('hex').toUpperCase();
check('footer placeholder resolved (Page 1/)', latin1.includes(footerHex), `(looked for ${footerHex})`);
// header text "dom2pdf" hex
const headerHex = Buffer.from('dom2pdf', 'latin1').toString('hex').toUpperCase();
check('header text present', latin1.includes(headerHex));

// ---- Test 2: single-page mode (pagination false) ----
console.log('Test 2: single-page mode');
const snap2 = buildSnapshot({ pagination: false });
const total2 = countPages(snap2);
check('single-page count == 1', total2 === 1, `(got ${total2})`);
const pdf2 = render(snap2);
const latin2 = Buffer.from(pdf2).toString('latin1');
// MediaBox height should be content-driven, not the full 841.89
const mbMatch = latin2.match(/\/MediaBox \[0 0 595[\.\d]* ([\d.]+)\]/);
check('single-page MediaBox height present', !!mbMatch, `(MediaBox: ${mbMatch ? mbMatch[0] : 'not found'})`);
if (mbMatch) {
  const h = parseFloat(mbMatch[1]);
  check('single-page height < full page height (content-driven)', h < 841.89, `(h=${h})`);
}

// ---- Test 3: CID font embedding (Chinese) ----
console.log('Test 3: CID font embedding with Source Han Sans');
const fontPath = path.join(root, 'apps/playground/public/SourceHanSansSC-Regular.ttf');
if (existsSync(fontPath)) {
  const fontBytes = readFileSync(fontPath);
  const fam = 'SourceHanSansSC-Regular';
  const snap3 = buildSnapshot({
    pagination: true, background: true,
    fontBytes, fontFamily: fam, chinese: true,
  });
  const total3 = countPages(snap3);
  check('chinese doc count_pages >= 1', total3 >= 1, `(got ${total3})`);
  const pdf3 = render(snap3);
  const latin3 = Buffer.from(pdf3).toString('latin1');
  check('has Type0 font', latin3.includes('/Subtype /Type0'));
  check('has CIDFontType2', latin3.includes('/Subtype /CIDFontType2'));
  check('has Identity-H encoding', latin3.includes('/Identity-H'));
  check('has CIDToGIDMap /Identity', latin3.includes('/CIDToGIDMap /Identity'));
  check('has FontFile2 (embedded TTF)', latin3.includes('/FontFile2'));
  check('has ToUnicode CMap', latin3.includes('beginbfchar'));
  check('has ToUnicode codespacerange', latin3.includes('begincodespacerange'));
  check('PDF size still grows vs Latin baseline', pdf3.length > pdf1.length + 1000,
    `(pdf3=${pdf3.length} pdf1=${pdf1.length})`);
  check('subset font is far smaller than raw TTF', pdf3.length < fontBytes.length / 20,
    `(pdf3=${pdf3.length} font=${fontBytes.length})`);
  console.log(`  info: chinese PDF = ${pdf3.length} bytes (subset from ${fontBytes.length} bytes TTF)`);
} else {
  console.log('  SKIP: Source Han font not found at', fontPath);
}

console.log('');
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.error(`${failures} FAILURE(S)`);
  process.exit(1);
}
