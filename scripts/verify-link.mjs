import { readFile } from 'node:fs/promises';

class Writer {
  constructor() {
    this.parts = [];
  }

  bytes(value) {
    this.parts.push(Uint8Array.from(value));
  }
  u8(value) {
    this.bytes([value]);
  }
  u16(value) {
    this.number(value, 2, 'setUint16');
  }
  u32(value) {
    this.number(value, 4, 'setUint32');
  }
  i32(value) {
    this.number(value, 4, 'setInt32');
  }
  f32(value) {
    this.number(value, 4, 'setFloat32');
  }
  number(value, size, method) {
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer)[method](0, value, true);
    this.parts.push(bytes);
  }
  result() {
    const length = this.parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}

const href = 'https://example.com/link-test';
const hrefBytes = new TextEncoder().encode(href);
const snapshot = new Writer();
snapshot.bytes([0x44, 0x32, 0x50, 0x31]);
snapshot.u32(11);
for (const value of [595, 842, 36, 36, 36, 36]) snapshot.f32(value);
snapshot.u8(2); // precision
snapshot.u8(1); // pagination
snapshot.u8(0); // background
snapshot.f32(0);
snapshot.f32(0); // header/footer height
snapshot.u8(0); // static header/footer
snapshot.u8(0); // compression
snapshot.u8(0); // static watermark
snapshot.u32(0); // fonts
snapshot.u32(0); // per-page header/footer
snapshot.u32(0); // per-page watermark
snapshot.u32(1); // nodes
snapshot.u32(0);
snapshot.i32(-1);
snapshot.u8(0);
for (const value of [20, 20, 100, 20]) snapshot.f32(value);
snapshot.u16(0x800);
snapshot.u32(hrefBytes.length);
snapshot.bytes(hrefBytes);
snapshot.u32(0); // images

const wasmUrl = new URL('../wasm/target/wasm32-unknown-unknown/release/dom2pdf_wasm.wasm', import.meta.url);
const wasmBytes = await readFile(wasmUrl);
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: { report_progress() {} }
});

function render(input) {
  const ptr = instance.exports.alloc(input.length);
  new Uint8Array(instance.exports.memory.buffer, ptr, input.length).set(input);
  const pdfPtr = instance.exports.render_pdf(ptr, input.length);
  const pdfLength = instance.exports.render_pdf_len();
  const pdf = new Uint8Array(instance.exports.memory.buffer, pdfPtr, pdfLength).slice();
  instance.exports.free_pdf(pdfPtr, pdfLength);
  instance.exports.dealloc(ptr, input.length);
  return { pdf, pdfLength };
}

const { pdf, pdfLength } = render(snapshot.result());

const source = new TextDecoder('latin1').decode(pdf);
const hrefHex = Array.from(hrefBytes, byte => byte.toString(16).padStart(2, '0'))
  .join('')
  .toUpperCase();
for (const expected of ['/Annots [', '/Subtype /Link', `/URI <${hrefHex}>`]) {
  if (!source.includes(expected)) throw new Error(`Missing PDF link marker: ${expected}`);
}
console.log(`Verified hyperlink annotation in ${pdfLength}-byte PDF.`);

const imageSnapshot = new Writer();
imageSnapshot.bytes([0x44, 0x32, 0x50, 0x31]);
imageSnapshot.u32(11);
for (const value of [300, 300, 30, 30, 30, 30]) imageSnapshot.f32(value);
imageSnapshot.u8(2); // precision
imageSnapshot.u8(1); // pagination
imageSnapshot.u8(0); // background
imageSnapshot.f32(0);
imageSnapshot.f32(0); // header/footer height
imageSnapshot.u8(0); // static header/footer
imageSnapshot.u8(0); // compression
imageSnapshot.u8(0); // static watermark
imageSnapshot.u32(0); // fonts
imageSnapshot.u32(0); // per-page header/footer
imageSnapshot.u32(0); // per-page watermark
imageSnapshot.u32(2); // nodes
// A preceding text line crosses the first page and inserts a 20px flow gap.
imageSnapshot.u32(0);
imageSnapshot.i32(-1);
imageSnapshot.u8(1);
for (const value of [20, 300, 20, 40]) imageSnapshot.f32(value);
imageSnapshot.u16(0x20); // font
const familyBytes = new TextEncoder().encode('Helvetica');
imageSnapshot.u16(familyBytes.length);
imageSnapshot.bytes(familyBytes);
imageSnapshot.f32(16);
imageSnapshot.u16(400);
imageSnapshot.u8(0);
for (const value of [0, 0, 0, 1]) imageSnapshot.f32(value);
imageSnapshot.f32(20);
imageSnapshot.u8(0);
imageSnapshot.f32(0);
imageSnapshot.f32(0);
imageSnapshot.u8(0);
const textBytes = new TextEncoder().encode('A');
imageSnapshot.u32(textBytes.length);
imageSnapshot.bytes(textBytes);
imageSnapshot.u32(1);
for (const value of [20, 300, 20, 40]) imageSnapshot.f32(value);
imageSnapshot.u32(0);
imageSnapshot.u32(1);
// Before text pagination this image fits at the end of page 2. After the
// preceding line shifts it down, only 90px remain, so it must move to page 3.
imageSnapshot.u32(1);
imageSnapshot.i32(-1);
imageSnapshot.u8(2);
for (const value of [20, 530, 100, 100]) imageSnapshot.f32(value);
imageSnapshot.u16(0x1040); // image + avoid image split
imageSnapshot.u32(1);
imageSnapshot.u8(0); // image id + object-fit
imageSnapshot.u32(1); // images
imageSnapshot.u32(1);
imageSnapshot.u32(1);
imageSnapshot.u32(1);
imageSnapshot.u8(0); // raw RGB
imageSnapshot.u32(3);
imageSnapshot.bytes([255, 0, 0]);

const imagePdf = render(imageSnapshot.result()).pdf;
const imageSource = new TextDecoder('latin1').decode(imagePdf);
const draws = imageSource.match(/\/Im1 Do/g)?.length ?? 0;
if (draws !== 1) throw new Error(`Expected an intact image on one page, got ${draws} draws.`);
console.log('Verified that a fitting image moves intact to the next page.');
