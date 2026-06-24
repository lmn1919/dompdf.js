/**
 * Binary Snapshot v1 encoder. Must match packages/dom2pdf-wasm/src/snapshot.rs.
 * All integers little-endian; floats = f32 LE.
 */

export class BinWriter {
  private buf: Uint8Array;
  private dv: DataView;
  pos = 0;

  constructor(cap = 4096) {
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.pos + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf);
    this.buf = nb;
    this.dv = new DataView(this.buf.buffer);
  }

  u8(v: number) {
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }
  u16(v: number) {
    this.ensure(2);
    this.dv.setUint16(this.pos, v, true);
    this.pos += 2;
  }
  u32(v: number) {
    this.ensure(4);
    this.dv.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
  }
  i32(v: number) {
    this.ensure(4);
    this.dv.setInt32(this.pos, v | 0, true);
    this.pos += 4;
  }
  f32(v: number) {
    this.ensure(4);
    this.dv.setFloat32(this.pos, v, true);
    this.pos += 4;
  }
  bytes(b: ArrayLike<number>) {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
  }
  /** UTF-8 length without allocating the encoded bytes. */
  static utf8Len(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }
  utf8(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }

  result(): Uint8Array {
    // Return a compact copy so the backing buffer can be transferred cleanly.
    const out = new Uint8Array(this.pos);
    out.set(this.buf.subarray(0, this.pos));
    return out;
  }
}
