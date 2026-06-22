/**
 * DOM snapshot collector. Walks a root element, reads computed styles + rects,
 * slices text nodes into line boxes (with UTF-8 byte offsets), and converts
 * <img> elements to JPEG bytes. Emits the binary Snapshot v2 (see format.ts /
 * snapshot.rs).
 *
 * Public option shape mirrors dompdf.js (format/pagination/pageConfig/fontConfig/
 * backgroundColor/useCORS/...); advanced pt-level overrides are retained.
 */
import { BinWriter } from './format';
import { resolvePageSize } from './pageSizes';
import { base64ToBytes } from './wasm-glue';

// ---- public option types (dompdf.js-aligned) ----

export interface FontConfig {
  fontFamily: string;
  fontBase64?: string;
  fontUrl?: string;
  fontStyle?: 'normal' | 'italic';
  fontWeight?: 400 | 700 | number;
  iconFont?: boolean;
  /** Pre-decoded TTF bytes (alternative to fontBase64). */
  fontBytes?: Uint8Array;
}

export type ContentPosition =
  | 'center' | 'centerLeft' | 'centerRight' | 'centerTop' | 'centerBottom'
  | 'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom'
  | [number, number];

export interface PageConfigOptions {
  header?: PageRegionConfig;
  footer?: PageRegionConfig;
}

export interface PageRegionConfig {
  content?: string | ((renderer: unknown, pageNum: number) => void);
  height?: number;
  contentColor?: string;
  contentFontSize?: number;
  contentPosition?: ContentPosition;
  padding?: [number, number, number, number];
}

export type PageConfig = PageConfigOptions | ((pageNum: number, totalPages: number) => PageConfigOptions | null);

export interface ExportOptions {
  /** Allow cross-origin resources (requires server CORS). */
  useCORS?: boolean;
  /** Page background color; null = transparent. */
  backgroundColor?: string | null;
  /** Non-Latin font registration (TTF, base64). */
  fontConfig?: FontConfig | FontConfig[];
  /** PDF encryption config (accepted, not yet implemented — no-op). */
  encryption?: object;
  /** Coordinate precision (decimal places). Default 2. */
  precision?: number;
  /** Compress PDF (accepted, not yet implemented — no-op). */
  compress?: boolean;
  /** Only embed actually-used fonts. Default false. */
  putOnlyUsedFonts?: boolean;
  /** Enable pagination. Default false (single page). */
  pagination?: boolean;
  /** Page size name or [widthPt, heightPt]. Default 'a4'. */
  format?: string | [number, number];
  /** Header/footer config (object = all pages, function = per-page). */
  pageConfig?: PageConfig;
  /** jsPDF instance init hook (accepted, no-op — no jsPDF in this engine). */
  onJspdfReady?: (jspdf: unknown) => void;
  /** jsPDF instance finish hook (accepted, no-op). */
  onJspdfFinish?: (jspdf: unknown) => void;

  // ---- advanced pt-level overrides (take precedence over format/margins) ----
  pageWidthPt?: number;
  pageHeightPt?: number;
  /** Margins in pt: number (all sides) or [top, right, bottom, left]. Default 36. */
  marginPt?: number | [number, number, number, number];
  jpegQuality?: number;
}

// ---- internal types ----

const PX_TO_PT = 0.75; // 96 dpi -> pt
const BORDER_SOLID = 0;
const BORDER_DASHED = 1;

function computeLayoutScale(rootWidthPx: number, pageWidthPt: number, mLeftPt: number, mRightPt: number): number {
  if (!(rootWidthPx > 0)) return 1;
  const contentWidthPx = Math.max(1, (pageWidthPt - mLeftPt - mRightPt) / PX_TO_PT);
  return Math.min(1, contentWidthPx / rootWidthPx);
}

interface CollectedImage {
  id: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

interface CollectedFont {
  family: string;
  style: number; // 0 normal, 1 italic
  weight: number;
  iconFont: boolean;
  bytes: Uint8Array;
}

interface LineBox {
  x: number;
  y: number;
  w: number;
  h: number;
  start: number;
  end: number;
}

interface NodeRec {
  id: number;
  parent: number;
  kind: number; // 0 box, 1 text, 2 image
  x: number;
  y: number;
  w: number;
  h: number;
  flags: number;
  bg?: [number, number, number, number];
  border?: {
    w: [number, number, number, number];
    c: [number, number, number, number];
    s: [number, number, number, number];
  };
  radius?: [number, number, number, number];
  overflowHidden: boolean;
  opacity?: number;
  font?: {
    family: string;
    sizePx: number;
    weight: number;
    italic: number;
    color: [number, number, number, number];
    lineHeightPx: number;
    align: number;
    letterSpacingPx: number;
    wordSpacingPx: number;
  };
  imageId?: number;
  objectFit?: number; // 0 fill, 1 contain, 2 cover, 3 none, 4 scale-down
  renderMode: number;
  divisionDisable: boolean;
  pageBreak: boolean;
  text?: string;
  lines?: LineBox[];
}

// flag bits (must match Rust snapshot.rs)
const F_BG = 0x01;
const F_BORDER = 0x02;
const F_RADIUS = 0x04;
const F_OVERFLOW = 0x08;
const F_OPACITY = 0x10;
const F_FONT = 0x20;
const F_IMAGE = 0x40;
const F_RENDER_MODE = 0x80;
const F_DIVISION_DISABLE = 0x100;
const F_PAGE_BREAK = 0x200;

// header/footer position enum (must match Rust HFSpec.position)
function positionNum(p: ContentPosition | undefined): number {
  if (Array.isArray(p)) return 9;
  switch (p) {
    case 'center': return 0;
    case 'centerLeft': return 1;
    case 'centerRight': return 2;
    case 'centerTop': return 3;
    case 'centerBottom': return 4;
    case 'leftTop': return 5;
    case 'leftBottom': return 6;
    case 'rightTop': return 7;
    case 'rightBottom': return 8;
    default: return 0;
  }
}

// ---- color parsing via canvas ----
const colorCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const colorCtx = colorCanvas ? colorCanvas.getContext('2d')! : null;

function parseColor(str: string | null | undefined): [number, number, number, number] {
  if (!colorCtx) return [0, 0, 0, 1];
  if (!str) return [0, 0, 0, 0];
  colorCtx.fillStyle = '#000';
  colorCtx.fillStyle = str;
  const f = colorCtx.fillStyle;
  if (typeof f === 'string' && f.startsWith('#')) {
    return [
      parseInt(f.slice(1, 3), 16) / 255,
      parseInt(f.slice(3, 5), 16) / 255,
      parseInt(f.slice(5, 7), 16) / 255,
      1,
    ];
  }
  const m = /rgba?\(([^)]+)\)/.exec(f);
  if (m) {
    const p = m[1].split(',').map((s) => parseFloat(s));
    return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] === undefined ? 1 : p[3]];
  }
  return [0, 0, 0, 0];
}

function weightNum(w: string): number {
  if (w === 'bold') return 700;
  if (w === 'normal') return 400;
  const n = parseInt(w, 10);
  return isNaN(n) ? 400 : n;
}

function alignNum(a: string): number {
  switch (a) {
    case 'right': return 1;
    case 'center': return 2;
    case 'justify': return 3;
    default: return 0;
  }
}

function objectFitNum(v: string): number {
  switch ((v || '').trim()) {
    case 'contain': return 1;
    case 'cover': return 2;
    case 'none': return 3;
    case 'scale-down': return 4;
    default: return 0;
  }
}

function borderStyleNum(style: string): number {
  return style === 'dashed' ? BORDER_DASHED : BORDER_SOLID;
}

function utf8LenCP(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

function utf8Offsets(text: string): Int32Array {
  const n = text.length;
  const off = new Int32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        acc += utf8LenCP(cp);
        off[i + 1] = off[i];
        off[i + 2] = acc;
        i++;
        continue;
      }
    }
    acc += utf8LenCP(c);
    off[i + 1] = acc;
  }
  return off;
}

async function convertImage(
  img: HTMLImageElement,
  quality: number,
  useCORS: boolean,
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  try {
    if (useCORS) img.crossOrigin = 'anonymous';
    if (!img.complete || img.naturalWidth === 0) {
      await img.decode().catch(() => null);
    }
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, 'image/jpeg', quality),
    );
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, width: w, height: h };
  } catch {
    return null;
  }
}

interface ParsedGradientStop {
  color: [number, number, number, number];
  pos: number;
}

interface ParsedLinearGradient {
  angleDeg: number;
  stops: ParsedGradientStop[];
}

function splitTopLevelComma(input: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      out.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(input.slice(start).trim());
  return out.filter(Boolean);
}

function gradientAngleDeg(token: string): number | null {
  const v = token.trim().toLowerCase();
  const deg = /^([+-]?\d+(?:\.\d+)?)deg$/.exec(v);
  if (deg) return parseFloat(deg[1]);
  switch (v) {
    case 'to top': return 0;
    case 'to right': return 90;
    case 'to bottom': return 180;
    case 'to left': return 270;
    case 'to top right':
    case 'to right top': return 45;
    case 'to bottom right':
    case 'to right bottom': return 135;
    case 'to bottom left':
    case 'to left bottom': return 225;
    case 'to top left':
    case 'to left top': return 315;
    default: return null;
  }
}

function parseLinearGradient(input: string): ParsedLinearGradient | null {
  const src = input.trim();
  if (!src.startsWith('linear-gradient(') || !src.endsWith(')')) return null;
  const inner = src.slice('linear-gradient('.length, -1).trim();
  const parts = splitTopLevelComma(inner);
  if (parts.length < 2) return null;

  let angleDeg = 180;
  let stopStart = 0;
  const maybeAngle = gradientAngleDeg(parts[0]);
  if (maybeAngle !== null) {
    angleDeg = maybeAngle;
    stopStart = 1;
  }

  const rawStops = parts.slice(stopStart).map((part) => {
    const m = /^(.*?)(?:\s+([+-]?\d+(?:\.\d+)?)%)?$/.exec(part.trim());
    if (!m) return null;
    const color = parseColor(m[1].trim());
    return {
      color,
      pos: m[2] == null ? null : parseFloat(m[2]) / 100,
    };
  }).filter((v): v is { color: [number, number, number, number]; pos: number | null } => !!v);

  if (rawStops.length < 2) return null;
  if (rawStops[0].pos == null) rawStops[0].pos = 0;
  if (rawStops[rawStops.length - 1].pos == null) rawStops[rawStops.length - 1].pos = 1;
  for (let i = 0; i < rawStops.length; i++) {
    if (rawStops[i].pos != null) continue;
    let j = i + 1;
    while (j < rawStops.length && rawStops[j].pos == null) j++;
    const left = rawStops[i - 1].pos ?? 0;
    const right = j < rawStops.length ? (rawStops[j].pos ?? 1) : 1;
    const span = j - i + 1;
    for (let k = i; k < j; k++) {
      rawStops[k].pos = left + ((right - left) * (k - i + 1)) / span;
    }
    i = j - 1;
  }

  return {
    angleDeg,
    stops: rawStops.map((stop) => ({
      color: stop.color,
      pos: Math.min(1, Math.max(0, stop.pos ?? 0)),
    })),
  };
}

function rgbaCss(c: [number, number, number, number]): string {
  return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3]})`;
}

function convertLinearGradientToImage(
  gradientText: string,
  width: number,
  height: number,
  quality: number,
  fallbackBg: [number, number, number, number] | null,
): { bytes: Uint8Array; width: number; height: number } | null {
  const spec = parseLinearGradient(gradientText);
  if (!spec) return null;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (fallbackBg && fallbackBg[3] > 0.001) {
    ctx.fillStyle = rgbaCss(fallbackBg);
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }

  const rad = (spec.angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.abs(dx) * w / 2 + Math.abs(dy) * h / 2;
  const grad = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half);
  for (const stop of spec.stops) {
    grad.addColorStop(stop.pos, rgbaCss(stop.color));
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  return {
    bytes: base64ToBytes(dataUrl.slice(comma + 1)),
    width: w,
    height: h,
  };
}

interface ResolvedHF {
  content: string;
  heightPx: number;
  color: [number, number, number, number];
  fontSizePx: number;
  position: number;
  custom: [number, number] | null;
  padding: [number, number, number, number];
}

function resolveRegion(
  region: PageRegionConfig | undefined,
  isFooter: boolean,
): ResolvedHF | null {
  if (!region) return null;
  const content = typeof region.content === 'string' ? region.content
    : isFooter ? '${currentPage}/${totalPages}'
    : '';
  const pos = region.contentPosition;
  return {
    content,
    heightPx: region.height ?? 50,
    color: parseColor(region.contentColor ?? '#333333'),
    fontSizePx: region.contentFontSize ?? 16,
    position: positionNum(pos),
    custom: Array.isArray(pos) ? pos : null,
    padding: region.padding ?? [0, 24, 0, 24],
  };
}

function resolvePlaceholder(content: string, page: number, total: number): string {
  return content
    .replace(/\$\{currentPage\}/g, String(page + 1))
    .replace(/\$\{totalPages\}/g, String(total));
}

export async function collectSnapshot(
  root: HTMLElement,
  options: ExportOptions = {},
): Promise<Uint8Array> {
  const data = await collectSnapshotData(root, options);
  return encodeSnapshot(data, []);
}

/** Collect the DOM walk into an intermediate form (no per-page HF yet). */
export async function collectSnapshotData(
  root: HTMLElement,
  options: ExportOptions = {},
): Promise<EncodeArgs> {
  // jsPDF hooks: accepted but no-op (engine has no jsPDF instance).
  if (options.onJspdfReady) {
    console.warn('dom2pdf: onJspdfReady is accepted but not implemented (no jsPDF engine).');
  }
  if (options.onJspdfFinish) {
    console.warn('dom2pdf: onJspdfFinish is accepted but not implemented (no jsPDF engine).');
  }
  if (options.compress) {
    console.warn('dom2pdf: compress is accepted but not yet implemented (PDF emitted uncompressed).');
  }
  if (options.encryption) {
    console.warn('dom2pdf: encryption is accepted but not yet implemented.');
  }

  const [fmtW, fmtH] = resolvePageSize(options.format);
  const pageWidthPt = options.pageWidthPt ?? fmtW;
  const pageHeightPt = options.pageHeightPt ?? fmtH;
  const m = options.marginPt ?? 36;
  const [mTop, mRight, mBottom, mLeft] = Array.isArray(m) ? m : [m, m, m, m];
  const quality = options.jpegQuality ?? 0.85;
  const useCORS = options.useCORS ?? false;
  const pagination = options.pagination ?? false;
  const precision = (options.precision ?? 2) | 0;

  // Fonts
  const fontConfigs = options.fontConfig
    ? Array.isArray(options.fontConfig) ? options.fontConfig : [options.fontConfig]
    : [];
  const fonts: CollectedFont[] = [];
  for (const fc of fontConfigs) {
    let bytes: Uint8Array | undefined = fc.fontBytes;
    if (!bytes && fc.fontBase64) bytes = base64ToBytes(fc.fontBase64);
    if (!bytes || bytes.length === 0) continue;
    fonts.push({
      family: fc.fontFamily,
      style: fc.fontStyle === 'italic' ? 1 : 0,
      weight: fc.fontWeight ?? 400,
      iconFont: fc.iconFont ?? false,
      bytes,
    });
  }

  // pageConfig: object form -> static HF (Rust resolves placeholders).
  //            function form -> per-page resolved text (JS resolves placeholders),
  //            needs totalPages via count_pages (handled by caller in index.ts).
  const staticHF = typeof options.pageConfig === 'object' ? options.pageConfig : null;

  // Pre-collect images.
  const imgElements = Array.from(root.querySelectorAll('img'));
  const images: CollectedImage[] = [];
  const imgToId = new Map<HTMLElement, number>();
  await Promise.all(
    imgElements.map(async (img) => {
      const conv = await convertImage(img, quality, useCORS);
      if (!conv) return;
      const id = images.length + 1;
      images.push({ id, ...conv });
      imgToId.set(img, id);
    }),
  );

  const rootRect = root.getBoundingClientRect();
  const offX = rootRect.left + window.scrollX;
  const offY = rootRect.top + window.scrollY;
  const layoutScale = computeLayoutScale(rootRect.width, pageWidthPt, mLeft, mRight);

  const nodes: NodeRec[] = [];
  const range = document.createRange();

  function docRect(r: DOMRect): { x: number; y: number; w: number; h: number } {
    return {
      x: (r.left + window.scrollX - offX) * layoutScale,
      y: (r.top + window.scrollY - offY) * layoutScale,
      w: r.width * layoutScale,
      h: r.height * layoutScale,
    };
  }

  function charTop(textNode: Text, i: number): number {
    if (i >= textNode.data.length) return Infinity;
    range.setStart(textNode, i);
    range.setEnd(textNode, Math.min(i + 1, textNode.data.length));
    const r = range.getBoundingClientRect();
    return r.top || 0;
  }

  function lowerBoundTop(textNode: Text, target: number, lo: number, hi: number): number {
    let l = lo;
    let r = hi;
    while (l < r) {
      const mid = (l + r) >> 1;
      if (charTop(textNode, mid) < target) l = mid + 1;
      else r = mid;
    }
    return l;
  }

  function collectTextLines(textNode: Text): LineBox[] {
    const text = textNode.data;
    if (!text || !text.trim()) return [];
    range.selectNodeContents(textNode);
    let rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return [];
    rects = rects.slice().sort((a, b) => a.top - b.top || a.left - b.left);
    const groups: DOMRect[] = [];
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (groups.length === 0 || Math.abs(r.top - groups[groups.length - 1].top) >= 1) {
        groups.push(new DOMRect(r.left, r.top, r.width, r.height));
      } else {
        const g = groups[groups.length - 1];
        const left = Math.min(g.left, r.left);
        const top = Math.min(g.top, r.top);
        const right = Math.max(g.right, r.right);
        const bottom = Math.max(g.bottom, r.bottom);
        groups[groups.length - 1] = new DOMRect(left, top, right - left, bottom - top);
      }
    }
    const off = utf8Offsets(text);
    const n = text.length;
    if (groups.length === 1) {
      const d = docRect(groups[0]);
      return [{ x: d.x, y: d.y, w: d.w, h: d.h, start: 0, end: off[n] }];
    }
    const lines: LineBox[] = [];
    let prev = 0;
    for (let li = 0; li < groups.length; li++) {
      const r = groups[li];
      const start16 = lowerBoundTop(textNode, r.top - 1, prev, n);
      const nextTop = li + 1 < groups.length ? groups[li + 1].top : Infinity;
      const end16 = lowerBoundTop(textNode, nextTop - 1, start16, n);
      prev = end16;
      if (end16 <= start16) continue;
      const d = docRect(r);
      lines.push({
        x: d.x, y: d.y, w: d.w, h: d.h,
        start: off[start16],
        end: off[Math.min(end16, n)],
      });
    }
    return lines;
  }

  function makeFont(cs: CSSStyleDeclaration): NodeRec['font'] {
    const sizePx = (parseFloat(cs.fontSize) || 16) * layoutScale;
    let lh = parseFloat(cs.lineHeight);
    if (isNaN(lh)) lh = sizePx * 1.2;
    else lh *= layoutScale;
    const letterSpacingPx = (parseFloat(cs.letterSpacing) || 0) * layoutScale;
    const wordSpacingPx = (parseFloat(cs.wordSpacing) || 0) * layoutScale;
    return {
      family: (cs.fontFamily || 'Helvetica').split(',')[0].replace(/['"]/g, '').trim(),
      sizePx,
      weight: weightNum(cs.fontWeight),
      italic: cs.fontStyle === 'italic' || cs.fontStyle === 'oblique' ? 1 : 0,
      color: parseColor(cs.color),
      lineHeightPx: lh,
      align: alignNum(cs.textAlign),
      letterSpacingPx,
      wordSpacingPx,
    };
  }

  function visit(el: HTMLElement, parentId: number) {
    const id = nodes.length;
    const cs = getComputedStyle(el);
    const r = docRect(el.getBoundingClientRect());

    const isImg = el.tagName === 'IMG' && imgToId.has(el);
    const kind = isImg ? 2 : 0;

    const bg = parseColor(cs.backgroundColor);
    const hasBg = bg[3] > 0.001;
    const gradientImage = !isImg && kind === 0 && r.w > 0 && r.h > 0
      ? convertLinearGradientToImage(cs.backgroundImage, r.w, r.h, quality, hasBg ? bg : null)
      : null;
    const bw: [number, number, number, number] = [
      (parseFloat(cs.borderTopWidth) || 0) * layoutScale,
      (parseFloat(cs.borderRightWidth) || 0) * layoutScale,
      (parseFloat(cs.borderBottomWidth) || 0) * layoutScale,
      (parseFloat(cs.borderLeftWidth) || 0) * layoutScale,
    ];
    const bc = parseColor(cs.borderTopColor);
    const bs: [number, number, number, number] = [
      borderStyleNum(cs.borderTopStyle),
      borderStyleNum(cs.borderRightStyle),
      borderStyleNum(cs.borderBottomStyle),
      borderStyleNum(cs.borderLeftStyle),
    ];
    const hasBorder = (bw[0] > 0 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden')
      || (bw[1] > 0 && cs.borderRightStyle !== 'none' && cs.borderRightStyle !== 'hidden')
      || (bw[2] > 0 && cs.borderBottomStyle !== 'none' && cs.borderBottomStyle !== 'hidden')
      || (bw[3] > 0 && cs.borderLeftStyle !== 'none' && cs.borderLeftStyle !== 'hidden');
    const visibleBorder = hasBorder && bc[3] > 0.001;
    const radius: [number, number, number, number] = [
      (parseFloat(cs.borderTopLeftRadius) || 0) * layoutScale,
      (parseFloat(cs.borderTopRightRadius) || 0) * layoutScale,
      (parseFloat(cs.borderBottomRightRadius) || 0) * layoutScale,
      (parseFloat(cs.borderBottomLeftRadius) || 0) * layoutScale,
    ];
    const hasRadius = (radius[0] + radius[1] + radius[2] + radius[3]) > 0;
    const overflowHidden = cs.overflow === 'hidden' || cs.overflow === 'clip';
    const opacity = parseFloat(cs.opacity);
    const hasOpacity = opacity < 1;

    const dm = el.dataset.dom2pdfMode;
    const renderMode = dm === 'raster' ? 1 : dm === 'skip' ? 2 : 0;

    const divisionDisable = el.hasAttribute('divisionDisable');
    const pageBreak = el.hasAttribute('pageBreak');

    let flags = 0;
    if (hasBg) flags |= F_BG;
    if (visibleBorder) flags |= F_BORDER;
    if (hasRadius) flags |= F_RADIUS;
    if (overflowHidden) flags |= F_OVERFLOW;
    if (hasOpacity) flags |= F_OPACITY;
    if (isImg) flags |= F_IMAGE;
    if (renderMode !== 0) flags |= F_RENDER_MODE;
    if (divisionDisable) flags |= F_DIVISION_DISABLE;
    if (pageBreak) flags |= F_PAGE_BREAK;

    const node: NodeRec = {
      id,
      parent: parentId,
      kind,
      x: r.x, y: r.y, w: r.w, h: r.h,
      flags,
      bg: hasBg ? bg : undefined,
      border: visibleBorder ? { w: bw, c: bc, s: bs } : undefined,
      radius: hasRadius ? radius : undefined,
      overflowHidden,
      opacity: hasOpacity ? opacity : undefined,
      renderMode,
      divisionDisable,
      pageBreak,
      imageId: isImg ? imgToId.get(el) : undefined,
      objectFit: isImg ? objectFitNum(cs.objectFit) : undefined,
    };

    if (el.tagName === 'SVG' || el.tagName === 'CANVAS') {
      node.renderMode = 1;
      if (renderMode === 0) flags &= ~F_RENDER_MODE;
      if (node.renderMode !== 0) flags |= F_RENDER_MODE;
      node.flags = flags;
    }

    nodes.push(node);

    if (gradientImage) {
      const imageId = images.length + 1;
      images.push({ id: imageId, ...gradientImage });
      const bgImageNode: NodeRec = {
        id: nodes.length,
        parent: id,
        kind: 2,
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        flags: F_IMAGE | (hasRadius ? F_RADIUS : 0),
        radius: hasRadius ? radius : undefined,
        overflowHidden: false,
        renderMode: 0,
        divisionDisable: false,
        pageBreak: false,
        imageId,
        objectFit: 0,
      };
      nodes.push(bgImageNode);
    }

    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        visit(child as HTMLElement, id);
      } else if (child.nodeType === 3) {
        const text = (child as Text).data;
        if (!text || !text.trim()) continue;
        const lines = collectTextLines(child as Text);
        if (lines.length === 0) continue;
        const font = makeFont(cs);
        const textId = nodes.length;
        const textNode: NodeRec = {
          id: textId,
          parent: id,
          kind: 1,
          x: lines[0].x,
          y: lines[0].y,
          w: Math.max(...lines.map((l) => l.x + l.w)) - Math.min(...lines.map((l) => l.x)),
          h: Math.max(...lines.map((l) => l.y + l.h)) - Math.min(...lines.map((l) => l.y)),
          flags: F_FONT,
          font,
          overflowHidden: false,
          renderMode: 0,
          divisionDisable: false,
          pageBreak: false,
          text,
          lines,
        };
        nodes.push(textNode);
      }
    }
  }

  visit(root, -1);

  // Resolve config-level HF geometry.
  const staticHeader = staticHF ? resolveRegion(staticHF.header, false) : null;
  const staticFooter = staticHF ? resolveRegion(staticHF.footer, true) : null;
  // Function-form: sample page 1 to derive a uniform reserved band height.
  // (Pagination needs a single content-area height; per-page text is resolved
  // later by index.ts once totalPages is known.)
  let headerHPx = staticHeader?.heightPx ?? 0;
  let footerHPx = staticFooter?.heightPx ?? 0;
  if (typeof options.pageConfig === 'function' && pagination) {
    const sample = options.pageConfig(1, 1);
    if (sample) {
      const sh = resolveRegion(sample.header, false);
      const sf = resolveRegion(sample.footer, true);
      headerHPx = sh?.heightPx ?? 0;
      footerHPx = sf?.heightPx ?? 0;
    }
  }

  return {
    pageWidthPt, pageHeightPt, mTop, mRight, mBottom, mLeft,
    precision, pagination, backgroundColor: options.backgroundColor ?? null,
    headerHPx, footerHPx,
    staticHeader, staticFooter,
    perPageHF: [],
    fonts, nodes, images,
  };
}

/** Encode collected data into the v2 snapshot binary, attaching per-page HF. */
export function encodeSnapshot(
  data: EncodeArgs,
  perPageHF: ResolvedPageHF[],
): Uint8Array {
  // Convert ResolvedPageHF[] to the [header, footer] pair shape encode() expects.
  const pairs: (ResolvedHF | null)[][] = perPageHF.map((hf) => [hf.header, hf.footer]);
  return encode({ ...data, perPageHF: pairs });
}

export interface EncodeArgs {
  pageWidthPt: number;
  pageHeightPt: number;
  mTop: number; mRight: number; mBottom: number; mLeft: number;
  precision: number;
  pagination: boolean;
  backgroundColor: string | null;
  headerHPx: number;
  footerHPx: number;
  staticHeader: ResolvedHF | null;
  staticFooter: ResolvedHF | null;
  perPageHF: (ResolvedHF | null)[][]; // each: [header|null, footer|null]
  fonts: CollectedFont[];
  nodes: NodeRec[];
  images: CollectedImage[];
}

function writeHF(w: BinWriter, hf: ResolvedHF) {
  const clen = BinWriter.utf8Len(hf.content);
  w.u16(clen);
  w.utf8(hf.content);
  w.f32(hf.heightPx);
  w.f32(hf.color[0]); w.f32(hf.color[1]); w.f32(hf.color[2]); w.f32(hf.color[3]);
  w.f32(hf.fontSizePx);
  w.u8(hf.position);
  if (hf.position === 9 && hf.custom) {
    w.f32(hf.custom[0]); w.f32(hf.custom[1]);
  }
  w.f32(hf.padding[0]); w.f32(hf.padding[1]); w.f32(hf.padding[2]); w.f32(hf.padding[3]);
}

function writeOptHF(w: BinWriter, hf: ResolvedHF | null) {
  if (hf) {
    w.u8(1);
    writeHF(w, hf);
  } else {
    w.u8(0);
  }
}

function encode(a: EncodeArgs): Uint8Array {
  const w = new BinWriter();
  w.bytes(new Uint8Array([0x44, 0x32, 0x50, 0x31])); // "D2P1"
  w.u32(3); // version 3
  w.f32(a.pageWidthPt);
  w.f32(a.pageHeightPt);
  w.f32(a.mTop);
  w.f32(a.mRight);
  w.f32(a.mBottom);
  w.f32(a.mLeft);

  // Config block
  w.u8(a.precision);
  w.u8(a.pagination ? 1 : 0);
  const bg = a.backgroundColor == null ? null : parseColor(a.backgroundColor);
  w.u8(bg && bg[3] > 0.001 ? 1 : 0);
  if (bg && bg[3] > 0.001) {
    w.f32(bg[0]); w.f32(bg[1]); w.f32(bg[2]); w.f32(bg[3]);
  }
  w.f32(a.headerHPx);
  w.f32(a.footerHPx);
  const hasStatic = a.staticHeader || a.staticFooter;
  w.u8(hasStatic ? 1 : 0);
  if (hasStatic) {
    writeOptHF(w, a.staticHeader);
    writeOptHF(w, a.staticFooter);
  }

  // Fonts block
  w.u32(a.fonts.length);
  for (const f of a.fonts) {
    const famLen = BinWriter.utf8Len(f.family);
    w.u16(famLen);
    w.utf8(f.family);
    w.u8(f.style);
    w.u16(f.weight);
    w.u8(f.iconFont ? 1 : 0);
    w.u32(f.bytes.length);
    w.bytes(f.bytes);
  }

  // Per-page HF block
  w.u32(a.perPageHF.length);
  for (const pair of a.perPageHF) {
    writeOptHF(w, pair[0]);
    writeOptHF(w, pair[1]);
  }

  // Nodes
  w.u32(a.nodes.length);
  for (const n of a.nodes) {
    w.u32(n.id);
    w.i32(n.parent);
    w.u8(n.kind);
    w.f32(n.x); w.f32(n.y); w.f32(n.w); w.f32(n.h);
    let flags = n.flags;
    if (n.bg) flags |= F_BG;
    if (n.border) flags |= F_BORDER;
    if (n.radius) flags |= F_RADIUS;
    if (n.overflowHidden) flags |= F_OVERFLOW;
    if (n.opacity !== undefined) flags |= F_OPACITY;
    if (n.font) flags |= F_FONT;
    if (n.imageId !== undefined) flags |= F_IMAGE;
    if (n.renderMode !== 0) flags |= F_RENDER_MODE;
    if (n.divisionDisable) flags |= F_DIVISION_DISABLE;
    if (n.pageBreak) flags |= F_PAGE_BREAK;
    w.u16(flags);
    if (n.bg) {
      w.f32(n.bg[0]); w.f32(n.bg[1]); w.f32(n.bg[2]); w.f32(n.bg[3]);
    }
    if (n.border) {
      w.f32(n.border.w[0]); w.f32(n.border.w[1]); w.f32(n.border.w[2]); w.f32(n.border.w[3]);
      w.f32(n.border.c[0]); w.f32(n.border.c[1]); w.f32(n.border.c[2]); w.f32(n.border.c[3]);
      w.u8(n.border.s[0]); w.u8(n.border.s[1]); w.u8(n.border.s[2]); w.u8(n.border.s[3]);
    }
    if (n.radius) {
      w.f32(n.radius[0]); w.f32(n.radius[1]); w.f32(n.radius[2]); w.f32(n.radius[3]);
    }
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
      w.f32(n.font.letterSpacingPx);
      w.f32(n.font.wordSpacingPx);
    }
    if (n.imageId !== undefined) {
      w.u32(n.imageId);
      w.u8(n.objectFit ?? 0);
    }
    if (n.renderMode !== 0) w.u8(n.renderMode);
    if (n.kind === 1) {
      const text = n.text ?? '';
      const tlen = BinWriter.utf8Len(text);
      w.u32(tlen);
      w.utf8(text);
      const lines = n.lines ?? [];
      w.u32(lines.length);
      for (const l of lines) {
        w.f32(l.x); w.f32(l.y); w.f32(l.w); w.f32(l.h);
        w.u32(l.start); w.u32(l.end);
      }
    }
  }

  // Images
  w.u32(a.images.length);
  for (const img of a.images) {
    w.u32(img.id);
    w.u32(img.width);
    w.u32(img.height);
    w.u32(img.bytes.length);
    w.bytes(img.bytes);
  }

  return w.result();
}

/** Compute page-break Y positions (document px, relative to root top) for overlays. */
export function computePageBreaks(root: HTMLElement, options: ExportOptions = {}): number[] {
  const [fmtW, fmtH] = resolvePageSize(options.format);
  const pageWidthPt = options.pageWidthPt ?? fmtW;
  const pageHeightPt = options.pageHeightPt ?? fmtH;
  const m = options.marginPt ?? 36;
  const mTop = Array.isArray(m) ? m[0] : m;
  const mRight = Array.isArray(m) ? m[1] : m;
  const mBottom = Array.isArray(m) ? m[2] : m;
  const mLeft = Array.isArray(m) ? m[3] : m;
  const pagination = options.pagination ?? false;
  if (!pagination) return [];
  const staticHF = typeof options.pageConfig === 'object' ? options.pageConfig : null;
  const headerHPt = (staticHF?.header?.height ?? 0) * PX_TO_PT;
  const footerHPt = (staticHF?.footer?.height ?? 0) * PX_TO_PT;
  const contentHpt = pageHeightPt - mTop - mBottom - headerHPt - footerHPt;
  const contentHpx = (contentHpt > 0 ? contentHpt : pageHeightPt - mTop - mBottom) / PX_TO_PT;
  const layoutScale = computeLayoutScale(root.getBoundingClientRect().width, pageWidthPt, mLeft, mRight);
  const rootH = root.getBoundingClientRect().height;
  const breaks: number[] = [];
  const breakStep = contentHpx / layoutScale;
  for (let y = breakStep; y < rootH; y += breakStep) breaks.push(y);
  return breaks;
}

// ---- function-form pageConfig support ----
//
// collectSnapshot above emits a snapshot with no per-page HF. For function-form
// pageConfig the caller needs totalPages first (via the worker count_pages op),
// then resolves per-page HF and re-encodes. To avoid walking the DOM twice, the
// resolved geometry is produced here from the already-collected pageConfig.

export interface ResolvedPageHF {
  header: ResolvedHF | null;
  footer: ResolvedHF | null;
}

/** Resolve per-page HF for a function-form pageConfig given totalPages. */
export function resolvePerPageHF(
  pageConfig: (pageNum: number, totalPages: number) => PageConfigOptions | null,
  totalPages: number,
): ResolvedPageHF[] {
  const out: ResolvedPageHF[] = [];
  for (let p = 0; p < totalPages; p++) {
    const cfg = pageConfig(p + 1, totalPages);
    if (!cfg) {
      out.push({ header: null, footer: null });
      continue;
    }
    out.push({
      header: resolveRegion(cfg.header, false),
      footer: resolveRegion(cfg.footer, true),
    });
  }
  return out;
}

/** Replace placeholders in a resolved HF set (function-form: JS resolves). */
export function resolvePerPageHFText(
  perPage: ResolvedPageHF[],
  totalPages: number,
): ResolvedPageHF[] {
  return perPage.map((hf, p) => ({
    header: hf.header
      ? { ...hf.header, content: resolvePlaceholder(hf.header.content, p, totalPages) }
      : null,
    footer: hf.footer
      ? { ...hf.footer, content: resolvePlaceholder(hf.footer.content, p, totalPages) }
      : null,
  }));
}

export { resolveRegion, resolvePlaceholder };
export type { ResolvedHF };
