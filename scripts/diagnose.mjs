/**
 * 诊断脚本：模拟 playground 页面的快照 → 生成 PDF → 解析 PDF 内容流
 * 打印每个绘制操作，与预期对比，找出差异。
 *
 * 运行：node scripts/diagnose.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmPath = resolve(__dirname, '../packages/dom2pdf-wasm/pkg/dom2pdf_wasm.wasm');

// ---- BinWriter (mirror of packages/dom2pdf/src/format.ts) ----
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

// ---- Build a snapshot that simulates the playground document ----
// 模拟 .doc article:
//   页面 A4: 595.28 x 841.89 pt, margin 36
//   .doc padding 48px top/bottom, 56px left/right
//   标题 h1 30px, h2 20px (with bottom border), p 16px line-height 1.6
function buildPlaygroundSnapshot() {
  const w = new BinWriter();
  const pageW = 595.28, pageH = 841.89;
  const mTop = 36, mRight = 36, mBottom = 36, mLeft = 36;

  // 模拟节点布局（坐标单位 px，原点在 .doc 左上角）
  // 这里我们用真实的 playground 尺寸来估算
  const nodes = [];

  // 0: root .doc container
  // 宽度 720 - 56*2 = 608px, padding 48 56
  // 假设内容总高度 1400px（多页）
  nodes.push({
    id: 0, parent: -1, kind: 0,
    x: 0, y: 0, w: 608, h: 1400,
    flags: 0,
    overflowHidden: false, renderMode: 0,
  });

  // 1: h1 "Quarterly Product Report" 30px, 位置 y=48 (padding top)
  // h1 高度约 30 * 1.6 = 48px
  nodes.push({
    id: 1, parent: 0, kind: 1,
    x: 56, y: 48, w: 500, h: 48,
    flags: 0x20,
    font: {
      family: 'system-ui', sizePx: 30, weight: 700, italic: 0,
      color: [0.1, 0.1, 0.1, 1], lineHeightPx: 48, align: 0,
    },
    overflowHidden: false, renderMode: 0,
    text: 'Quarterly Product Report',
    lines: [{ x: 56, y: 48, w: 380, h: 48, start: 0, end: 24 }],
  });
  // 2: p.lede 15px muted
  nodes.push({
    id: 2, parent: 0, kind: 1,
    x: 56, y: 110, w: 500, h: 60,
    flags: 0x20,
    font: {
      family: 'system-ui', sizePx: 15, weight: 400, italic: 0,
      color: [0.42, 0.45, 0.50, 1], lineHeightPx: 24, align: 0,
    },
    overflowHidden: false, renderMode: 0,
    text: 'This document is rendered live by the browser, then snapshotted and re-emitted as a vector PDF.',
    lines: [
      { x: 56, y: 110, w: 500, h: 24, start: 0, end: 70 },
      { x: 56, y: 134, w: 350, h: 24, start: 70, end: 95 },
    ],
  });

  // 3: h2 "1. Executive summary" 20px with border-bottom
  nodes.push({
    id: 3, parent: 0, kind: 0,
    x: 56, y: 200, w: 500, h: 36,
    flags: 0x02, // hasBorder
    border: {
      w: [0, 0, 1, 0],
      c: [0.9, 0.92, 0.94, 1],
    },
    overflowHidden: false, renderMode: 0,
  });

  // 4: h2 text
  nodes.push({
    id: 4, parent: 3, kind: 1,
    x: 56, y: 205, w: 200, h: 24,
    flags: 0x20,
    font: {
      family: 'system-ui', sizePx: 20, weight: 700, italic: 0,
      color: [0.1, 0.1, 0.1, 1], lineHeightPx: 32, align: 0,
    },
    overflowHidden: false, renderMode: 0,
    text: '1. Executive summary',
    lines: [{ x: 56, y: 205, w: 180, h: 24, start: 0, end: 20 }],
  });

  // 5: p with strong
  nodes.push({
    id: 5, parent: 0, kind: 1,
    x: 56, y: 250, w: 500, h: 80,
    flags: 0x20,
    font: {
      family: 'system-ui', sizePx: 16, weight: 400, italic: 0,
      color: [0.1, 0.1, 0.1, 1], lineHeightPx: 25.6, align: 0,
    },
    overflowHidden: false, renderMode: 0,
    text: 'The quarter delivered strong, predictable results. Revenue grew 18% quarter-over-quarter.',
    lines: [
      { x: 56, y: 250, w: 500, h: 25.6, start: 0, end: 59 },
      { x: 56, y: 275.6, w: 500, h: 25.6, start: 59, end: 89 },
    ],
  });

  // 6: card container with bg + border + radius
  nodes.push({
    id: 6, parent: 0, kind: 0,
    x: 56, y: 360, w: 500, h: 168,
    flags: 0x01 | 0x02 | 0x04, // hasBg + hasBorder + hasRadius
    bg: [0.99, 0.99, 0.99, 1],
    border: { w: [1, 1, 1, 1], c: [0.9, 0.92, 0.94, 1] },
    radius: [10, 10, 10, 10],
    overflowHidden: false, renderMode: 0,
  });

  // 7: image in card (220x140, jpeg)
  // 生成一个最小 JPEG (1x1 红色)
  const jpegBytes = Buffer.from([
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
  const images = [{ id: 1, width: 220, height: 140, bytes: jpegBytes }];

  nodes.push({
    id: 7, parent: 6, kind: 2,
    x: 70, y: 374, w: 220, h: 140,
    flags: 0x40, // hasImage
    overflowHidden: false, renderMode: 0,
    imageId: 1,
  });

  // 8: clip-box with overflow:hidden
  nodes.push({
    id: 8, parent: 0, kind: 0,
    x: 56, y: 560, w: 500, h: 90,
    flags: 0x02 | 0x04 | 0x08, // hasBorder + hasRadius + overflowHidden
    border: { w: [1, 1, 1, 1], c: [0.61, 0.64, 0.69, 1] },
    radius: [12, 12, 12, 12],
    overflowHidden: true, renderMode: 0,
  });

  // 9: text in clip-box
  nodes.push({
    id: 9, parent: 8, kind: 1,
    x: 70, y: 570, w: 470, h: 50,
    flags: 0x20,
    font: {
      family: 'system-ui', sizePx: 16, weight: 400, italic: 0,
      color: [0.1, 0.1, 0.1, 1], lineHeightPx: 25.6, align: 0,
    },
    overflowHidden: false, renderMode: 0,
    text: 'This container has overflow: hidden.',
    lines: [{ x: 70, y: 570, w: 280, h: 25.6, start: 0, end: 36 }],
  });

  // 10: long list item (跨页测试)
  // 让一个 list item 出现在第 1 页底部边缘，触发分页
  // content_h_px = (841.89 - 36*2) / 0.75 = 1025 px
  // 所以 y=1000 的元素会在第 1 页，y=1050 的会在第 2 页
  nodes.push({
    id: 10, parent: 0, kind: 1,
    x: 78, y: 1010, w: 480, h: 25.6, // 这一行会跨页
    flags: 0x20,
    font: {
      family: 'system-ui', sizePx: 16, weight: 400, italic: 0,
      color: [0.1, 0.1, 0.1, 1], lineHeightPx: 25.6, align: 0,
    },
    overflowHidden: false, renderMode: 0,
    text: '7. Move straddling lines to the next page; allow whitespace.',
    lines: [{ x: 78, y: 1010, w: 450, h: 25.6, start: 0, end: 60 }],
  });

  // ---- Encode snapshot ----
  w.bytes(Buffer.from([0x44, 0x32, 0x50, 0x31])); // "D2P1"
  w.u32(3);
  w.f32(pageW); w.f32(pageH);
  w.f32(mTop); w.f32(mRight); w.f32(mBottom); w.f32(mLeft);
  w.u32(nodes.length);
  w.u32(images.length);

  for (const n of nodes) {
    w.u32(n.id);
    w.i32(n.parent);
    w.u8(n.kind);
    w.f32(n.x); w.f32(n.y); w.f32(n.w); w.f32(n.h);
    let flags = n.flags;
    if (n.bg) flags |= 0x01;
    if (n.border) flags |= 0x02;
    if (n.radius) flags |= 0x04;
    if (n.overflowHidden) flags |= 0x08;
    if (n.opacity !== undefined) flags |= 0x10;
    if (n.font) flags |= 0x20;
    if (n.imageId !== undefined) flags |= 0x40;
    if (n.renderMode !== 0) flags |= 0x80;
    w.u16(flags);
    if (n.bg) { w.f32(n.bg[0]); w.f32(n.bg[1]); w.f32(n.bg[2]); w.f32(n.bg[3]); }
    if (n.border) {
      w.f32(n.border.w[0]); w.f32(n.border.w[1]); w.f32(n.border.w[2]); w.f32(n.border.w[3]);
      w.f32(n.border.c[0]); w.f32(n.border.c[1]); w.f32(n.border.c[2]); w.f32(n.border.c[3]);
      w.u8(0); w.u8(0); w.u8(0); w.u8(0);
    }
    if (n.radius) { w.f32(n.radius[0]); w.f32(n.radius[1]); w.f32(n.radius[2]); w.f32(n.radius[3]); }
    if (n.opacity !== undefined) w.f32(n.opacity);
    if (n.font) {
      const famLen = BinWriter.utf8Len(n.font.family);
      w.u16(famLen);
      w.utf8(n.font.family);
      w.f32(n.font.sizePx);
      w.u16(n.font.weight);
      w.u8(n.font.italic);
      w.f32(n.font.color[0]); w.f32(n.font.color[1]); w.f32(n.font.color[2]); w.f32(n.font.color[3]);
      w.f32(n.font.lineHeightPx);
      w.u8(n.font.align);
      w.f32(n.font.letterSpacingPx ?? 0);
      w.f32(n.font.wordSpacingPx ?? 0);
    }
    if (n.imageId !== undefined) { w.u32(n.imageId); w.u8(0); }
    if (n.renderMode !== 0) w.u8(n.renderMode);
    if (n.kind === 1) {
      const tlen = BinWriter.utf8Len(n.text);
      w.u32(tlen);
      w.utf8(n.text);
      w.u32(n.lines.length);
      for (const l of n.lines) {
        w.f32(l.x); w.f32(l.y); w.f32(l.w); w.f32(l.h);
        w.u32(l.start); w.u32(l.end);
      }
    }
  }

  for (const img of images) {
    w.u32(img.id);
    w.u32(img.width);
    w.u32(img.height);
    w.u32(img.bytes.length);
    w.bytes(img.bytes);
  }

  return { snapshot: w.result(), nodes, images };
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
    // match content streams: ... /Contents N 0 R ...
    // actual stream content is in stream...endstream
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
    // q / Q
    if (t === 'q') { ops.push({ op: 'save' }); continue; }
    if (t === 'Q') { ops.push({ op: 'restore' }); continue; }
    // BT / ET
    if (t === 'BT') { ops.push({ op: 'beginText' }); continue; }
    if (t === 'ET') { ops.push({ op: 'endText' }); continue; }
    // clip: ... re W n
    if (/re W n$/.test(t)) {
      const m = /([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) re W n/.exec(t);
      if (m) ops.push({ op: 'clipRect', x: +m[1], y: +m[2], w: +m[3], h: +m[4] });
      continue;
    }
    // fill rect: r g b ... re f
    if (/re f$/.test(t)) {
      const m = /([\d.]+) ([\d.]+) ([\d.]+) rg ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) ([\d.\-]+) re f/.exec(t);
      if (m) ops.push({ op: 'fillRect', r: +m[1], g: +m[2], b: +m[3], x: +m[4], y: +m[5], w: +m[6], h: +m[7] });
      continue;
    }
    // stroke: r g b RG w x1 y1 m x2 y2 l S
    if (/l S$/.test(t)) {
      const m = /([\d.]+) ([\d.]+) ([\d.]+) RG ([\d.]+) w ([\d.\-]+) ([\d.\-]+) m ([\d.\-]+) ([\d.\-]+) l S/.exec(t);
      if (m) ops.push({ op: 'line', r: +m[1], g: +m[2], b: +m[3], w: +m[4], x1: +m[5], y1: +m[6], x2: +m[7], y2: +m[8] });
      continue;
    }
    // image: q w 0 0 h x y cm /ImN Do Q
    if (/cm \/Im\d+ Do Q$/.test(t)) {
      const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.\-]+) ([\d.\-]+) cm \/Im(\d+) Do Q/.exec(t);
      if (m) ops.push({ op: 'image', w: +m[1], h: +m[2], x: +m[3], y: +m[4], imgId: +m[5] });
      continue;
    }
    // text: <hex> Tj
    if (/Tj$/.test(t)) {
      const m = /<([0-9A-F]+)> Tj/.exec(t);
      if (m) {
        const bytes = Buffer.from(m[1], 'hex');
        const text = bytes.toString('latin1');
        ops.push({ op: 'text', text });
      }
      continue;
    }
    // font set: /F1 N Tf
    if (/Tf$/.test(t)) {
      const m = /\/F1 ([\d.]+) Tf/.exec(t);
      if (m) ops.push({ op: 'setFont', size: +m[1] });
      continue;
    }
    // text matrix: 1 0 0 1 x y Tm
    if (/Tm$/.test(t)) {
      const m = /1 0 0 1 ([\d.\-]+) ([\d.\-]+) Tm/.exec(t);
      if (m) ops.push({ op: 'textPos', x: +m[1], y: +m[2] });
      continue;
    }
    // fill color
    if (/rg$/.test(t)) {
      const m = /([\d.]+) ([\d.]+) ([\d.]+) rg/.exec(t);
      if (m) ops.push({ op: 'fillColor', r: +m[1], g: +m[2], b: +m[3] });
      continue;
    }
  }
  return ops;
}

// ---- Main ----
const { snapshot, nodes, images } = buildPlaygroundSnapshot();
console.log('=== Inspect ===');
console.log(inspectSnapshot(snapshot));

const pdf = renderPdf(snapshot);
writeFileSync(resolve(__dirname, 'diagnose-output.pdf'), pdf);
console.log(`\n=== PDF generated: ${pdf.length} bytes ===`);

const objects = parsePdf(pdf);
console.log(`\n=== Objects: ${Object.keys(objects).length} ===`);
for (const [id, body] of Object.entries(objects)) {
  const first = body.split('\n')[0].slice(0, 80);
  console.log(`  obj ${id}: ${first}`);
}

const streams = extractContentStreams(objects);
console.log(`\n=== Content streams: ${streams.length} (pages) ===`);

streams.forEach((s, pageIdx) => {
  console.log(`\n--- Page ${pageIdx + 1} ---`);
  const ops = describeContentStream(s.content);
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
      console.log(`  FONT  size=${op.size}pt`);
    } else if (op.op === 'textPos') {
      console.log(`  POS   x=${op.x} y=${op.y}`);
    } else if (op.op === 'text') {
      console.log(`  TEXT  "${op.text}"`);
    } else if (op.op === 'fillColor') {
      console.log(`  COLOR rgb=(${op.r},${op.g},${op.b})`);
    }
  }
});

console.log('\n=== Expected nodes ===');
for (const n of nodes) {
  const kind = ['box', 'text', 'image'][n.kind];
  console.log(`  #${n.id} ${kind} parent=${n.parent} x=${n.x} y=${n.y} w=${n.w} h=${n.h} flags=0x${n.flags.toString(16)}`);
  if (n.text) console.log(`       text: "${n.text.slice(0, 40)}${n.text.length > 40 ? '...' : ''}"`);
  if (n.font) console.log(`       font: ${n.font.sizePx}px weight=${n.font.weight} color=(${n.font.color.join(',')})`);
  if (n.imageId !== undefined) console.log(`       imageId: ${n.imageId}`);
}
