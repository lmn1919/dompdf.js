/**
 * 诊断脚本：模拟 playground 三种模板 (report / demo1 / interactive) 的快照 → 生成 PDF → 解析 PDF 内容流
 * 打印每个绘制操作，与预期对比，找出差异。
 *
 * 运行：node scripts/diagnose.mjs
 *
 * Binary Snapshot v3 格式必须匹配 wasm/src/snapshot.rs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '../wasm/pkg/dom2pdf_wasm.wasm');
const fontPath = resolve(__dirname, '../examples/SourceHanSansSC-Regular.ttf');
const sharedFontBytes = new Uint8Array(readFileSync(fontPath));
const sharedFonts = [{
  family: 'SourceHanSansSC-Regular',
  style: 0,
  weight: 400,
  iconFont: false,
  bytes: sharedFontBytes,
}];

// ---- BinWriter (mirror of src/format.ts) ----
class BinWriter {
  constructor(size = 4096) {
    this.pos = 0;
    this.buf = new Uint8Array(size);
    this.dv = new DataView(this.buf.buffer);
  }
  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let v = this.buf.length;
    while (v < this.pos + n) v *= 2;
    const nbuf = new Uint8Array(v);
    nbuf.set(this.buf);
    this.buf = nbuf;
    this.dv = new DataView(this.buf.buffer);
  }
  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; }
  u16(v) { this.ensure(2); this.dv.setUint16(this.pos, v, true); this.pos += 2; }
  u32(v) { this.ensure(4); this.dv.setUint32(this.pos, v >>> 0, true); this.pos += 4; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.pos, v | 0, true); this.pos += 4; }
  f32(v) { this.ensure(4); this.dv.setFloat32(this.pos, v, true); this.pos += 4; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.pos); this.pos += b.length; }
  utf8(s) { this.bytes(Buffer.from(s, 'utf8')); }
  static utf8Len(s) { return Buffer.byteLength(s, 'utf8'); }
  result() { return this.buf.subarray(0, this.pos); }
}

// ---- WASM loader ----
const wasmBytes = readFileSync(wasmPath);
const wasmModule = await WebAssembly.compile(wasmBytes);
const instance = await WebAssembly.instantiate(wasmModule, {});
const ex = instance.exports;

function renderPdf(snapshot) {
  const inPtr = ex.alloc(snapshot.length);
  new Uint8Array(ex.memory.buffer, inPtr, snapshot.length).set(snapshot);
  const outPtr = ex.render_pdf(inPtr, snapshot.length);
  const outLen = ex.render_pdf_len();
  ex.dealloc(inPtr, snapshot.length);
  if (outPtr === 0 || outLen === 0) {
    if (outPtr !== 0) ex.free_pdf(outPtr, outLen);
    throw new Error('render_pdf failed');
  }
  const out = new Uint8Array(outLen);
  out.set(new Uint8Array(ex.memory.buffer, outPtr, outLen));
  ex.free_pdf(outPtr, outLen);
  return out;
}

function inspectSnapshot(snapshot) {
  const inPtr = ex.alloc(snapshot.length);
  new Uint8Array(ex.memory.buffer, inPtr, snapshot.length).set(snapshot);
  const ptr = ex.inspect(inPtr, snapshot.length);
  const len = ex.inspect_len();
  ex.dealloc(inPtr, snapshot.length);
  const bytes = new Uint8Array(ex.memory.buffer, ptr, len);
  return new TextDecoder().decode(bytes);
}

// ---- HFSpec writer (matches snapshot.rs writeOptHF / parse_opt_hf) ----
// HFSpec: present u8 ; if present: contentLen u16 + utf8 ; heightPx f32 ;
//         color[4] f32 ; fontSizePx f32 ; position u8 ;
//         if position==9: customX f32 customY f32 ; padding[4] f32
function writeOptHF(w, hf) {
  if (!hf) { w.u8(0); return; }
  w.u8(1);
  const clen = BinWriter.utf8Len(hf.content);
  w.u16(clen);
  w.utf8(hf.content);
  w.f32(hf.heightPx);
  w.f32(hf.color[0]); w.f32(hf.color[1]); w.f32(hf.color[2]); w.f32(hf.color[3]);
  w.f32(hf.fontSizePx);
  w.u8(hf.position);
  if (hf.position === 9) { w.f32(hf.custom[0]); w.f32(hf.custom[1]); }
  w.f32(hf.padding[0]); w.f32(hf.padding[1]); w.f32(hf.padding[2]); w.f32(hf.padding[3]);
}

// ---- Node flag constants (must match snapshot.rs) ----
const F_BG = 0x01, F_BORDER = 0x02, F_RADIUS = 0x04, F_OVERFLOW = 0x08;
const F_OPACITY = 0x10, F_FONT = 0x20, F_IMAGE = 0x40, F_RENDER_MODE = 0x80;
const F_DIVISION_DISABLE = 0x100, F_PAGE_BREAK = 0x200;

// ---- Minimal 1x1 JPEG for image nodes ----
const MIN_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
  0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
  0x00, 0x00, 0x3f, 0x00, 0x7b, 0x40, 0x1b, 0xff, 0xd9,
]);

// ---- Snapshot v3 encoder ----
function encodeSnapshot(opts) {
  const w = new BinWriter();
  // Header
  w.bytes(Buffer.from([0x44, 0x32, 0x50, 0x31])); // "D2P1"
  w.u32(3); // version 3
  w.f32(opts.pageWidthPt); w.f32(opts.pageHeightPt);
  w.f32(opts.mTop); w.f32(opts.mRight); w.f32(opts.mBottom); w.f32(opts.mLeft);

  // Config block
  w.u8(opts.precision ?? 2);        // precision
  w.u8(opts.pagination ? 1 : 0);    // pagination
  const bg = opts.backgroundColor ?? null;
  w.u8(bg ? 1 : 0);                 // hasBackground
  if (bg) { w.f32(bg[0]); w.f32(bg[1]); w.f32(bg[2]); w.f32(bg[3]); }
  w.f32(opts.headerHPx ?? 0);       // headerHPx
  w.f32(opts.footerHPx ?? 0);       // footerHPx
  // static HF (object-form pageConfig)
  const sh = opts.staticHeader, sf = opts.staticFooter;
  w.u8((sh || sf) ? 1 : 0);
  if (sh || sf) { writeOptHF(w, sh); writeOptHF(w, sf); }

  // Fonts block
  const fonts = opts.fonts ?? [];
  w.u32(fonts.length);
  for (const f of fonts) {
    const famLen = BinWriter.utf8Len(f.family);
    w.u16(famLen); w.utf8(f.family);
    w.u8(f.style ?? 0);
    w.u16(f.weight ?? 400);
    w.u8(f.iconFont ? 1 : 0);
    w.u32(f.bytes.length);
    w.bytes(f.bytes);
  }

  // Per-page HF block (function-form pageConfig, resolved text)
  const perPage = opts.perPageHF ?? [];
  w.u32(perPage.length);
  for (const pair of perPage) {
    writeOptHF(w, pair[0]);
    writeOptHF(w, pair[1]);
  }

  // Nodes
  const nodes = opts.nodes;
  w.u32(nodes.length);
  for (const n of nodes) {
    w.u32(n.id);
    w.i32(n.parent);
    w.u8(n.kind);
    w.f32(n.x); w.f32(n.y); w.f32(n.w); w.f32(n.h);
    let flags = n.flags ?? 0;
    if (n.bg) flags |= F_BG;
    if (n.border) flags |= F_BORDER;
    if (n.radius) flags |= F_RADIUS;
    if (n.overflowHidden) flags |= F_OVERFLOW;
    if (n.opacity !== undefined) flags |= F_OPACITY;
    if (n.font) flags |= F_FONT;
    if (n.imageId !== undefined) flags |= F_IMAGE;
    if (n.renderMode) flags |= F_RENDER_MODE;
    if (n.divisionDisable) flags |= F_DIVISION_DISABLE;
    if (n.pageBreak) flags |= F_PAGE_BREAK;
    w.u16(flags);
    if (n.bg) { w.f32(n.bg[0]); w.f32(n.bg[1]); w.f32(n.bg[2]); w.f32(n.bg[3]); }
    if (n.border) {
      w.f32(n.border.w[0]); w.f32(n.border.w[1]); w.f32(n.border.w[2]); w.f32(n.border.w[3]);
      w.f32(n.border.c[0]); w.f32(n.border.c[1]); w.f32(n.border.c[2]); w.f32(n.border.c[3]);
      w.u8(n.border.s?.[0] ?? 0); w.u8(n.border.s?.[1] ?? 0); w.u8(n.border.s?.[2] ?? 0); w.u8(n.border.s?.[3] ?? 0);
    }
    if (n.radius) { w.f32(n.radius[0]); w.f32(n.radius[1]); w.f32(n.radius[2]); w.f32(n.radius[3]); }
    if (n.opacity !== undefined) w.f32(n.opacity);
    if (n.font) {
      const famLen = BinWriter.utf8Len(n.font.family);
      w.u16(famLen); w.utf8(n.font.family);
      w.f32(n.font.sizePx); w.u16(n.font.weight); w.u8(n.font.italic);
      w.f32(n.font.color[0]); w.f32(n.font.color[1]); w.f32(n.font.color[2]); w.f32(n.font.color[3]);
      w.f32(n.font.lineHeightPx); w.u8(n.font.align);
      w.f32(n.font.letterSpacingPx ?? 0); w.f32(n.font.wordSpacingPx ?? 0);
    }
    if (n.imageId !== undefined) { w.u32(n.imageId); w.u8(n.objectFit ?? 0); }
    if (n.renderMode) w.u8(n.renderMode);
    if (n.kind === 1) {
      const tlen = BinWriter.utf8Len(n.text ?? '');
      w.u32(tlen); w.utf8(n.text ?? '');
      const lines = n.lines ?? [];
      w.u32(lines.length);
      for (const l of lines) {
        w.f32(l.x); w.f32(l.y); w.f32(l.w); w.f32(l.h);
        w.u32(l.start); w.u32(l.end);
      }
    }
  }

  // Images
  const images = opts.images ?? [];
  w.u32(images.length);
  for (const img of images) {
    w.u32(img.id); w.u32(img.width); w.u32(img.height);
    w.u32(img.bytes.length); w.bytes(img.bytes);
  }

  return w.result();
}

// ============================================================================
// Template 1: report  (object-form pageConfig, Chinese HF, margin 0)
// ============================================================================
function buildReportSnapshot() {
  const pageW = 595.28, pageH = 841.89;
  const m = 0; // marginPt: 0 (header/footer bands handle spacing)

  const nodes = [
    // 0: root .doc container
    { id: 0, parent: -1, kind: 0, x: 0, y: 0, w: 608, h: 1400, flags: 0 },
    // 1: h1
    { id: 1, parent: 0, kind: 1, x: 56, y: 48, w: 500, h: 48, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 30, weight: 700, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 48, align: 0 },
      text: 'Quarterly Product Report',
      lines: [{ x: 56, y: 48, w: 380, h: 48, start: 0, end: 24 }] },
    // 2: p.lede
    { id: 2, parent: 0, kind: 1, x: 56, y: 110, w: 500, h: 60, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 15, weight: 400, italic: 0,
        color: [0.42,0.45,0.50,1], lineHeightPx: 24, align: 0 },
      text: 'This document is rendered live by the browser, then snapshotted and re-emitted as a vector PDF.',
      lines: [
        { x: 56, y: 110, w: 500, h: 24, start: 0, end: 70 },
        { x: 56, y: 134, w: 350, h: 24, start: 70, end: 95 },
      ] },
    // 3: h2 box with border-bottom
    { id: 3, parent: 0, kind: 0, x: 56, y: 200, w: 500, h: 36, flags: 0,
      border: { w: [0,0,1,0], c: [0.9,0.92,0.94,1] } },
    // 4: h2 text
    { id: 4, parent: 3, kind: 1, x: 56, y: 205, w: 200, h: 24, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 20, weight: 700, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 32, align: 0 },
      text: '1. Executive summary',
      lines: [{ x: 56, y: 205, w: 180, h: 24, start: 0, end: 20 }] },
    // 5: p with strong
    { id: 5, parent: 0, kind: 1, x: 56, y: 250, w: 500, h: 80, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 16, weight: 400, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 25.6, align: 0 },
      text: 'The quarter delivered strong, predictable results. Revenue grew 18% quarter-over-quarter.',
      lines: [
        { x: 56, y: 250, w: 500, h: 25.6, start: 0, end: 59 },
        { x: 56, y: 275.6, w: 500, h: 25.6, start: 59, end: 89 },
      ] },
    // 6: card container
    { id: 6, parent: 0, kind: 0, x: 56, y: 360, w: 500, h: 168, flags: 0,
      bg: [0.99,0.99,0.99,1], border: { w: [1,1,1,1], c: [0.9,0.92,0.94,1] },
      radius: [10,10,10,10] },
    // 7: image in card
    { id: 7, parent: 6, kind: 2, x: 70, y: 374, w: 220, h: 140, flags: 0, imageId: 1 },
    // 8: clip-box overflow:hidden
    { id: 8, parent: 0, kind: 0, x: 56, y: 560, w: 500, h: 90, flags: 0,
      border: { w: [1,1,1,1], c: [0.61,0.64,0.69,1] },
      radius: [12,12,12,12], overflowHidden: true },
    // 9: text in clip-box
    { id: 9, parent: 8, kind: 1, x: 70, y: 570, w: 470, h: 50, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 16, weight: 400, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 25.6, align: 0 },
      text: 'This container has overflow: hidden.',
      lines: [{ x: 70, y: 570, w: 280, h: 25.6, start: 0, end: 36 }] },
    // 10: cross-page list item
    { id: 10, parent: 0, kind: 1, x: 78, y: 1010, w: 480, h: 25.6, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 16, weight: 400, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 25.6, align: 0 },
      text: '7. Move straddling lines to the next page; allow whitespace.',
      lines: [{ x: 78, y: 1010, w: 450, h: 25.6, start: 0, end: 60 }] },
  ];

  const images = [{ id: 1, width: 220, height: 140, bytes: MIN_JPEG }];

  // object-form pageConfig → static HF (Rust resolves ${currentPage}/${totalPages})
  const staticHeader = {
    content: 'dompdf · 季度产品报告',
    heightPx: 50, color: [0.2,0.2,0.2,1], fontSizePx: 12,
    position: 0, padding: [0,0,0,0],
  };
  const staticFooter = {
    content: '第 ${currentPage} 页 / 共 ${totalPages} 页',
    heightPx: 50, color: [0.2,0.2,0.2,1], fontSizePx: 12,
    position: 0, padding: [0,0,0,0],
  };

  return encodeSnapshot({
    pageWidthPt: pageW, pageHeightPt: pageH,
    mTop: m, mRight: m, mBottom: m, mLeft: m,
    precision: 2, pagination: true,
    backgroundColor: [1,1,1,1],
    headerHPx: 50, footerHPx: 50,
    staticHeader, staticFooter,
    fonts: sharedFonts, perPageHF: [],
    nodes, images,
  });
}

// ============================================================================
// Template 2: demo1  (function-form pageConfig, margin [20,0,20,0], English)
// ============================================================================
function buildDemo1Snapshot() {
  const pageW = 595.28, pageH = 841.89;
  const mTop = 20, mRight = 0, mBottom = 20, mLeft = 0;

  const nodes = [
    // 0: #capture-area root
    { id: 0, parent: -1, kind: 0, x: 0, y: 0, w: 608, h: 1200, flags: 0 },
    // 1: h2 section title
    { id: 1, parent: 0, kind: 1, x: 24, y: 24, w: 500, h: 32, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 20, weight: 700, italic: 0,
        color: [0.06,0.09,0.16,1], lineHeightPx: 32, align: 0 },
      text: 'Section Title',
      lines: [{ x: 24, y: 24, w: 160, h: 32, start: 0, end: 13 }] },
    // 2: paragraph
    { id: 2, parent: 0, kind: 1, x: 24, y: 70, w: 560, h: 60, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 16, weight: 400, italic: 0,
        color: [0.13,0.13,0.13,1], lineHeightPx: 27.2, align: 0 },
      text: 'This is a demo paragraph with some text that should wrap across multiple lines in the PDF output.',
      lines: [
        { x: 24, y: 70, w: 560, h: 27.2, start: 0, end: 66 },
        { x: 24, y: 97.2, w: 400, h: 27.2, start: 66, end: 97 },
      ] },
    // 3: image card
    { id: 3, parent: 0, kind: 0, x: 24, y: 150, w: 260, h: 180, flags: 0,
      bg: [0.96,0.97,0.98,1], border: { w: [1,1,1,1], c: [0.89,0.9,0.94,1] },
      radius: [8,8,8,8] },
    // 4: image in card
    { id: 4, parent: 3, kind: 2, x: 36, y: 162, w: 236, h: 156, flags: 0, imageId: 1, objectFit: 2, radius: [9,9,9,9] },
    // 5: second image card
    { id: 5, parent: 0, kind: 0, x: 300, y: 150, w: 260, h: 180, flags: 0,
      bg: [0.96,0.97,0.98,1], border: { w: [1,1,1,1], c: [0.89,0.9,0.94,1] },
      radius: [8,8,8,8] },
    // 6: image in second card
    { id: 6, parent: 5, kind: 2, x: 312, y: 162, w: 236, h: 156, flags: 0, imageId: 2, objectFit: 2, radius: [9,9,9,9] },
    // 7: canvas section
    { id: 7, parent: 0, kind: 0, x: 24, y: 360, w: 560, h: 120, flags: 0,
      border: { w: [1,1,1,1], c: [0.89,0.9,0.94,1] } },
    // 8: text in canvas section
    { id: 8, parent: 7, kind: 1, x: 36, y: 372, w: 540, h: 24, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 14, weight: 400, italic: 0,
        color: [0.13,0.13,0.13,1], lineHeightPx: 24, align: 0 },
      text: 'Canvas Rendering Test',
      lines: [{ x: 36, y: 372, w: 180, h: 24, start: 0, end: 21 }] },
    // 9: cross-page text
    { id: 9, parent: 0, kind: 1, x: 24, y: 1010, w: 560, h: 27.2, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 16, weight: 400, italic: 0,
        color: [0.13,0.13,0.13,1], lineHeightPx: 27.2, align: 0 },
      text: 'This line should appear on page 2 due to pagination.',
      lines: [{ x: 24, y: 1010, w: 400, h: 27.2, start: 0, end: 52 }] },
  ];

  const images = [
    { id: 1, width: 320, height: 240, bytes: MIN_JPEG },
    { id: 2, width: 320, height: 240, bytes: MIN_JPEG },
  ];

  // function-form pageConfig → per-page HF (resolved text, no placeholders)
  // page 1: no HF; page 2+: header + footer
  const perPageHF = [
    [null, null], // page 1
    [
      { content: 'dompdf · demo1 · 2/2', heightPx: 50, color: [0.2,0.2,0.2,1],
        fontSizePx: 12, position: 0, padding: [0,0,0,0] },
      { content: 'Page 2 / 2', heightPx: 50, color: [0.2,0.2,0.2,1],
        fontSizePx: 12, position: 0, padding: [0,0,0,0] },
    ],
  ];

  return encodeSnapshot({
    pageWidthPt: pageW, pageHeightPt: pageH,
    mTop, mRight, mBottom, mLeft,
    precision: 2, pagination: true,
    backgroundColor: [1,1,1,1],
    headerHPx: 0, footerHPx: 0, // per-page handles it
    fonts: sharedFonts, perPageHF,
    nodes, images,
  });
}

// ============================================================================
// Template 3: interactive  (function-form pageConfig, margin 0, multi-page)
// ============================================================================
function buildInteractiveSnapshot() {
  const pageW = 595.28, pageH = 841.89;
  const m = 0;

  const nodes = [
    // 0: root
    { id: 0, parent: -1, kind: 0, x: 0, y: 0, w: 608, h: 1600, flags: 0 },
    // 1: hero title
    { id: 1, parent: 0, kind: 1, x: 40, y: 40, w: 528, h: 56, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 32, weight: 700, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 56, align: 0 },
      text: 'Interactive Demo',
      lines: [{ x: 40, y: 40, w: 300, h: 56, start: 0, end: 16 }] },
    // 2: hero subtitle
    { id: 2, parent: 0, kind: 1, x: 40, y: 110, w: 528, h: 48, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 18, weight: 400, italic: 0,
        color: [0.28,0.31,0.36,1], lineHeightPx: 28, align: 0 },
      text: 'Test various PDF rendering scenarios with images, grids, and pagination.',
      lines: [
        { x: 40, y: 110, w: 528, h: 28, start: 0, end: 56 },
        { x: 40, y: 138, w: 400, h: 28, start: 56, end: 75 },
      ] },
    // 3: comparison grid (2 images side by side)
    { id: 3, parent: 0, kind: 0, x: 40, y: 190, w: 528, h: 200, flags: 0 },
    // 4: left image
    { id: 4, parent: 3, kind: 2, x: 40, y: 190, w: 254, h: 190, flags: 0, imageId: 1 },
    // 5: right image
    { id: 5, parent: 3, kind: 2, x: 314, y: 190, w: 254, h: 190, flags: 0, imageId: 2 },
    // 6: image caption left
    { id: 6, parent: 3, kind: 1, x: 40, y: 380, w: 254, h: 20, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 12, weight: 400, italic: 0,
        color: [0.28,0.31,0.36,1], lineHeightPx: 20, align: 0 },
      text: 'Scenario 1',
      lines: [{ x: 40, y: 380, w: 80, h: 20, start: 0, end: 11 }] },
    // 7: image caption right
    { id: 7, parent: 3, kind: 1, x: 314, y: 380, w: 254, h: 20, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 12, weight: 400, italic: 0,
        color: [0.28,0.31,0.36,1], lineHeightPx: 20, align: 0 },
      text: 'Scenario 2',
      lines: [{ x: 314, y: 380, w: 80, h: 20, start: 0, end: 11 }] },
    // 8: chart card with bg
    { id: 8, parent: 0, kind: 0, x: 40, y: 430, w: 528, h: 240, flags: 0,
      bg: [0.98,0.98,0.99,1], border: { w: [1,1,1,1], c: [0.89,0.9,0.94,1] },
      radius: [10,10,10,10] },
    // 9: chart image
    { id: 9, parent: 8, kind: 2, x: 56, y: 446, w: 496, h: 210, flags: 0, imageId: 3 },
    // 10: cross-page section
    { id: 10, parent: 0, kind: 1, x: 40, y: 1010, w: 528, h: 32, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 20, weight: 700, italic: 0,
        color: [0.1,0.1,0.1,1], lineHeightPx: 32, align: 0 },
      text: 'Paginated Section',
      lines: [{ x: 40, y: 1010, w: 200, h: 32, start: 0, end: 18 }] },
    // 11: long paragraph on page 2
    { id: 11, parent: 0, kind: 1, x: 40, y: 1060, w: 528, h: 80, flags: 0,
      font: { family: 'SourceHanSansSC-Regular', sizePx: 16, weight: 400, italic: 0,
        color: [0.13,0.13,0.13,1], lineHeightPx: 25.6, align: 0 },
      text: 'This content appears on the second page. The header and footer should reflect the correct page number.',
      lines: [
        { x: 40, y: 1060, w: 528, h: 25.6, start: 0, end: 62 },
        { x: 40, y: 1085.6, w: 528, h: 25.6, start: 62, end: 104 },
      ] },
  ];

  const images = [
    { id: 1, width: 320, height: 240, bytes: MIN_JPEG },
    { id: 2, width: 320, height: 240, bytes: MIN_JPEG },
    { id: 3, width: 440, height: 280, bytes: MIN_JPEG },
  ];

  // function-form pageConfig: page 1 hero header; page 2+ compact header + footer
  const perPageHF = [
    [
      { content: 'dompdf · Interactive Demo', heightPx: 52, color: [0.2,0.25,0.33,1],
        fontSizePx: 12, position: 0, padding: [0,0,0,0] },
      null,
    ],
    [
      { content: 'Interactive Demo · 2/2', heightPx: 44, color: [0.28,0.31,0.36,1],
        fontSizePx: 11, position: 0, padding: [0,0,0,0] },
      { content: 'Page 2 of 2', heightPx: 42, color: [0.39,0.46,0.55,1],
        fontSizePx: 11, position: 0, padding: [0,0,0,0] },
    ],
  ];

  return encodeSnapshot({
    pageWidthPt: pageW, pageHeightPt: pageH,
    mTop: m, mRight: m, mBottom: m, mLeft: m,
    precision: 2, pagination: true,
    backgroundColor: [1,1,1,1],
    headerHPx: 0, footerHPx: 0,
    fonts: sharedFonts, perPageHF,
    nodes, images,
  });
}

// ---- PDF content stream parser ----
function parsePdf(pdfBytes) {
  const text = Buffer.from(pdfBytes).toString('latin1');
  const lines = text.split('\n');
  const objects = {};
  let i = 0;
  while (i < lines.length) {
    const m = /^(\d+) 0 obj/.exec(lines[i]);
    if (m) {
      const id = parseInt(m[1], 10);
      const start = i + 1;
      let end = start;
      while (end < lines.length && lines[end] !== 'endobj') end++;
      objects[id] = lines.slice(start, end).join('\n');
      i = end + 1;
    } else {
      i++;
    }
  }
  return objects;
}

function extractContentStreams(objects) {
  const streams = [];
  for (const [id, body] of Object.entries(objects)) {
    const streamMatch = body.match(/stream\n([\s\S]*?)\nendstream/);
    if (streamMatch) {
      const header = body.slice(0, body.indexOf('stream'));
      const isContent = !/\/Type\s+\/(Font|XObject|Pages|Page|Catalog)/.test(header);
      if (isContent || /BT|re f|cm|Do/.test(streamMatch[1])) {
        streams.push({ id: parseInt(id, 10), content: streamMatch[1] });
      }
    }
  }
  return streams;
}

function describeContentStream(content) {
  const ops = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'q') { ops.push({ op: 'save' }); continue; }
    if (t === 'Q') { ops.push({ op: 'restore' }); continue; }
    if (t === 'BT') { ops.push({ op: 'beginText' }); continue; }
    if (t === 'ET') { ops.push({ op: 'endText' }); continue; }
    if (/re W n$/.test(t)) {
      const m = /([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) re W n/.exec(t);
      if (m) ops.push({ op: 'clipRect', x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
      continue;
    }
    if (/re f$/.test(t)) {
      const m = /([\d.]+) ([\d.]+) ([\d.]+) rg ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) re f/.exec(t);
      if (m) ops.push({ op: 'fillRect', r: +m[1], g: +m[2], b: +m[3], x: +m[4], y: +m[5], w: +m[6], h: +m[7] });
      continue;
    }
    if (/l S$/.test(t)) {
      const m = /([\d.]+) ([\d.]+) ([\d.]+) RG ([\d.]+) w ([\d.\-]+) ([\d.\-]+) m ([\d.\-]+) ([\d.\-]+) l S/.exec(t);
      if (m) ops.push({ op: 'line', r: +m[1], g: +m[2], b: +m[3], w: +m[4], x1: +m[5], y1: +m[6], x2: +m[7], y2: +m[8] });
      continue;
    }
    if (/cm \/Im\d+ Do Q$/.test(t)) {
      const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.\-]+) ([\d.\-]+) cm \/Im(\d+) Do Q/.exec(t);
      if (m) ops.push({ op: 'image', w: +m[1], h: +m[2], x: +m[3], y: +m[4], imgId: +m[5] });
      continue;
    }
    if (/Tj$/.test(t)) {
      const m = /<([0-9A-F]+)> Tj/.exec(t);
      if (m) {
        const bytes = Buffer.from(m[1], 'hex');
        const text = bytes.toString('latin1');
        ops.push({ op: 'text', text });
      }
      continue;
    }
    if (/Tf$/.test(t)) {
      const m = /\/F(\d+) ([\d.]+) Tf/.exec(t);
      if (m) ops.push({ op: 'setFont', font: +m[1], size: +m[2] });
      continue;
    }
    if (/Tm$/.test(t)) {
      const m = /1 0 0 1 ([\d.\-]+) ([\d.\-]+) Tm/.exec(t);
      if (m) ops.push({ op: 'textPos', x: +m[1], y: +m[2] });
      continue;
    }
    if (/rg$/.test(t)) {
      const m = /([\d.]+) ([\d.]+) ([\d.]+) rg/.exec(t);
      if (m) ops.push({ op: 'fillColor', r: +m[1], g: +m[2], b: +m[3] });
      continue;
    }
  }
  return ops;
}

function printOps(ops) {
  for (const op of ops) {
    if (op.op === 'clipRect') {
      console.log(`  CLIP  x=${op.x} y=${op.y} w=${op.w} h=${op.h}`);
    } else if (op.op === 'fillRect') {
      console.log(`  FILL  rgb=(${op.r},${op.g},${op.b}) x=${op.x} y=${op.y} w=${op.w} h=${op.h}`);
    } else if (op.op === 'line') {
      console.log(`  LINE  rgb=(${op.r},${op.g},${op.b}) w=${op.w} (${op.x1},${op.y1})->(${op.x2},${op.y2})`);
    } else if (op.op === 'image') {
      console.log(`  IMAGE imgId=${op.imgId} x=${op.x} y=${op.y} w=${op.w} h=${op.h}`);
    } else if (op.op === 'setFont') {
      console.log(`  FONT  f${op.font} size=${op.size}pt`);
    } else if (op.op === 'textPos') {
      console.log(`  POS   x=${op.x} y=${op.y}`);
    } else if (op.op === 'text') {
      console.log(`  TEXT  "${op.text}"`);
    } else if (op.op === 'fillColor') {
      console.log(`  COLOR rgb=(${op.r},${op.g},${op.b})`);
    }
  }
}

// ---- Run diagnostics for all three templates ----
const templates = [
  { name: 'report', label: 'Quarterly Report', build: buildReportSnapshot, filename: 'diagnose-report.pdf' },
  { name: 'demo1', label: 'dompdf.js demo1', build: buildDemo1Snapshot, filename: 'diagnose-demo1.pdf' },
  { name: 'interactive', label: 'Interactive Demo', build: buildInteractiveSnapshot, filename: 'diagnose-interactive.pdf' },
];

let allOk = true;

for (const tpl of templates) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`=== Template: ${tpl.label} (${tpl.name}) ===`);
  console.log('='.repeat(70));

  const snapshot = tpl.build();
  console.log(`\n[Snapshot] ${snapshot.length} bytes`);

  // Inspect
  console.log('\n--- Inspect ---');
  const summary = inspectSnapshot(snapshot);
  console.log(summary.split('\n').slice(0, 30).join('\n'));
  if (summary.length > 30 * 80) console.log('... (truncated)');

  // Render PDF
  let pdf;
  try {
    pdf = renderPdf(snapshot);
  } catch (e) {
    console.log(`\n[ERROR] render_pdf failed: ${e.message}`);
    allOk = false;
    continue;
  }
  writeFileSync(resolve(__dirname, tpl.filename), pdf);
  console.log(`\n[PDF] ${pdf.length} bytes → ${tpl.filename}`);

  // Parse content streams
  const objects = parsePdf(pdf);
  const streams = extractContentStreams(objects);
  console.log(`\n[Objects] ${Object.keys(objects).length}, [Content streams] ${streams.length} (pages)`);

  streams.forEach((s, pageIdx) => {
    console.log(`\n--- ${tpl.name} Page ${pageIdx + 1} ---`);
    const ops = describeContentStream(s.content);
    printOps(ops);
  });
}

console.log(`\n${'='.repeat(70)}`);
console.log(allOk ? '=== All templates rendered successfully ===' : '=== Some templates failed ===');
console.log('='.repeat(70));
