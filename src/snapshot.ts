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
  /** Unicode ranges this font should handle in legacy langFontConfig mode. */
  charRange?: [number, number][];
  /** Default fallback font in legacy langFontConfig mode. */
  isDefault?: boolean;
  /** Pre-decoded TTF bytes (alternative to fontBase64). */
  fontBytes?: Uint8Array;
}

export type ContentPosition =
  | 'center' | 'centerLeft' | 'centerRight' | 'centerTop' | 'centerBottom'
  | 'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom'
  | [number, number];

interface ExcludedPagesConfig {
  /** Legacy object-form pageConfig field: skip header/footer on a page or pages. */
  excludePage?: number | number[];
  /** Explicit plural alias for object-form pageConfig exclusions. */
  excludePages?: number[];
}

export interface PageConfigOptions extends ExcludedPagesConfig {
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

export type EncryptionPermission = 'print' | 'modify' | 'copy' | 'annot-forms';

export type WatermarkLayer = 'under' | 'over';

interface BaseWatermarkOptions extends ExcludedPagesConfig {
  angle?: number;
  spacing?: [number, number];
  offset?: [number, number];
  layer?: WatermarkLayer;
}

export interface TextWatermarkOptions extends BaseWatermarkOptions {
  text: string;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: 400 | 700 | number;
  italic?: boolean;
}

export interface ImageWatermarkOptions extends BaseWatermarkOptions {
  imageUrl: string;
  imageWidth?: number;
  imageHeight?: number;
  opacity?: number;
}

export type WatermarkOptions = TextWatermarkOptions | ImageWatermarkOptions;

export type WatermarkConfig =
  | WatermarkOptions
  | ((pageNum: number, totalPages: number) => WatermarkOptions | null);

export interface PdfEncryptionOptions {
  userPassword?: string;
  ownerPassword?: string;
  userPermissions?: EncryptionPermission[];
}

/**
 * Default pageConfig applied when `pagination` is enabled but no `pageConfig`
 * is supplied — mirrors dompdf.js (main branch) so paginated exports get a
 * page-number footer by default. Header reserves a 50px band (empty content);
 * footer renders `${currentPage}/${totalPages}`. Only engaged in paginated
 * mode: the original library overlays HF in single-page mode without reserving
 * height, which this engine cannot replicate, so single-page stays HF-free
 * unless an explicit pageConfig is passed.
 */
const DEFAULT_PAGE_CONFIG: PageConfigOptions = {
  header: {
    content: '',
    height: 50,
    contentPosition: 'centerRight',
    contentColor: '#333333',
    contentFontSize: 16,
    padding: [0, 24, 0, 24],
  },
  footer: {
    content: '${currentPage}/${totalPages}',
    height: 50,
    contentPosition: 'center',
    contentColor: '#333333',
    contentFontSize: 16,
    padding: [0, 24, 0, 24],
  },
};

/** Resolve the effective static (object-form) pageConfig, honoring the library default. */
function resolveStaticHF(options: ExportOptions, pagination: boolean): PageConfigOptions | null {
  if (typeof options.pageConfig === 'object') return options.pageConfig;
  // Match dompdf.js: `opts.pageConfig ?? DEFAULT` — null/undefined falls back to default.
  // Gated on pagination to avoid reserving HF height in single-page mode (engine limitation).
  if (pagination && options.pageConfig == null) return DEFAULT_PAGE_CONFIG;
  return null;
}

function normalizePageNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const pageNum = Math.trunc(value);
  return pageNum > 0 ? pageNum : null;
}

function normalizeExcludedPages(config: ExcludedPagesConfig | null | undefined): number[] {
  if (!config) return [];
  const raw = [
    ...(Array.isArray(config.excludePage)
      ? config.excludePage
      : config.excludePage == null
        ? []
        : [config.excludePage]),
    ...(config.excludePages ?? []),
  ];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const value of raw) {
    const pageNum = normalizePageNumber(value);
    if (pageNum == null || seen.has(pageNum)) continue;
    seen.add(pageNum);
    out.push(pageNum);
  }
  return out;
}

function configExcludesPage(config: ExcludedPagesConfig | null | undefined, pageNum: number): boolean {
  return normalizeExcludedPages(config).includes(pageNum);
}

function pageConfigExcludesPage(pageConfig: PageConfigOptions | null | undefined, pageNum: number): boolean {
  return configExcludesPage(pageConfig, pageNum);
}

export function pageConfigNeedsPerPageResolution(pageConfig: PageConfig | undefined): boolean {
  return typeof pageConfig === 'function'
    || (typeof pageConfig === 'object' && pageConfig != null && normalizeExcludedPages(pageConfig).length > 0);
}

export function watermarkNeedsPerPageResolution(watermark: WatermarkConfig | undefined): boolean {
  return typeof watermark === 'function'
    || (typeof watermark === 'object' && watermark != null && normalizeExcludedPages(watermark).length > 0);
}

const warnedLegacyOptions = new Set<string>();

function warnLegacyOption(name: string, detail: string): void {
  if (warnedLegacyOptions.has(name)) return;
  warnedLegacyOptions.add(name);
  console.warn(`dom2pdf: legacy option "${name}" ${detail}`);
}

function normalizeLegacyFontStyle(fontStyle?: string): 'normal' | 'italic' {
  return fontStyle === 'italic' || fontStyle === 'oblique' ? 'italic' : 'normal';
}

function normalizeLegacyFontWeight(fontWeight?: number): 400 | 700 {
  return (fontWeight ?? 400) > 500 ? 700 : 400;
}

function arrayifyFontConfig(fontConfig?: FontConfig | FontConfig[]): FontConfig[] {
  if (!fontConfig) return [];
  return Array.isArray(fontConfig) ? fontConfig : [fontConfig];
}

function dedupeFontConfigs(fontConfigs: FontConfig[]): FontConfig[] {
  const out: FontConfig[] = [];
  const seen = new Set<string>();
  for (const fontConfig of fontConfigs) {
    const key = JSON.stringify({
      charRange: fontConfig.charRange ?? null,
      family: fontConfig.fontFamily,
      iconFont: fontConfig.iconFont ?? false,
      isDefault: fontConfig.isDefault ?? false,
      style: fontConfig.fontStyle ?? 'normal',
      weight: fontConfig.fontWeight ?? 400,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fontConfig);
  }
  return out;
}

function normalizeLegacyOptions(options: ExportOptions = {}): NormalizedExportOptions {
  const normalized: NormalizedExportOptions = {
    ...options,
    fontConfig: arrayifyFontConfig(options.fontConfig),
    langFontConfig: arrayifyFontConfig(options.langFontConfig),
  };

  if (options.allowTaint !== undefined) {
    warnLegacyOption('allowTaint', 'is accepted for API compatibility but is not used by the WASM snapshot pipeline.');
  }
  if (options.cache !== undefined) {
    warnLegacyOption('cache', 'is accepted for API compatibility but cache injection is not supported in the current pipeline.');
  }
  if (options.canvas !== undefined) {
    warnLegacyOption('canvas', 'is accepted for API compatibility but rendering does not target a caller-provided canvas.');
  }
  if (options.floatPrecision !== undefined) {
    warnLegacyOption('floatPrecision', 'is accepted for API compatibility but only `precision` is used by the current PDF encoder.');
  }
  if (options.foreignObjectRendering !== undefined) {
    warnLegacyOption('foreignObjectRendering', 'is accepted for API compatibility but the current pipeline always uses DOM snapshot + WASM rendering.');
  }
  if (options.imageTimeout !== undefined) {
    warnLegacyOption('imageTimeout', 'is accepted for API compatibility but image loading timeout is not configurable in the current pipeline.');
  }
  if (options.logging !== undefined) {
    warnLegacyOption('logging', 'is accepted for API compatibility but there is no runtime logger toggle in the current pipeline.');
  }
  if (options.onclone !== undefined) {
    warnLegacyOption('onclone', 'is accepted for API compatibility but there is no cloned document stage in the current pipeline.');
  }
  if (options.orientation !== undefined) {
    warnLegacyOption('orientation', 'is accepted for API compatibility but page orientation should be expressed through `format` or explicit page sizes.');
  }
  if (options.pdfFileName !== undefined) {
    warnLegacyOption('pdfFileName', 'is accepted for API compatibility but only `downloadPDF(..., filename)` controls the saved filename.');
  }
  if (options.proxy !== undefined) {
    warnLegacyOption('proxy', 'is accepted for API compatibility but proxy-based resource loading is not supported in the current pipeline.');
  }
  if (options.removeContainer !== undefined) {
    warnLegacyOption('removeContainer', 'is accepted for API compatibility but there is no cloned container to remove in the current pipeline.');
  }
  if (options.scale !== undefined) {
    warnLegacyOption('scale', 'is accepted for API compatibility but snapshot rendering uses layout pixels and internal supersampling.');
  }
  if (options.scrollX !== undefined || options.scrollY !== undefined) {
    warnLegacyOption('scrollX/scrollY', 'are accepted for API compatibility but live window scroll offsets are used by the current pipeline.');
  }
  if (options.windowWidth !== undefined || options.windowHeight !== undefined) {
    warnLegacyOption('windowWidth/windowHeight', 'are accepted for API compatibility but the current pipeline reads the live DOM viewport.');
  }
  if (options.x !== undefined || options.y !== undefined || options.width !== undefined || options.height !== undefined) {
    warnLegacyOption('x/y/width/height', 'are accepted for API compatibility but snapshot cropping is not implemented in the current pipeline.');
  }

  normalized.encryption = normalizeEncryptionOptions(options.encryption);

  const fontConfigs = normalized.fontConfig ?? [];
  const langFontConfigs = normalized.langFontConfig ?? [];
  normalized.langFontConfig = langFontConfigs.length > 0 ? dedupeFontConfigs(langFontConfigs) : undefined;
  normalized.fontConfig = dedupeFontConfigs([...fontConfigs, ...langFontConfigs]);
  return normalized;
}

export interface ExportOptions {
  /** Allow cross-origin resources (requires server CORS). */
  useCORS?: boolean;
  /** Legacy html2canvas option, accepted for compatibility. */
  allowTaint?: boolean;
  /** Page background color; null = transparent. */
  backgroundColor?: string | null;
  /** Legacy html2canvas option, accepted for compatibility. */
  cache?: unknown;
  /** Legacy html2canvas option, accepted for compatibility. */
  canvas?: HTMLCanvasElement;
  /** Non-Latin font registration (TTF, base64). */
  fontConfig?: FontConfig | FontConfig[];
  /**
   * Legacy dompdf.js option. Fonts are matched by charRange + default fallback,
   * then merged into the current registration pipeline.
   */
  langFontConfig?: FontConfig[];
  /** Legacy clone option, supported by skipping matching elements. */
  ignoreElements?: (element: Element) => boolean;
  /** Legacy resource option, accepted for compatibility. */
  imageTimeout?: number;
  /** PDF encryption config. */
  encryption?: PdfEncryptionOptions;
  /** Legacy logging flag, accepted for compatibility. */
  logging?: boolean;
  /** Coordinate precision (decimal places). Default 2. */
  precision?: number;
  /** Legacy jsPDF option, accepted for compatibility. */
  floatPrecision?: number | 'smart';
  /** Compress PDF streams with DEFLATE (FlateDecode). Default false. */
  compress?: boolean;
  /** Only embed actually-used fonts. Default false. */
  putOnlyUsedFonts?: boolean;
  /** Enable pagination. Default false (single page). */
  pagination?: boolean;
  /** Legacy removeContainer option, accepted for compatibility. */
  removeContainer?: boolean;
  /** Legacy clone hook, accepted for compatibility. */
  onclone?: (document: Document, element: HTMLElement) => void;
  /** Page size name or [widthPt, heightPt]. Default 'a4'. */
  format?: string | [number, number];
  /** Legacy rendering mode switch, accepted for compatibility. */
  foreignObjectRendering?: boolean;
  /** Header/footer config (object = all pages, function = per-page). */
  pageConfig?: PageConfig;
  /** Repeated page watermark (object = all pages, function = per-page). */
  watermark?: WatermarkConfig;
  /** jsPDF instance init hook (accepted, no-op — no jsPDF in this engine). */
  onJspdfReady?: (jspdf: unknown) => void;
  /** jsPDF instance finish hook (accepted, no-op). */
  onJspdfFinish?: (jspdf: unknown) => void;
  /** Legacy resource option, accepted for compatibility. */
  proxy?: string;
  /** Legacy render option, accepted for compatibility. */
  scale?: number;
  /** Legacy window options, accepted for compatibility. */
  scrollX?: number;
  /** Legacy window options, accepted for compatibility. */
  scrollY?: number;
  /** Legacy render option, accepted for compatibility. */
  orientation?: 'p' | 'portrait' | 'l' | 'landscape';
  /** Legacy render option, accepted for compatibility. */
  pdfFileName?: string;
  /** Legacy crop option, accepted for compatibility. */
  x?: number;
  /** Legacy crop option, accepted for compatibility. */
  y?: number;
  /** Legacy crop option, accepted for compatibility. */
  width?: number;
  /** Legacy crop option, accepted for compatibility. */
  height?: number;
  /** Legacy window options, accepted for compatibility. */
  windowWidth?: number;
  /** Legacy window options, accepted for compatibility. */
  windowHeight?: number;

  // ---- advanced pt-level overrides (take precedence over format/margins) ----
  pageWidthPt?: number;
  pageHeightPt?: number;
  /** Margins in pt: number (all sides) or [top, right, bottom, left]. Default 0. */
  marginPt?: number | [number, number, number, number];
  jpegQuality?: number;
}

interface NormalizedExportOptions extends ExportOptions {
  fontConfig?: FontConfig[];
  langFontConfig?: FontConfig[];
  encryption?: PdfEncryptionOptions;
}

interface FontOverride {
  family: string;
  italic: number;
  weight: number;
}

const VALID_ENCRYPTION_PERMISSIONS: ReadonlySet<EncryptionPermission> = new Set([
  'annot-forms',
  'copy',
  'modify',
  'print',
]);

export function normalizeEncryptionOptions(
  encryption?: PdfEncryptionOptions,
): PdfEncryptionOptions | undefined {
  if (!encryption) return undefined;
  const normalized: PdfEncryptionOptions = {
    ownerPassword: typeof encryption.ownerPassword === 'string' ? encryption.ownerPassword : '',
    userPassword: typeof encryption.userPassword === 'string' ? encryption.userPassword : '',
    userPermissions: [],
  };
  const seen = new Set<EncryptionPermission>();
  for (const permission of encryption.userPermissions ?? []) {
    if (!VALID_ENCRYPTION_PERMISSIONS.has(permission)) {
      throw new Error(`dom2pdf: invalid encryption permission "${permission}"`);
    }
    if (seen.has(permission)) continue;
    seen.add(permission);
    normalized.userPermissions!.push(permission);
  }
  return normalized;
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
  /** 0 = JPEG, 1 = raw RGB888, 2 = raw RGBA8888 (alpha via SMask). */
  format: number;
}

/** Image byte payload + the format tag the Rust embedder branches on. */
const IMG_JPEG = 0;
const IMG_RAW_RGB = 1;
const IMG_RAW_RGBA = 2;

/**
 * Read a fully-opaque canvas back as packed RGB888 (alpha dropped). Used for
 * flat fills and line-art icons, where JPEG's chroma loss shows up as visible
 * color drift / fuzz. Callers must have painted an opaque background first.
 */
function canvasToRawRgb(
  canvas: HTMLCanvasElement,
): { bytes: Uint8Array; width: number; height: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { bytes: rgb, width: w, height: h };
}

function canvasToRawRgba(
  canvas: HTMLCanvasElement,
): { bytes: Uint8Array; width: number; height: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const bytes = new Uint8Array(rgba.length);
  bytes.set(rgba);
  return { bytes, width: w, height: h };
}

function rgbaHasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
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

interface GraphemeSegment {
  text: string;
  start16: number;
  end16: number;
}

interface InlineRun {
  kind: 'text' | 'bitmap';
  text: string;
  start16: number;
  end16: number;
  fontOverride?: FontOverride;
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
    // per-side rgba: top, right, bottom, left
    c: [
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
    ];
    s: [number, number, number, number];
  };
  shadow?: {
    x: number;
    y: number;
    blur: number;
    spread: number;
    color: [number, number, number, number];
  }[];
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
    preserveWhitespace: number;
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
const F_SHADOW = 0x400;

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

function clipsOverflow(cs: CSSStyleDeclaration): boolean {
  const values = [cs.overflow, cs.overflowX, cs.overflowY]
    .flatMap((value) => (value || '').split(/\s+/))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.some((value) => value === 'hidden' || value === 'clip' || value === 'scroll' || value === 'auto');
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

function segmentGraphemes(text: string): GraphemeSegment[] {
  if (!text) return [];
  const SegmenterCtor = (Intl as typeof Intl & {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
    ) => {
      segment(input: string): Iterable<{ segment: string; index: number }>;
    };
  }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    const out: GraphemeSegment[] = [];
    for (const part of segmenter.segment(text)) {
      out.push({
        text: part.segment,
        start16: part.index,
        end16: part.index + part.segment.length,
      });
    }
    return out;
  }
  const out: GraphemeSegment[] = [];
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    if (cp == null) break;
    const len = cp > 0xFFFF ? 2 : 1;
    out.push({ text: text.slice(i, i + len), start16: i, end16: i + len });
    i += len;
  }
  return out;
}

function isBitmapFallbackCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2190 && cp <= 0x21FF) // arrows
    || (cp >= 0x2300 && cp <= 0x23FF) // misc technical / emoji symbols
    || (cp >= 0x2460 && cp <= 0x24FF) // enclosed numbers/symbols
    || (cp >= 0x2500 && cp <= 0x259F) // box drawing + block elements
    || (cp >= 0x25A0 && cp <= 0x25FF) // geometric shapes
    || (cp >= 0x2600 && cp <= 0x27FF) // misc symbols, dingbats, arrows
    || (cp >= 0x2900 && cp <= 0x2BFF) // supplemental arrows / misc symbols
    || (cp >= 0xFE00 && cp <= 0xFE0F) // variation selectors
    || cp === 0x200D // ZWJ emoji sequences
    || (cp >= 0x1F000 && cp <= 0x1FAFF) // emoji blocks
  );
}

function graphemeNeedsBitmapFallback(grapheme: string): boolean {
  for (const ch of grapheme) {
    const cp = ch.codePointAt(0);
    if (cp != null && isBitmapFallbackCodePoint(cp)) return true;
  }
  return false;
}

async function convertImage(
  img: HTMLImageElement,
  quality: number,
  useCORS: boolean,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: number } | null> {
  try {
    const src = img.currentSrc || img.src;
    let sourceImg = img;
    if (src) {
      try {
        const protocol = new URL(src, document.baseURI).protocol;
        if (useCORS && /^https?:$/i.test(protocol)) {
          sourceImg = await loadImageFromUrl(src, 'anonymous');
        }
      } catch {
        // Ignore URL parse failures and fall back to the live element.
      }
    }
    if (!sourceImg.complete || sourceImg.naturalWidth === 0) {
      await sourceImg.decode().catch(() => null);
    }
    const rect = img.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || img.width || sourceImg.naturalWidth || img.naturalWidth || 0));
    const cssH = Math.max(1, Math.round(rect.height || img.height || sourceImg.naturalHeight || img.naturalHeight || 0));
    const ss = superSampleFactor(cssW, cssH);
    const w = Math.max(1, Math.round(cssW * ss));
    const h = Math.max(1, Math.round(cssH * ss));
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(sourceImg, 0, 0, w, h);
    let rgba: Uint8ClampedArray;
    try {
      rgba = ctx.getImageData(0, 0, w, h).data;
    } catch {
      const raster = await rasterizeElement(img, img.getBoundingClientRect(), quality, getComputedStyle(img));
      if (!raster) return null;
      return { bytes: raster.bytes, width: raster.width, height: raster.height, format: raster.format };
    }
    if (rgbaHasTransparency(rgba)) {
      const bytes = new Uint8Array(rgba.length);
      bytes.set(rgba);
      return { bytes, width: w, height: h, format: IMG_RAW_RGBA };
    }
    const blob = await new Promise<Blob | null>((res) =>
      canvas.toBlob(res, 'image/jpeg', quality),
    );
    if (!blob) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, width: w, height: h, format: IMG_JPEG };
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

interface EdgePadding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface BoxShadowSpec {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: [number, number, number, number];
}

function pxNumber(value: string | null | undefined): number {
  const n = parseFloat(value || '');
  return Number.isFinite(n) ? n : 0;
}

function cssQuotedContentToText(content: string): string | null {
  const trimmed = (content || '').trim();
  if (!trimmed || trimmed === 'none' || trimmed === 'normal') return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    const quote = trimmed[0];
    let body = trimmed.slice(1, -1);
    body = body.replace(/\\A\s*/g, '\n');
    body = body.replace(/\\(['"\\])/g, '$1');
    if (quote === '\'') body = body.replace(/\\"/g, '"');
    if (!body) return null;
    return body;
  }
  return trimmed;
}

function hasVisibleBorder(cs: CSSStyleDeclaration): boolean {
  return (
    (pxNumber(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && cs.borderTopStyle !== 'hidden')
    || (pxNumber(cs.borderRightWidth) > 0 && cs.borderRightStyle !== 'none' && cs.borderRightStyle !== 'hidden')
    || (pxNumber(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none' && cs.borderBottomStyle !== 'hidden')
    || (pxNumber(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== 'none' && cs.borderLeftStyle !== 'hidden')
  ) && parseColor(cs.borderTopColor)[3] > 0.001;
}

function pseudoHasVisual(cs: CSSStyleDeclaration): boolean {
  const pseudoText = cssQuotedContentToText(cs.content);
  // Ignore clearfix-style pseudo elements like `content: " "` that only exist
  // for layout; treating them as visual forces large containers into full-raster.
  const hasContent = !!pseudoText && pseudoText.trim().length > 0;
  const bg = parseColor(cs.backgroundColor);
  const hasBg = bg[3] > 0.001;
  const hasBox = pxNumber(cs.width) > 0 && pxNumber(cs.height) > 0;
  return hasContent || hasBg || hasBox || hasVisibleBorder(cs);
}

function hasComplexBackground(cs: CSSStyleDeclaration): boolean {
  const bgImage = (cs.backgroundImage || '').trim();
  if (!bgImage || bgImage === 'none') return false;
  if (bgImage.includes('url(')) return true;
  const size = (cs.backgroundSize || '').trim();
  const position = (cs.backgroundPosition || '').trim();
  const repeat = (cs.backgroundRepeat || '').trim();
  return !(
    (size === '' || size === 'auto' || size === 'auto auto')
    && (position === '' || position === '0% 0%')
    && (repeat === '' || repeat === 'repeat' || repeat === 'repeat repeat')
  );
}

function computeBoxShadowPadding(boxShadow: string): EdgePadding {
  const pad: EdgePadding = { top: 0, right: 0, bottom: 0, left: 0 };
  const layers = splitTopLevelComma(boxShadow || '');
  for (const layer of layers) {
    const trimmed = layer.trim();
    if (!trimmed || trimmed === 'none' || /\binset\b/i.test(trimmed)) continue;
    const lengths = Array.from(trimmed.matchAll(/-?\d+(?:\.\d+)?px/g)).map((m) => parseFloat(m[0]));
    if (lengths.length < 2) continue;
    const offsetX = lengths[0] || 0;
    const offsetY = lengths[1] || 0;
    const blur = Math.max(0, lengths[2] || 0);
    const spread = lengths[3] || 0;
    const extent = Math.max(0, blur * 2 + spread);
    pad.left = Math.max(pad.left, extent - offsetX);
    pad.right = Math.max(pad.right, extent + offsetX);
    pad.top = Math.max(pad.top, extent - offsetY);
    pad.bottom = Math.max(pad.bottom, extent + offsetY);
  }
  pad.top = Math.max(0, Math.ceil(pad.top));
  pad.right = Math.max(0, Math.ceil(pad.right));
  pad.bottom = Math.max(0, Math.ceil(pad.bottom));
  pad.left = Math.max(0, Math.ceil(pad.left));
  return pad;
}

function parseBoxShadow(boxShadow: string): BoxShadowSpec[] {
  const out: BoxShadowSpec[] = [];
  const layers = splitTopLevelComma(boxShadow || '');
  for (const layer of layers) {
    const trimmed = layer.trim();
    if (!trimmed || trimmed === 'none' || /\binset\b/i.test(trimmed)) continue;
    const lengths = Array.from(trimmed.matchAll(/-?\d+(?:\.\d+)?px/g)).map((m) => parseFloat(m[0]));
    if (lengths.length < 2) continue;
    const x = lengths[0] || 0;
    const y = lengths[1] || 0;
    const blur = Math.max(0, lengths[2] || 0);
    const spread = lengths[3] || 0;
    const colorMatch = trimmed.match(/(rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]+|transparent)/);
    const color = parseColor(colorMatch ? colorMatch[1] : 'rgba(0,0,0,0.25)');
    if (color[3] <= 0.001) continue;
    out.push({ x, y, blur, spread, color });
  }
  return out;
}

function findOpaqueBackdropColor(el: HTMLElement): string {
  let rAcc = 0, gAcc = 0, bAcc = 0;
  let alphaRem = 1.0;
  for (let cur: HTMLElement | null = el.parentElement; cur; cur = cur.parentElement) {
    const bg = getComputedStyle(cur).backgroundColor;
    const parsed = parseColor(bg);
    const a = parsed[3];
    if (a > 0.001) {
      rAcc += parsed[0] * 255 * a * alphaRem;
      gAcc += parsed[1] * 255 * a * alphaRem;
      bAcc += parsed[2] * 255 * a * alphaRem;
      alphaRem *= (1 - a);
      if (1 - alphaRem >= 0.99) break;
    }
  }
  if (alphaRem > 0.001) {
    rAcc += 255 * alphaRem;
    gAcc += 255 * alphaRem;
    bAcc += 255 * alphaRem;
  }
  return `rgb(${Math.round(rAcc)}, ${Math.round(gAcc)}, ${Math.round(bAcc)})`;
}

function copyComputedStyles(
  target: HTMLElement,
  computed: CSSStyleDeclaration,
  exclude: Set<string> = new Set(),
) {
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    if (exclude.has(prop) || prop === 'content') continue;
    const value = computed.getPropertyValue(prop);
    const priority = computed.getPropertyPriority(prop);
    if (value) target.style.setProperty(prop, value, priority);
  }
}

function buildPseudoClone(
  owner: HTMLElement,
  pseudo: '::before' | '::after',
): HTMLElement | null {
  const computed = getComputedStyle(owner, pseudo);
  if (!pseudoHasVisual(computed)) return null;
  const pseudoEl = document.createElement('span');
  pseudoEl.setAttribute('data-dom2pdf-pseudo', pseudo);
  copyComputedStyles(pseudoEl, computed);
  if (computed.position === 'sticky') {
    // Pseudo clones are inserted as real inline children. Keeping sticky here makes
    // foreignObject rasterization drift or drop line-number style markers entirely.
    pseudoEl.style.position = 'static';
    pseudoEl.style.top = 'auto';
    pseudoEl.style.right = 'auto';
    pseudoEl.style.bottom = 'auto';
    pseudoEl.style.left = 'auto';
  }
  const text = cssQuotedContentToText(computed.content);
  if (text) pseudoEl.textContent = text;
  return pseudoEl;
}

function cloneElementForRaster(src: HTMLElement): HTMLElement {
  if (src instanceof HTMLCanvasElement) {
    const img = document.createElement('img');
    img.src = src.toDataURL('image/png');
    img.width = src.width;
    img.height = src.height;
    const computed = getComputedStyle(src);
    copyComputedStyles(img, computed);
    return img;
  }
  if (src instanceof HTMLImageElement) {
    const img = document.createElement('img');
    // Use the resolved currentSrc so file:// and srcset-backed images keep working
    // after being serialized into a data: SVG foreignObject wrapper.
    img.src = src.currentSrc || src.src;
    img.width = src.width;
    img.height = src.height;
    const computed = getComputedStyle(src);
    copyComputedStyles(img, computed);
    return img;
  }

  // Inline <svg> elements live in the SVG namespace. When serialized into an
  // HTML <div> inside an SVG <foreignObject>, the namespace context can be lost
  // and the SVG may not render at all (100% blank icon). Convert inline SVG to
  // an <img> with a data: URL so it renders reliably as a raster image.
  if (src instanceof SVGSVGElement) {
    const img = document.createElement('img');
    const svgString = new XMLSerializer().serializeToString(src);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgString)}`;
    const rect = src.getBoundingClientRect();
    img.width = Math.max(1, Math.round(rect.width));
    img.height = Math.max(1, Math.round(rect.height));
    const computed = getComputedStyle(src);
    copyComputedStyles(img, computed);
    return img;
  }

  const clone = src.cloneNode(false) as HTMLElement;
  const computed = getComputedStyle(src);
  copyComputedStyles(clone, computed);

  const before = buildPseudoClone(src, '::before');
  if (before) clone.appendChild(before);

  for (let child = src.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      clone.appendChild(cloneElementForRaster(child as HTMLElement));
    } else if (child.nodeType === Node.TEXT_NODE) {
      clone.appendChild(document.createTextNode((child as Text).data));
    }
  }

  const after = buildPseudoClone(src, '::after');
  if (after) clone.appendChild(after);
  return clone;
}

// Clone only an element's own background layer: its computed styles + ::before
// decoration, with NO real children/text and NO box-shadow. Used to bake a
// backdrop image that sits under the element's still-vector text. box-shadow is
// dropped because the box node paints it vectorially (avoids double shadow);
// ::after is intentionally excluded (it paints above content — handled by the
// classifier falling back to full-raster when ::after has visuals).
function cloneElementBackgroundOnly(src: HTMLElement): HTMLElement {
  const clone = src.cloneNode(false) as HTMLElement;
  copyComputedStyles(clone, getComputedStyle(src));
  clone.style.boxShadow = 'none';
  const before = buildPseudoClone(src, '::before');
  if (before) clone.appendChild(before);
  return clone;
}

function loadImageFromUrl(url: string, crossOrigin?: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('failed to load rasterized element image'));
    img.src = url;
  });
}

// raw RGB is uncompressed (3 bytes/px); cap total pixels so a supersampled large
// element can't blow up memory / PDF size. ~4M px ≈ 12 MB raw.
const MAX_RASTER_PIXELS = 4_000_000;

// Supersample factor for rasterized elements: render the foreignObject into a
// canvas larger than its CSS box so baked pixels (incl. text that cannot be
// vectorized) stay crisp. At least 2x; capped at 3x and pulled back to fit the
// pixel budget.
function superSampleFactor(cssW: number, cssH: number): number {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 2;
  let ss = Math.min(3, Math.max(2, dpr));
  while (ss > 1 && cssW * cssH * ss * ss > MAX_RASTER_PIXELS) ss -= 0.5;
  return Math.max(1, ss);
}

// Serialize a wrapper (containing the element clone) through an SVG foreignObject
// into a supersampled canvas, returned as lossless raw RGB.
async function rasterizeWrapper(
  wrapper: HTMLElement,
  captureWidth: number,
  captureHeight: number,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: number } | null> {
  const serialized = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${captureWidth}" height="${captureHeight}" viewBox="0 0 ${captureWidth} ${captureHeight}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml">${serialized}</div></foreignObject></svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const img = await loadImageFromUrl(url);
  const ss = superSampleFactor(captureWidth, captureHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(captureWidth * ss));
  canvas.height = Math.max(1, Math.round(captureHeight * ss));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const raw = canvasToRawRgb(canvas);
  if (!raw) return null;
  return { bytes: raw.bytes, width: raw.width, height: raw.height, format: IMG_RAW_RGB };
}

// Wrapper of fixed CSS size holding the positioned element clone. Opaque backdrop
// (nearest opaque ancestor bg) fills transparent areas so raw RGB (no alpha)
// composites correctly instead of going black.
function buildRasterWrapper(
  el: HTMLElement,
  rawRect: DOMRect,
  shadowPad: EdgePadding,
  captureWidth: number,
  captureHeight: number,
  backgroundOnly: boolean,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.width = `${captureWidth}px`;
  wrapper.style.height = `${captureHeight}px`;
  wrapper.style.overflow = 'hidden';
  wrapper.style.background = findOpaqueBackdropColor(el);

  const clone = backgroundOnly ? cloneElementBackgroundOnly(el) : cloneElementForRaster(el);
  clone.style.position = 'absolute';
  clone.style.left = `${shadowPad.left}px`;
  clone.style.top = `${shadowPad.top}px`;
  clone.style.width = `${Math.max(1, Math.ceil(rawRect.width))}px`;
  clone.style.height = `${Math.max(1, Math.ceil(rawRect.height))}px`;
  clone.style.margin = '0';
  clone.style.transform = 'none';
  clone.style.transformOrigin = 'top left';
  wrapper.appendChild(clone);
  return wrapper;
}

async function rasterizeElement(
  el: HTMLElement,
  rawRect: DOMRect,
  _quality: number,
  cs: CSSStyleDeclaration,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: number; cssWidth: number; cssHeight: number; rawLeft: number; rawTop: number } | null> {
  try {
    const shadowPad = computeBoxShadowPadding(cs.boxShadow);
    const captureWidth = Math.max(1, Math.ceil(rawRect.width + shadowPad.left + shadowPad.right));
    const captureHeight = Math.max(1, Math.ceil(rawRect.height + shadowPad.top + shadowPad.bottom));
    const wrapper = buildRasterWrapper(el, rawRect, shadowPad, captureWidth, captureHeight, false);
    const out = await rasterizeWrapper(wrapper, captureWidth, captureHeight);
    if (!out) return null;
    return {
      ...out,
      // Layout (CSS px) size is independent of the supersampled pixel count — the
      // engine draws the image into the layout box; pixels only set resolution.
      cssWidth: captureWidth,
      cssHeight: captureHeight,
      rawLeft: rawRect.left - shadowPad.left,
      rawTop: rawRect.top - shadowPad.top,
    };
  } catch {
    return null;
  }
}

// Background-only raster: bakes just the element's own background + ::before
// decoration (no real text/children, no box-shadow) so text stays vector. The
// backdrop node uses objectFit:0, so pixel count is decoupled from layout size —
// no cssWidth round-trip needed.
async function rasterizeElementBackgroundOnly(
  el: HTMLElement,
  rawRect: DOMRect,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: number } | null> {
  try {
    // No shadow padding: box-shadow is painted vectorially by the box node.
    const captureWidth = Math.max(1, Math.ceil(rawRect.width));
    const captureHeight = Math.max(1, Math.ceil(rawRect.height));
    const noPad: EdgePadding = { top: 0, right: 0, bottom: 0, left: 0 };
    const wrapper = buildRasterWrapper(el, rawRect, noPad, captureWidth, captureHeight, true);
    return await rasterizeWrapper(wrapper, captureWidth, captureHeight);
  } catch {
    return null;
  }
}

// Inline <svg> elements live in the SVG namespace, so their `tagName` keeps its
// original case ("svg") instead of being upper-cased like HTML tags. Compare
// case-insensitively or these icons silently skip rasterization and vanish.
function isRasterTag(el: HTMLElement): boolean {
  const tag = el.tagName.toUpperCase();
  return tag === 'SVG' || tag === 'CANVAS';
}

// Render strategy for an element:
//   'full-raster'       — bake the whole subtree (incl. text) to one image. Used
//                         for SVG/canvas and non-translate transforms (rotate /
//                         scale / skew), where text cannot be reproduced as
//                         horizontal vector runs.
//   'background-raster' — bake only the element's background + ::before decoration
//                         to a backdrop image; real text stays vector (selectable).
//   'vector'            — ordinary element (incl. pure-translate transforms, whose
//                         getBoundingClientRect already carries the offset).
type RenderStrategy = 'full-raster' | 'background-raster' | 'vector';

// True when `transform` is a pure translation (no rotate/scale/skew). Such an
// element needs no rasterization at all: getBoundingClientRect (and every
// descendant's) already reflects the translated position, so vector text lands
// correctly. getComputedStyle normalizes transform to matrix()/matrix3d(), so
// those are the primary paths; the function-form check is a defensive fallback.
function transformIsPureTranslate(cs: CSSStyleDeclaration): boolean {
  const t = (cs.transform || '').trim();
  if (t === '' || t === 'none') return true;
  const EPS = 1e-3;
  const near = (a: number, b: number) => Math.abs(a - b) < EPS;
  const m2 = /^matrix\(([^)]+)\)$/.exec(t);
  if (m2) {
    const n = m2[1].split(',').map((s) => parseFloat(s));
    return n.length === 6 && near(n[0], 1) && near(n[1], 0) && near(n[2], 0) && near(n[3], 1);
  }
  const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m3) {
    const n = m3[1].split(',').map((s) => parseFloat(s));
    // Linear part (excluding the tx,ty,tz column n[12..14]) must be identity.
    return n.length === 16
      && near(n[0], 1) && near(n[1], 0) && near(n[2], 0) && near(n[3], 0)
      && near(n[4], 0) && near(n[5], 1) && near(n[6], 0) && near(n[7], 0)
      && near(n[8], 0) && near(n[9], 0) && near(n[10], 1) && near(n[11], 0)
      && near(n[15], 1);
  }
  return /^(translate|translateX|translateY|translateZ|translate3d)\(/.test(t)
    && !/(rotate|scale|skew|matrix|perspective)/.test(t);
}

function classifyRenderStrategy(el: HTMLElement, cs: CSSStyleDeclaration): RenderStrategy {
  const mode = el.dataset.dom2pdfMode;
  if (mode === 'vector' || mode === 'skip') return 'vector';
  if (isRasterTag(el)) return 'full-raster';
  const clipsText = cs.backgroundImage !== 'none'
    && ((cs.backgroundClip || '').trim() === 'text'
      || (cs.webkitBackgroundClip || '').trim() === 'text');
  const transparentTextFill = (cs.webkitTextFillColor || '').trim() === 'rgba(0, 0, 0, 0)'
    || (cs.getPropertyValue('-webkit-text-fill-color') || '').trim() === 'rgba(0, 0, 0, 0)';
  if (clipsText || transparentTextFill) return 'full-raster';
  // Non-translate transforms skew/scale/rotate the text — must check before the
  // background branch so e.g. "rotate + gradient" doesn't try to keep text vector.
  if (!transformIsPureTranslate(cs)) return 'full-raster';
  // ::after paints ABOVE content; a backdrop image is drawn BELOW the text, so an
  // ::after overlay would end up hidden behind the text. Fall back to full-raster
  // for those rather than mislayer them.
  if (pseudoHasVisual(getComputedStyle(el, '::after'))) return 'full-raster';
  const beforeVisual = pseudoHasVisual(getComputedStyle(el, '::before'));
  if (beforeVisual || hasComplexBackground(cs)) return 'background-raster';
  return 'vector';
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
  _quality: number,
  fallbackBg: [number, number, number, number] | null,
): { bytes: Uint8Array; width: number; height: number; format: number } | null {
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

  const raw = canvasToRawRgb(canvas);
  if (!raw) return null;
  return { bytes: raw.bytes, width: raw.width, height: raw.height, format: IMG_RAW_RGB };
}

interface RawGradientStop {
  color: [number, number, number, number];
  pos: number | null;
  unit: '%' | 'px' | null;
}

interface ResolvedGradientStop {
  color: [number, number, number, number];
  pos: number;
}

interface LinearGradientSpec {
  kind: 'linear';
  repeating: boolean;
  angleDeg: number;
  stops: RawGradientStop[];
}

interface RadialGradientSpec {
  kind: 'radial';
  repeating: boolean;
  centerX: number;
  centerY: number;
  radius: number;
  stops: RawGradientStop[];
}

type RasterGradientSpec = LinearGradientSpec | RadialGradientSpec;

interface PreparedLinearGradientLayer {
  kind: 'linear';
  repeating: boolean;
  stops: ResolvedGradientStop[];
  dx: number;
  dy: number;
  lineLen: number;
  cx: number;
  cy: number;
}

interface PreparedRadialGradientLayer {
  kind: 'radial';
  repeating: boolean;
  stops: ResolvedGradientStop[];
  centerX: number;
  centerY: number;
}

type PreparedGradientLayer = PreparedLinearGradientLayer | PreparedRadialGradientLayer;

function parseGradientStop(part: string): RawGradientStop | null {
  const m = /^(.*?)(?:\s+([+-]?\d+(?:\.\d+)?)(px|%)?)?$/.exec(part.trim());
  if (!m) return null;
  const colorText = m[1].trim();
  if (!colorText) return null;
  return {
    color: parseColor(colorText),
    pos: m[2] == null ? null : parseFloat(m[2]),
    unit: m[2] == null ? null : ((m[3] === '%') ? '%' : 'px'),
  };
}

function resolveGradientStops(rawStops: RawGradientStop[], total: number): ResolvedGradientStop[] {
  const out = rawStops.map((stop) => ({
    color: stop.color,
    pos: stop.pos == null ? null : (stop.unit === '%' ? (stop.pos / 100) * total : stop.pos),
  }));
  if (out.length < 2) return [];
  if (out[0].pos == null) out[0].pos = 0;
  if (out[out.length - 1].pos == null) out[out.length - 1].pos = total;
  for (let i = 0; i < out.length; i++) {
    if (out[i].pos != null) continue;
    let j = i + 1;
    while (j < out.length && out[j].pos == null) j++;
    const left = out[i - 1].pos ?? 0;
    const right = j < out.length ? (out[j].pos ?? total) : total;
    const span = j - i + 1;
    for (let k = i; k < j; k++) {
      out[k].pos = left + ((right - left) * (k - i + 1)) / span;
    }
    i = j - 1;
  }
  return out.map((stop) => ({ color: stop.color, pos: stop.pos ?? 0 }));
}

function parseAnchorToken(token: string, total: number, isX: boolean): number {
  const v = token.trim().toLowerCase();
  if (!v || v === 'center') return total / 2;
  if ((isX && v === 'left') || (!isX && v === 'top')) return 0;
  if ((isX && v === 'right') || (!isX && v === 'bottom')) return total;
  const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(v);
  if (m) return (parseFloat(m[1]) / 100) * total;
  return total / 2;
}

function radiusFromMode(mode: string, cx: number, cy: number, w: number, h: number): number {
  const corners = [
    Math.hypot(cx, cy),
    Math.hypot(w - cx, cy),
    Math.hypot(cx, h - cy),
    Math.hypot(w - cx, h - cy),
  ];
  switch (mode) {
    case 'closest-side':
      return Math.max(1, Math.min(cx, w - cx, cy, h - cy));
    case 'farthest-side':
      return Math.max(1, Math.max(cx, w - cx, cy, h - cy));
    case 'closest-corner':
      return Math.max(1, Math.min(...corners));
    default:
      return Math.max(1, Math.max(...corners));
  }
}

function parseLinearOrRepeatingLinearGradient(
  input: string,
): LinearGradientSpec | null {
  const src = input.trim();
  const repeating = src.startsWith('repeating-linear-gradient(');
  const prefix = repeating ? 'repeating-linear-gradient(' : 'linear-gradient(';
  if (!src.startsWith(prefix) || !src.endsWith(')')) return null;
  const inner = src.slice(prefix.length, -1).trim();
  const parts = splitTopLevelComma(inner);
  if (parts.length < 2) return null;
  let angleDeg = 180;
  let stopStart = 0;
  const maybeAngle = gradientAngleDeg(parts[0]);
  if (maybeAngle !== null) {
    angleDeg = maybeAngle;
    stopStart = 1;
  }
  const stops = parts.slice(stopStart).map(parseGradientStop).filter((v): v is RawGradientStop => !!v);
  if (stops.length < 2) return null;
  return { kind: 'linear', repeating, angleDeg, stops };
}

function parseRadialGradient(
  input: string,
  width: number,
  height: number,
): RadialGradientSpec | null {
  const src = input.trim();
  const repeating = src.startsWith('repeating-radial-gradient(');
  const prefix = repeating ? 'repeating-radial-gradient(' : 'radial-gradient(';
  if (!src.startsWith(prefix) || !src.endsWith(')')) return null;
  const inner = src.slice(prefix.length, -1).trim();
  const parts = splitTopLevelComma(inner);
  if (parts.length < 2) return null;

  let descriptor = '';
  let stopStart = 0;
  if (parts[0].includes('circle') || parts[0].includes('ellipse') || parts[0].includes('closest') || parts[0].includes('farthest') || parts[0].includes(' at ')) {
    descriptor = parts[0].trim().toLowerCase();
    stopStart = 1;
  }
  const stops = parts.slice(stopStart).map(parseGradientStop).filter((v): v is RawGradientStop => !!v);
  if (stops.length < 2) return null;

  let centerX = width / 2;
  let centerY = height / 2;
  let sizeMode = 'farthest-corner';
  if (descriptor) {
    if (descriptor.includes('closest-side')) sizeMode = 'closest-side';
    else if (descriptor.includes('closest-corner')) sizeMode = 'closest-corner';
    else if (descriptor.includes('farthest-side')) sizeMode = 'farthest-side';
    if (descriptor.includes(' at ')) {
      const at = descriptor.split(' at ')[1].trim();
      const tokens = at.split(/\s+/).filter(Boolean);
      const xTok = tokens[0] ?? 'center';
      const yTok = tokens[1] ?? (tokens[0] === 'top' || tokens[0] === 'bottom' ? tokens[0] : 'center');
      centerX = parseAnchorToken(xTok, width, true);
      centerY = parseAnchorToken(yTok, height, false);
    }
  }

  return {
    kind: 'radial',
    repeating,
    centerX,
    centerY,
    radius: radiusFromMode(sizeMode, centerX, centerY, width, height),
    stops,
  };
}

function blendOver(
  bottom: [number, number, number, number],
  top: [number, number, number, number],
): [number, number, number, number] {
  const a = top[3] + bottom[3] * (1 - top[3]);
  if (a <= 0.0001) return [0, 0, 0, 0];
  const r = (top[0] * top[3] + bottom[0] * bottom[3] * (1 - top[3])) / a;
  const g = (top[1] * top[3] + bottom[1] * bottom[3] * (1 - top[3])) / a;
  const b = (top[2] * top[3] + bottom[2] * bottom[3] * (1 - top[3])) / a;
  return [r, g, b, a];
}

function mixColor(
  a: [number, number, number, number],
  b: [number, number, number, number],
  t: number,
): [number, number, number, number] {
  const s = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * s,
    a[1] + (b[1] - a[1]) * s,
    a[2] + (b[2] - a[2]) * s,
    a[3] + (b[3] - a[3]) * s,
  ];
}

function sampleGradientStops(
  stops: ResolvedGradientStop[],
  t: number,
  repeating: boolean,
): [number, number, number, number] {
  if (stops.length === 0) return [1, 1, 1, 1];
  let pos = t;
  if (repeating) {
    const start = stops[0].pos;
    const end = stops[stops.length - 1].pos;
    const span = end - start;
    if (span > 0.0001) {
      pos = ((pos - start) % span + span) % span + start;
    }
  }
  if (pos <= stops[0].pos) return stops[0].color;
  if (pos >= stops[stops.length - 1].pos) return stops[stops.length - 1].color;
  for (let i = 1; i < stops.length; i++) {
    if (pos > stops[i].pos) continue;
    const left = stops[i - 1];
    const right = stops[i];
    const span = right.pos - left.pos;
    const ratio = span <= 0.0001 ? 0 : (pos - left.pos) / span;
    return mixColor(left.color, right.color, ratio);
  }
  return stops[stops.length - 1].color;
}

function parseGradientLayer(
  layerText: string,
  width: number,
  height: number,
): PreparedGradientLayer | null {
  const text = layerText.trim();
  if (!text || text === 'none') return null;

  const linearSpec = parseLinearOrRepeatingLinearGradient(text);
  if (linearSpec) {
    const rad = (linearSpec.angleDeg * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    const lineLen = Math.max(1, Math.abs(dx) * width + Math.abs(dy) * height);
    return {
      kind: 'linear',
      repeating: linearSpec.repeating,
      stops: resolveGradientStops(linearSpec.stops, lineLen),
      dx,
      dy,
      lineLen,
      cx: width / 2,
      cy: height / 2,
    };
  }

  const radialSpec = parseRadialGradient(text, width, height);
  if (radialSpec) {
    return {
      kind: 'radial',
      repeating: radialSpec.repeating,
      stops: resolveGradientStops(radialSpec.stops, radialSpec.radius),
      centerX: radialSpec.centerX,
      centerY: radialSpec.centerY,
    };
  }

  return null;
}

function sampleGradientLayer(
  layer: PreparedGradientLayer,
  x: number,
  y: number,
): [number, number, number, number] {
  if (layer.kind === 'linear') {
    return sampleGradientStops(
      layer.stops,
      (x + 0.5 - layer.cx) * layer.dx + (y + 0.5 - layer.cy) * layer.dy + layer.lineLen / 2,
      layer.repeating,
    );
  }

  return sampleGradientStops(
    layer.stops,
    Math.hypot(x + 0.5 - layer.centerX, y + 0.5 - layer.centerY),
    layer.repeating,
  );
}

function convertBackgroundImageToImage(
  backgroundImageText: string,
  width: number,
  height: number,
  _quality: number,
  fallbackBg: [number, number, number, number] | null,
): { bytes: Uint8Array; width: number; height: number; format: number } | null {
  const text = (backgroundImageText || '').trim();
  if (!text || text === 'none') return null;

  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const layers = splitTopLevelComma(text)
    .map((layer) => parseGradientLayer(layer, w, h))
    .filter((layer): layer is PreparedGradientLayer => !!layer);
  if (layers.length === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(w, h);
  const data = imageData.data;
  const base = blendOver([1, 1, 1, 1], fallbackBg ?? [1, 1, 1, 1]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      let out = base;
      for (let i = layers.length - 1; i >= 0; i--) {
        out = blendOver(out, sampleGradientLayer(layers[i], x, y));
      }
      data[idx] = Math.round(out[0] * 255);
      data[idx + 1] = Math.round(out[1] * 255);
      data[idx + 2] = Math.round(out[2] * 255);
      data[idx + 3] = 255;
    }
  }

  // Pack the RGBA buffer we just computed straight to lossless RGB888 — no
  // canvas/JPEG round-trip, so gradient colors stay exact.
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { bytes: rgb, width: w, height: h, format: IMG_RAW_RGB };
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

interface ResolvedWatermarkBase {
  kind: 0 | 1;
  angleDeg: number;
  spacing: [number, number];
  offset: [number, number];
  layer: number;
}

interface ResolvedTextWatermark extends ResolvedWatermarkBase {
  kind: 0;
  text: string;
  color: [number, number, number, number];
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  italic: number;
}

interface ResolvedImageWatermark extends ResolvedWatermarkBase {
  kind: 1;
  imageId: number;
  imageWidthPx: number;
  imageHeightPx: number;
  opacity: number;
}

type ResolvedWatermark = ResolvedTextWatermark | ResolvedImageWatermark;

interface WatermarkImageAsset {
  imageId: number;
  width: number;
  height: number;
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

function clampResolvedNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}

function isTextWatermark(watermark: WatermarkOptions): watermark is TextWatermarkOptions {
  return typeof (watermark as TextWatermarkOptions).text === 'string';
}

function isResolvedTextWatermark(watermark: ResolvedWatermark): watermark is ResolvedTextWatermark {
  return watermark.kind === 0;
}

async function collectWatermarkImageAsset(
  imageUrl: string,
  images: CollectedImage[],
  cache: Map<string, WatermarkImageAsset>,
): Promise<WatermarkImageAsset | null> {
  const url = imageUrl.trim();
  if (!url) return null;
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    let img: HTMLImageElement;
    try {
      img = await loadImageFromUrl(url, 'anonymous');
    } catch {
      img = await loadImageFromUrl(url);
    }
    if (!img.complete || img.naturalWidth === 0) {
      await img.decode().catch(() => null);
    }
    const width = Math.max(1, Math.round(img.naturalWidth || img.width || 0));
    const height = Math.max(1, Math.round(img.naturalHeight || img.height || 0));
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const rgba = canvasToRawRgba(canvas);
    if (!rgba) return null;
    const imageId = images.length + 1;
    images.push({
      id: imageId,
      bytes: rgba.bytes,
      width: rgba.width,
      height: rgba.height,
      format: IMG_RAW_RGBA,
    });
    const asset = { imageId, width, height };
    cache.set(url, asset);
    return asset;
  } catch {
    return null;
  }
}

async function resolveWatermark(
  watermark: WatermarkOptions | undefined,
  images: CollectedImage[] = [],
  imageCache: Map<string, WatermarkImageAsset> = new Map(),
): Promise<ResolvedWatermark | null> {
  if (!watermark) return null;
  const base = {
    angleDeg: clampResolvedNumber(watermark.angle, -180, 180, 35),
    spacing: watermark.spacing ?? [160, 120] as [number, number],
    offset: watermark.offset ?? [36, 36] as [number, number],
    layer: watermark.layer === 'over' ? 1 : 0,
  };
  if (isTextWatermark(watermark)) {
    const text = watermark.text;
    if (!text.trim()) return null;
    return {
      kind: 0,
      text,
      color: parseColor(watermark.color ?? 'rgba(0, 0, 0, 0.12)'),
      fontFamily: watermark.fontFamily?.trim() || 'Helvetica',
      fontSizePx: watermark.fontSize ?? 28,
      fontWeight: watermark.fontWeight ?? 400,
      italic: watermark.italic ? 1 : 0,
      ...base,
    };
  }
  const asset = await collectWatermarkImageAsset(watermark.imageUrl, images, imageCache);
  if (!asset) return null;
  const imageWidthPx = watermark.imageWidth
    ?? (watermark.imageHeight ? (asset.width * watermark.imageHeight) / asset.height : asset.width);
  const imageHeightPx = watermark.imageHeight
    ?? (watermark.imageWidth ? (asset.height * watermark.imageWidth) / asset.width : asset.height);
  return {
    kind: 1,
    imageId: asset.imageId,
    imageWidthPx: clampResolvedNumber(imageWidthPx, 1, 4096, asset.width),
    imageHeightPx: clampResolvedNumber(imageHeightPx, 1, 4096, asset.height),
    opacity: clampResolvedNumber(watermark.opacity, 0, 1, 0.12),
    ...base,
  };
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
  const normalizedOptions = normalizeLegacyOptions(options);
  // jsPDF hooks: accepted but no-op (engine has no jsPDF instance).
  if (normalizedOptions.onJspdfReady) {
    console.warn('dom2pdf: onJspdfReady is accepted but not implemented (no jsPDF engine).');
  }
  if (normalizedOptions.onJspdfFinish) {
    console.warn('dom2pdf: onJspdfFinish is accepted but not implemented (no jsPDF engine).');
  }
  const [fmtW, fmtH] = resolvePageSize(normalizedOptions.format);
  const pageWidthPt = normalizedOptions.pageWidthPt ?? fmtW;
  const pageHeightPt = normalizedOptions.pageHeightPt ?? fmtH;
  const m = normalizedOptions.marginPt ?? 0;
  const [mTop, mRight, mBottom, mLeft] = Array.isArray(m) ? m : [m, m, m, m];
  const quality = normalizedOptions.jpegQuality ?? 0.85;
  const useCORS = normalizedOptions.useCORS ?? false;
  const pagination = normalizedOptions.pagination ?? false;
  const precision = (normalizedOptions.precision ?? 2) | 0;
  const compress = normalizedOptions.compress ?? false;
  const ignoreElements = normalizedOptions.ignoreElements;

  // Fonts
  const fontConfigs = normalizedOptions.fontConfig ?? [];
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
  //            undefined/null + pagination -> library default (page-number footer).
  const staticHF = resolveStaticHF(normalizedOptions, pagination);

  // Pre-collect images.
  const imgElements = Array.from(root.querySelectorAll('img'))
    .filter((img) => !(ignoreElements && ignoreElements(img)));
  const images: CollectedImage[] = [];
  const imgToId = new Map<HTMLElement, number>();
  // convertImage rasterizes pixels from a detached, independently-loaded clone
  // (needed for CORS reload), so its success says nothing about this *live*
  // element's own layout state. The tree walk below reads each image node's
  // box from a *separate*, later getBoundingClientRect() call — on a page
  // with lazy/virtualized images (src added/removed as they scroll in and
  // out of range), that box can legitimately shrink to 0x0 in the gap
  // between the two reads, even though it was non-zero right here. Freeze
  // the box now, at the same instant the pixels are captured, and hand it to
  // the tree walk instead of re-measuring later.
  const imgRectAtConvert = new Map<HTMLElement, DOMRect>();
  await Promise.all(
    imgElements.map(async (img) => {
      // Capture synchronously, before the async pixel conversion below —
      // not after — so a virtualization/lazy-unload that happens *during*
      // that await can't shrink the box out from under us.
      imgRectAtConvert.set(img, img.getBoundingClientRect());
      const conv = await convertImage(img, quality, useCORS);
      if (!conv) {
        imgRectAtConvert.delete(img);
        return;
      }
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

  type MeasuredTextFragment = {
    rawRect: DOMRect;
    x: number;
    y: number;
    w: number;
    h: number;
    start16: number;
    end16: number;
  };

  function collectTextFragments(
    textNode: Text,
    start16 = 0,
    end16 = textNode.data.length,
  ): MeasuredTextFragment[] {
    const text = textNode.data;
    if (!text || start16 >= end16) return [];
    range.setStart(textNode, start16);
    range.setEnd(textNode, end16);
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
    if (groups.length === 1) {
      const d = docRect(groups[0]);
      return [{
        rawRect: groups[0],
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        start16,
        end16,
      }];
    }
    const lines: MeasuredTextFragment[] = [];
    let prev = start16;
    for (let li = 0; li < groups.length; li++) {
      const raw = groups[li];
      const lineStart16 = lowerBoundTop(textNode, raw.top - 1, prev, end16);
      const nextTop = li + 1 < groups.length ? groups[li + 1].top : Infinity;
      const lineEnd16 = lowerBoundTop(textNode, nextTop - 1, lineStart16, end16);
      prev = lineEnd16;
      if (lineEnd16 <= lineStart16) continue;
      const d = docRect(raw);
      lines.push({
        rawRect: raw,
        x: d.x,
        y: d.y,
        w: d.w,
        h: d.h,
        start16: lineStart16,
        end16: Math.min(lineEnd16, end16),
      });
    }
    return lines;
  }

  function linesFromFragments(text: string, baseStart16: number, fragments: MeasuredTextFragment[]): LineBox[] {
    const off = utf8Offsets(text);
    return fragments.map((frag) => ({
      x: frag.x,
      y: frag.y,
      w: frag.w,
      h: frag.h,
      start: off[Math.max(0, frag.start16 - baseStart16)],
      end: off[Math.max(0, Math.min(text.length, frag.end16 - baseStart16))],
    }));
  }

  function collectTextLines(textNode: Text, start16 = 0, end16 = textNode.data.length): LineBox[] {
    const text = textNode.data.slice(start16, end16);
    if (!text) return [];
    return linesFromFragments(text, start16, collectTextFragments(textNode, start16, end16));
  }

  function buildInlineRuns(text: string): InlineRun[] {
    const graphemes = segmentGraphemes(text);
    if (graphemes.length === 0) return [];
    const runs: InlineRun[] = [];
    let currentKind: InlineRun['kind'] = graphemeNeedsBitmapFallback(graphemes[0].text) ? 'bitmap' : 'text';
    let start16 = graphemes[0].start16;
    let end16 = graphemes[0].end16;
    for (let i = 1; i < graphemes.length; i++) {
      const segment = graphemes[i];
      const kind: InlineRun['kind'] = graphemeNeedsBitmapFallback(segment.text) ? 'bitmap' : 'text';
      if (kind === currentKind) {
        end16 = segment.end16;
      } else {
        runs.push({ kind: currentKind, text: text.slice(start16, end16), start16, end16 });
        currentKind = kind;
        start16 = segment.start16;
        end16 = segment.end16;
      }
    }
    runs.push({ kind: currentKind, text: text.slice(start16, end16), start16, end16 });
    return runs;
  }

function isCodePointInRange(codePoint: number, ranges: [number, number][]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function pickLangFontOverride(
  grapheme: string,
  computedStyle: CSSStyleDeclaration,
  langFontConfigs: FontConfig[] | undefined,
): FontOverride | undefined {
  if (!langFontConfigs || langFontConfigs.length === 0) return undefined;
  const codePoint = grapheme.codePointAt(0);
  if (codePoint == null) return undefined;
  const targetWeight = normalizeLegacyFontWeight(weightNum(computedStyle.fontWeight));
  const targetStyle = normalizeLegacyFontStyle(computedStyle.fontStyle);
  const candidates = langFontConfigs.filter((fontConfig) => (
    normalizeLegacyFontWeight(fontConfig.fontWeight) === targetWeight
      && normalizeLegacyFontStyle(fontConfig.fontStyle) === targetStyle
  ));
  if (candidates.length === 0) {
    return {
      family: 'Helvetica',
      italic: targetStyle === 'italic' ? 1 : 0,
      weight: targetWeight,
    };
  }
  let defaultFont: FontConfig | null = null;
  for (const candidate of candidates) {
    if (candidate.charRange && isCodePointInRange(codePoint, candidate.charRange)) {
      return {
        family: candidate.fontFamily,
        italic: targetStyle === 'italic' ? 1 : 0,
        weight: targetWeight,
      };
    }
    if (candidate.isDefault && !defaultFont) {
      defaultFont = candidate;
    }
  }
  if (defaultFont) {
    return {
      family: defaultFont.fontFamily,
      italic: targetStyle === 'italic' ? 1 : 0,
      weight: targetWeight,
    };
  }
  return {
    family: 'Helvetica',
    italic: targetStyle === 'italic' ? 1 : 0,
    weight: targetWeight,
  };
}

function fontOverrideKey(fontOverride: FontOverride | undefined): string {
  if (!fontOverride) return '';
  return `${fontOverride.family}|${fontOverride.weight}|${fontOverride.italic}`;
}

function buildInlineRunsWithLangFont(
  text: string,
  computedStyle: CSSStyleDeclaration,
  langFontConfigs: FontConfig[] | undefined,
): InlineRun[] {
  const graphemes = segmentGraphemes(text);
  if (graphemes.length === 0) return [];
  const runs: InlineRun[] = [];
  let currentKind: InlineRun['kind'] = graphemeNeedsBitmapFallback(graphemes[0].text) ? 'bitmap' : 'text';
  let currentFontOverride = pickLangFontOverride(graphemes[0].text, computedStyle, langFontConfigs);
  let start16 = graphemes[0].start16;
  let end16 = graphemes[0].end16;
  for (let i = 1; i < graphemes.length; i++) {
    const segment = graphemes[i];
    const kind: InlineRun['kind'] = graphemeNeedsBitmapFallback(segment.text) ? 'bitmap' : 'text';
    const fontOverride = pickLangFontOverride(segment.text, computedStyle, langFontConfigs);
    if (kind === currentKind && fontOverrideKey(fontOverride) === fontOverrideKey(currentFontOverride)) {
      end16 = segment.end16;
      continue;
    }
    runs.push({
      kind: currentKind,
      text: text.slice(start16, end16),
      start16,
      end16,
      fontOverride: currentFontOverride,
    });
    currentKind = kind;
    currentFontOverride = fontOverride;
    start16 = segment.start16;
    end16 = segment.end16;
  }
  runs.push({
    kind: currentKind,
    text: text.slice(start16, end16),
    start16,
    end16,
    fontOverride: currentFontOverride,
  });
  return runs;
}

  function canvasFontForComputedStyle(cs: CSSStyleDeclaration): string {
    const style = cs.fontStyle && cs.fontStyle !== 'normal' ? `${cs.fontStyle} ` : '';
    const weight = cs.fontWeight && cs.fontWeight !== 'normal' ? `${cs.fontWeight} ` : '';
    const size = `${parseFloat(cs.fontSize) || 16}px`;
    const family = cs.fontFamily || 'sans-serif';
    return `${style}${weight}${size} ${family}`.trim();
  }

  async function rasterizeInlineBitmapRun(
    text: string,
    rawRect: DOMRect,
    cs: CSSStyleDeclaration,
  ): Promise<{
    image: Omit<CollectedImage, 'id'>;
    offsetX: number;
    offsetY: number;
    cssWidth: number;
    cssHeight: number;
  } | null> {
    if (!text || rawRect.width <= 0 || rawRect.height <= 0) return null;
    const pad = 1;
    const cssWidth = rawRect.width + pad * 2;
    const cssHeight = rawRect.height + pad * 2;
    const ss = superSampleFactor(cssWidth, cssHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(cssWidth * ss));
    canvas.height = Math.max(1, Math.ceil(cssHeight * ss));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(ss, ss);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.font = canvasFontForComputedStyle(cs);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = rgbaCss(parseColor(cs.color));
    const metrics = ctx.measureText(text || 'M');
    const ascent = metrics.actualBoundingBoxAscent || (parseFloat(cs.fontSize) || 16) * 0.8;
    const descent = metrics.actualBoundingBoxDescent || (parseFloat(cs.fontSize) || 16) * 0.2;
    const baseline = pad + Math.max(ascent, (rawRect.height - (ascent + descent)) / 2 + ascent);
    const letterSpacing = parseFloat(cs.letterSpacing) || 0;
    const wordSpacing = parseFloat(cs.wordSpacing) || 0;
    let x = pad;
    const graphemes = segmentGraphemes(text);
    for (let i = 0; i < graphemes.length; i++) {
      const segment = graphemes[i].text;
      ctx.fillText(segment, x, baseline);
      x += ctx.measureText(segment).width;
      if (i + 1 < graphemes.length) {
        x += letterSpacing;
        if (segment === ' ') x += wordSpacing;
      }
    }
    const rgba = canvasToRawRgba(canvas);
    if (!rgba) return null;
    return {
      image: {
        bytes: rgba.bytes,
        width: rgba.width,
        height: rgba.height,
        format: IMG_RAW_RGBA,
      },
      offsetX: pad * layoutScale,
      offsetY: pad * layoutScale,
      cssWidth: cssWidth * layoutScale,
      cssHeight: cssHeight * layoutScale,
    };
  }

  function makeFont(cs: CSSStyleDeclaration): NodeRec['font'] {
    const sizePx = (parseFloat(cs.fontSize) || 16) * layoutScale;
    let lh = parseFloat(cs.lineHeight);
    if (isNaN(lh)) lh = sizePx * 1.2;
    else lh *= layoutScale;
    const letterSpacingPx = (parseFloat(cs.letterSpacing) || 0) * layoutScale;
    const wordSpacingPx = (parseFloat(cs.wordSpacing) || 0) * layoutScale;
    const preserveWhitespace = /^(pre|pre-wrap|break-spaces)$/.test((cs.whiteSpace || '').trim()) ? 1 : 0;
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
      preserveWhitespace,
    };
  }

  function applyFontOverride(
    font: NonNullable<NodeRec['font']>,
    fontOverride: FontOverride | undefined,
  ): NonNullable<NodeRec['font']> {
    if (!fontOverride) return font;
    return {
      ...font,
      family: fontOverride.family,
      italic: fontOverride.italic,
      weight: fontOverride.weight,
    };
  }

  function pushTextNode(
    parentId: number,
    font: NonNullable<NodeRec['font']>,
    text: string,
    lines: LineBox[],
    opacity?: number,
    renderMode = 0,
  ) {
    if (!text || lines.length === 0) return;
    nodes.push({
      id: nodes.length,
      parent: parentId,
      kind: 1,
      x: lines[0].x,
      y: lines[0].y,
      w: Math.max(...lines.map((l) => l.x + l.w)) - Math.min(...lines.map((l) => l.x)),
      h: Math.max(...lines.map((l) => l.y + l.h)) - Math.min(...lines.map((l) => l.y)),
      flags: F_FONT | (opacity !== undefined ? F_OPACITY : 0),
      font,
      overflowHidden: false,
      opacity,
      renderMode,
      divisionDisable: false,
      pageBreak: false,
      text,
      lines,
    });
  }

  // Map from row group elements (THEAD/TBODY/TFOOT) to their deferred rowspan cells.
  // Used to fix table rowspan rendering order — see the comment in visit().
  const rowGroupDeferredCells = new Map<HTMLElement, Array<{ cell: HTMLElement }>>();

  // `forcedBg`: an opaque backdrop colour (rgb string) to paint under a cell that
  // is otherwise background-transparent. Used for deferred rowspan cells in a
  // `border-collapse: collapse` table so they can cover the row separator borders
  // (e.g. a <tr>'s border-bottom) that visually cross them — mirroring how the
  // browser's collapse model hides internal row borders behind a spanning cell.
  async function visit(el: HTMLElement, parentId: number, forcedBg?: [number, number, number, number]): Promise<void> {
    if (ignoreElements && ignoreElements(el)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const id = nodes.length;
    const isImg = el.tagName === 'IMG' && imgToId.has(el);
    // For images, reuse the box frozen at conversion time instead of
    // re-measuring now — see the comment by imgRectAtConvert above.
    const rawRect = (isImg && imgRectAtConvert.get(el)) || el.getBoundingClientRect();
    const r = docRect(rawRect);

    const kind = isImg ? 2 : 0;
    const strategy: RenderStrategy = isImg ? 'vector' : classifyRenderStrategy(el, cs);

    if (strategy === 'full-raster' && r.w > 0 && r.h > 0) {
      const raster = await rasterizeElement(el, rawRect, quality, cs);
      if (raster) {
        const imageId = images.length + 1;
        images.push({
          id: imageId,
          bytes: raster.bytes,
          width: raster.width,
          height: raster.height,
          format: raster.format,
        });
        const rawX = raster.rawLeft + window.scrollX - offX;
        const rawY = raster.rawTop + window.scrollY - offY;
        // Layout size comes from the CSS box, NOT the supersampled pixel count —
        // otherwise a 2-3x raster would scale the element up by the same factor.
        const scaledW = raster.cssWidth * layoutScale;
        const scaledH = raster.cssHeight * layoutScale;
        nodes.push({
          id,
          parent: parentId,
          kind: 2,
          x: rawX * layoutScale,
          y: rawY * layoutScale,
          w: scaledW,
          h: scaledH,
          flags: F_IMAGE,
          overflowHidden: false,
          renderMode: 0,
          divisionDisable: el.hasAttribute('divisionDisable'),
          pageBreak: el.hasAttribute('pageBreak'),
          imageId,
          objectFit: 0,
        });
        return;
      }
    }

    let bg = parseColor(cs.backgroundColor);
    // A deferred rowspan cell with a transparent background can't cover the row
    // separator borders that cross it (see forcedBg above). Substitute the
    // caller-provided opaque backdrop so the cell paints a solid fill matching
    // what the browser shows through the transparent cell.
    if (forcedBg && bg[3] <= 0.001) {
      bg = forcedBg;
    }
    // Semi-transparent backgrounds (e.g. rgba(27,31,35,0.05) used by CODE tags on
    // juejin.cn) cannot be faithfully reproduced in PDF — the Rust backend ignores
    // the alpha channel and paints an opaque rect. Pre-multiply with the nearest
    // opaque ancestor background so the blended colour matches the browser.
    if (bg[3] > 0.001 && bg[3] < 1) {
      const backdrop = findOpaqueBackdropColor(el);
      const bd = parseColor(backdrop);
      const a = bg[3];
      const invA = 1 - a;
      bg = [
        bg[0] * a + bd[0] * invA,
        bg[1] * a + bd[1] * invA,
        bg[2] * a + bd[2] * invA,
        1,
      ];
    }
    // background-raster elements bake their whole background (incl. gradients and
    // ::before) into a backdrop image via foreignObject below. The vector box must
    // NOT carry a separate bg fill, or the PDF side will paint a second opaque rect
    // on top, doubling up on the already-rasterized background. However, a simple
    // solid color background (no gradient/url) is cheaper and more accurate to
    // paint as a vector rect; only complex backgrounds need the raster exclusion.
    const hasBg = bg[3] > 0.001
      && (strategy !== 'background-raster' || !hasComplexBackground(cs));
    // background-raster elements bake their whole background (incl. gradients) via
    // foreignObject below, so skip the gradient→image path to avoid a double backdrop.
    const gradientImage = !isImg && kind === 0 && r.w > 0 && r.h > 0 && strategy !== 'background-raster'
      ? convertBackgroundImageToImage(cs.backgroundImage, r.w, r.h, quality, hasBg ? bg : null)
      : null;
    const bw: [number, number, number, number] = [
      (parseFloat(cs.borderTopWidth) || 0) * layoutScale,
      (parseFloat(cs.borderRightWidth) || 0) * layoutScale,
      (parseFloat(cs.borderBottomWidth) || 0) * layoutScale,
      (parseFloat(cs.borderLeftWidth) || 0) * layoutScale,
    ];
    const bc: [
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
      [number, number, number, number],
    ] = [
      parseColor(cs.borderTopColor),
      parseColor(cs.borderRightColor),
      parseColor(cs.borderBottomColor),
      parseColor(cs.borderLeftColor),
    ];
    const bs: [number, number, number, number] = [
      borderStyleNum(cs.borderTopStyle),
      borderStyleNum(cs.borderRightStyle),
      borderStyleNum(cs.borderBottomStyle),
      borderStyleNum(cs.borderLeftStyle),
    ];
    const sidePaints = (i: number, style: string): boolean =>
      bw[i] > 0 && style !== 'none' && style !== 'hidden' && bc[i][3] > 0.001;
    const isRoot = parentId === -1;
    const visibleBorder = !isRoot && (sidePaints(0, cs.borderTopStyle)
      || sidePaints(1, cs.borderRightStyle)
      || sidePaints(2, cs.borderBottomStyle)
      || sidePaints(3, cs.borderLeftStyle));
    const shadow = kind === 0 && !isRoot ? parseBoxShadow(cs.boxShadow) : [];
    const radius: [number, number, number, number] = [
      (parseFloat(cs.borderTopLeftRadius) || 0) * layoutScale,
      (parseFloat(cs.borderTopRightRadius) || 0) * layoutScale,
      (parseFloat(cs.borderBottomRightRadius) || 0) * layoutScale,
      (parseFloat(cs.borderBottomLeftRadius) || 0) * layoutScale,
    ];
    const hasRadius = (radius[0] + radius[1] + radius[2] + radius[3]) > 0;
    const overflowHidden = clipsOverflow(cs);
    const opacity = parseFloat(cs.opacity);
    const hasOpacity = opacity < 1;

    const dm = el.dataset.dom2pdfMode;
    const renderMode = dm === 'raster' ? 1 : dm === 'skip' ? 2 : 0;

    const divisionDisable = el.hasAttribute('divisionDisable');
    const pageBreak = el.hasAttribute('pageBreak');

    let flags = 0;
    if (hasBg) flags |= F_BG;
    if (visibleBorder) flags |= F_BORDER;
    if (shadow.length > 0) flags |= F_SHADOW;
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
      shadow: shadow.length > 0 ? shadow.map((s) => ({
        x: s.x * layoutScale,
        y: s.y * layoutScale,
        blur: s.blur * layoutScale,
        spread: s.spread * layoutScale,
        color: s.color,
      })) : undefined,
      radius: hasRadius ? radius : undefined,
      overflowHidden,
      opacity: hasOpacity ? opacity : undefined,
      renderMode,
      divisionDisable,
      pageBreak,
      imageId: isImg ? imgToId.get(el) : undefined,
      objectFit: isImg ? objectFitNum(cs.objectFit) : undefined,
    };

    if (isRasterTag(el)) {
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

    // background-raster: bake only this element's background + ::before into a
    // backdrop image laid under the (still vector) text. Same node shape as the
    // gradient backdrop above; pushed before children so it draws beneath text.
    if (strategy === 'background-raster' && !gradientImage && r.w > 0 && r.h > 0) {
      const bgRaster = await rasterizeElementBackgroundOnly(el, rawRect);
      if (bgRaster) {
        const imageId = images.length + 1;
        images.push({ id: imageId, ...bgRaster });
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
    }

    // --- Table rowspan fix ---
    // In HTML table rendering, cell backgrounds paint on top of row backgrounds.
    // However, in our flat tree walk, a subsequent <tr>'s background can cover
    // rowspan cells from a previous <tr>. To fix this, when visiting a table row
    // group (THEAD/TBODY/TFOOT), we defer <td>/<th> children with rowspan > 1
    // and visit them AFTER all <tr> siblings, so they paint on top.
    const isRowGroup = el.tagName === 'THEAD' || el.tagName === 'TBODY' || el.tagName === 'TFOOT' || el.tagName === 'TABLE';

    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        const childEl = child as HTMLElement;
        // When visiting a <tr>, skip <td>/<th> with rowspan > 1 and collect them
        // for deferred painting at the row-group level.
        if (el.tagName === 'TR' && (childEl.tagName === 'TD' || childEl.tagName === 'TH')) {
          const rowspan = (childEl as HTMLTableCellElement).rowSpan;
          if (rowspan > 1) {
            // Find the ancestor row group to defer this cell to. The cell will
            // be visited as a direct child of the row group so it paints after
            // all rows, letting its background cover row backgrounds below it.
            const rowGroup = el.parentElement;
            if (rowGroup && (rowGroup.tagName === 'THEAD' || rowGroup.tagName === 'TBODY' || rowGroup.tagName === 'TFOOT' || rowGroup.tagName === 'TABLE')) {
              // Store a reference; the row group's visit will handle it.
              if (!rowGroupDeferredCells.has(rowGroup)) {
                rowGroupDeferredCells.set(rowGroup, []);
              }
              rowGroupDeferredCells.get(rowGroup)!.push({ cell: childEl });
              continue;
            }
          }
        }
        if (ignoreElements && ignoreElements(childEl)) continue;
        await visit(childEl, id);
      } else if (child.nodeType === 3) {
        const textNode = child as Text;
        const text = textNode.data;
        if (!text) continue;
        const font = makeFont(cs) as NonNullable<NodeRec['font']>;
        const runs = normalizedOptions.langFontConfig
          ? buildInlineRunsWithLangFont(text, cs, normalizedOptions.langFontConfig)
          : buildInlineRuns(text);
        const hasBitmapRun = runs.some((run) => run.kind === 'bitmap');
        if (!hasBitmapRun) {
          for (const run of runs) {
            const lines = collectTextLines(textNode, run.start16, run.end16);
            if (lines.length === 0) continue;
            pushTextNode(id, applyFontOverride(font, run.fontOverride), run.text, lines);
          }
          continue;
        }
        for (const run of runs) {
          const fragments = collectTextFragments(textNode, run.start16, run.end16);
          if (fragments.length === 0) continue;
          const runFont = applyFontOverride(font, run.fontOverride);
          if (run.kind === 'text') {
            const lines = linesFromFragments(run.text, run.start16, fragments);
            pushTextNode(id, runFont, run.text, lines);
            continue;
          }
          const bitmapNodes: Array<{
            image: Omit<CollectedImage, 'id'>;
            x: number;
            y: number;
            w: number;
            h: number;
          }> = [];
          for (const fragment of fragments) {
            const fragmentText = text.slice(fragment.start16, fragment.end16);
            const raster = await rasterizeInlineBitmapRun(fragmentText, fragment.rawRect, cs);
            if (!raster) {
              bitmapNodes.length = 0;
              break;
            }
            bitmapNodes.push({
              image: raster.image,
              x: fragment.x - raster.offsetX,
              y: fragment.y - raster.offsetY,
              w: raster.cssWidth,
              h: raster.cssHeight,
            });
          }
          if (bitmapNodes.length === 0) {
            const fallbackLines = linesFromFragments(run.text, run.start16, fragments);
            pushTextNode(id, runFont, run.text, fallbackLines);
            continue;
          }
          for (const bitmapNode of bitmapNodes) {
            const imageId = images.length + 1;
            images.push({ id: imageId, ...bitmapNode.image });
            nodes.push({
              id: nodes.length,
              parent: id,
              kind: 2,
              x: bitmapNode.x,
              y: bitmapNode.y,
              w: bitmapNode.w,
              h: bitmapNode.h,
              flags: F_IMAGE,
              overflowHidden: false,
              renderMode: 0,
              divisionDisable: false,
              pageBreak: false,
              imageId,
              objectFit: 0,
            });
          }
          // Preserve extractable text for bitmap fallback runs by adding an
          // invisible text node at the same geometry. Visual output still comes
          // from the rasterized image nodes above.
          const hiddenLines = linesFromFragments(run.text, run.start16, fragments);
          // Emit an invisible text object instead of alpha=0. Many PDF text
          // extractors keep `Tr 3` text but ignore fully transparent glyphs.
          pushTextNode(id, runFont, run.text, hiddenLines, undefined, 3);
        }
      }
    }

    // After visiting all children of a row group (THEAD/TBODY/TFOOT),
    // visit the deferred rowspan > 1 cells as direct children of the row group.
    // They are painted last so they render ON TOP of all <tr> backgrounds,
    // matching browser rendering order.
    if (isRowGroup && rowGroupDeferredCells.has(el)) {
      const deferred = rowGroupDeferredCells.get(el)!;
      rowGroupDeferredCells.delete(el);
      // In a `border-collapse: collapse` table, each <tr>'s border-bottom is
      // drawn as its own rect and visually crosses a spanning cell. The browser
      // hides those internal borders behind the spanning cell; we replicate that
      // by giving a transparent spanning cell an opaque backdrop so its fill (now
      // painted last, on top of the row borders) covers them. Cells that already
      // have their own background need no help.
      const tableEl = el.tagName === 'TABLE' ? el : el.closest('table');
      const collapsed = tableEl ? getComputedStyle(tableEl).borderCollapse === 'collapse' : false;
      for (const { cell } of deferred) {
        let forcedBg: [number, number, number, number] | undefined;
        if (collapsed && parseColor(getComputedStyle(cell).backgroundColor)[3] <= 0.001) {
          forcedBg = parseColor(findOpaqueBackdropColor(cell));
        }
        await visit(cell, id, forcedBg);
      }
    }
  }

  await visit(root, -1);

  // Resolve config-level HF geometry.
  const staticHeader = staticHF ? resolveRegion(staticHF.header, false) : null;
  const staticFooter = staticHF ? resolveRegion(staticHF.footer, true) : null;
  // Function-form: sample page 1 to derive a uniform reserved band height.
  // (Pagination needs a single content-area height; per-page text is resolved
  // later by index.ts once totalPages is known.)
  let headerHPx = staticHeader?.heightPx ?? 0;
  let footerHPx = staticFooter?.heightPx ?? 0;
  if (typeof normalizedOptions.pageConfig === 'function' && pagination) {
    const sample = normalizedOptions.pageConfig(1, 1);
    if (sample) {
      const sh = resolveRegion(sample.header, false);
      const sf = resolveRegion(sample.footer, true);
      headerHPx = sh?.heightPx ?? 0;
      footerHPx = sf?.heightPx ?? 0;
    }
  }

  return {
    pageWidthPt, pageHeightPt, mTop, mRight, mBottom, mLeft,
    precision, pagination, compress, backgroundColor: normalizedOptions.backgroundColor ?? null,
    headerHPx, footerHPx,
    staticHeader, staticFooter,
    staticWatermark: typeof normalizedOptions.watermark === 'function'
      ? null
      : watermarkNeedsPerPageResolution(normalizedOptions.watermark)
        ? null
        : await resolveWatermark(normalizedOptions.watermark, images),
    perPageHF: [],
    perPageWatermark: [],
    fonts, nodes, images,
  };
}

/** Encode collected data into the v2 snapshot binary, attaching per-page HF. */
export function encodeSnapshot(
  data: EncodeArgs,
  perPageHF: ResolvedPageHF[],
  perPageWatermark: (ResolvedWatermark | null)[] = [],
): Uint8Array {
  // Convert ResolvedPageHF[] to the [header, footer] pair shape encode() expects.
  const pairs: (ResolvedHF | null)[][] = perPageHF.map((hf) => [hf.header, hf.footer]);
  return encode({ ...data, perPageHF: pairs, perPageWatermark });
}

export interface EncodeArgs {
  pageWidthPt: number;
  pageHeightPt: number;
  mTop: number; mRight: number; mBottom: number; mLeft: number;
  precision: number;
  pagination: boolean;
  compress: boolean;
  backgroundColor: string | null;
  headerHPx: number;
  footerHPx: number;
  staticHeader: ResolvedHF | null;
  staticFooter: ResolvedHF | null;
  staticWatermark: ResolvedWatermark | null;
  perPageHF: (ResolvedHF | null)[][]; // each: [header|null, footer|null]
  perPageWatermark: (ResolvedWatermark | null)[];
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

function writeWatermark(w: BinWriter, watermark: ResolvedWatermark) {
  w.u8(watermark.kind);
  w.f32(watermark.angleDeg);
  w.f32(watermark.spacing[0]); w.f32(watermark.spacing[1]);
  w.f32(watermark.offset[0]); w.f32(watermark.offset[1]);
  w.u8(watermark.layer);
  if (watermark.kind === 0) {
    const tlen = BinWriter.utf8Len(watermark.text);
    const famLen = BinWriter.utf8Len(watermark.fontFamily);
    w.u16(tlen);
    w.utf8(watermark.text);
    w.f32(watermark.color[0]); w.f32(watermark.color[1]); w.f32(watermark.color[2]); w.f32(watermark.color[3]);
    w.u16(famLen);
    w.utf8(watermark.fontFamily);
    w.f32(watermark.fontSizePx);
    w.u16(watermark.fontWeight);
    w.u8(watermark.italic);
  } else {
    w.u32(watermark.imageId);
    w.f32(watermark.imageWidthPx);
    w.f32(watermark.imageHeightPx);
    w.f32(watermark.opacity);
  }
}

function writeOptWatermark(w: BinWriter, watermark: ResolvedWatermark | null) {
  if (watermark) {
    w.u8(1);
    writeWatermark(w, watermark);
  } else {
    w.u8(0);
  }
}

function encode(a: EncodeArgs): Uint8Array {
  const w = new BinWriter();
  w.bytes(new Uint8Array([0x44, 0x32, 0x50, 0x31])); // "D2P1"
  w.u32(10); // version 10 (adds image watermark support)
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
  w.u8(a.compress ? 1 : 0);
  writeOptWatermark(w, a.staticWatermark);

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

  // Per-page watermark block
  w.u32(a.perPageWatermark.length);
  for (const watermark of a.perPageWatermark) {
    writeOptWatermark(w, watermark);
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
    if (n.shadow && n.shadow.length > 0) flags |= F_SHADOW;
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
      for (let i = 0; i < 4; i++) {
        w.f32(n.border.c[i][0]); w.f32(n.border.c[i][1]); w.f32(n.border.c[i][2]); w.f32(n.border.c[i][3]);
      }
      w.u8(n.border.s[0]); w.u8(n.border.s[1]); w.u8(n.border.s[2]); w.u8(n.border.s[3]);
    }
    if (n.shadow && n.shadow.length > 0) {
      w.u8(n.shadow.length);
      for (const s of n.shadow) {
        w.f32(s.x); w.f32(s.y); w.f32(s.blur); w.f32(s.spread);
        w.f32(s.color[0]); w.f32(s.color[1]); w.f32(s.color[2]); w.f32(s.color[3]);
      }
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
      w.u8(n.font.preserveWhitespace);
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
    w.u8(img.format);
    w.u32(img.bytes.length);
    w.bytes(img.bytes);
  }

  return w.result();
}

/** Compute page-break Y positions (document px, relative to root top) for overlays. */
export function computePageBreaks(root: HTMLElement, options: ExportOptions = {}): number[] {
  const normalizedOptions = normalizeLegacyOptions(options);
  const [fmtW, fmtH] = resolvePageSize(normalizedOptions.format);
  const pageWidthPt = normalizedOptions.pageWidthPt ?? fmtW;
  const pageHeightPt = normalizedOptions.pageHeightPt ?? fmtH;
  const m = normalizedOptions.marginPt ?? 36;
  const mTop = Array.isArray(m) ? m[0] : m;
  const mRight = Array.isArray(m) ? m[1] : m;
  const mBottom = Array.isArray(m) ? m[2] : m;
  const mLeft = Array.isArray(m) ? m[3] : m;
  const pagination = normalizedOptions.pagination ?? false;
  if (!pagination) return [];
  const staticHF = resolveStaticHF(normalizedOptions, pagination);
  const headerHPt = (staticHF?.header?.height ?? 0) * PX_TO_PT;
  const footerHPt = (staticHF?.footer?.height ?? 0) * PX_TO_PT;
  const contentHpt = pageHeightPt - mTop - mBottom - headerHPt - footerHPt;
  const contentHpx = (contentHpt > 0 ? contentHpt : pageHeightPt - mTop - mBottom) / PX_TO_PT;
  const layoutScale = computeLayoutScale(root.getBoundingClientRect().width, pageWidthPt, mLeft, mRight);
  const rootH = root.getBoundingClientRect().height;
  const breakStep = contentHpx / layoutScale;
  if (!(breakStep > 0) || !(rootH > 0)) return [];

  const rootRect = root.getBoundingClientRect();
  const epsilon = 0.5;
  const breaks: number[] = [];
  let pageStart = 0;
  let pageEnd = breakStep;

  const pushBreak = (y: number) => {
    const next = Math.max(0, Math.min(rootH, y));
    const prev = breaks.length > 0 ? breaks[breaks.length - 1] : 0;
    if (next <= prev + epsilon || next >= rootH - epsilon) return false;
    breaks.push(next);
    pageStart = next;
    pageEnd = next + breakStep;
    return true;
  };

  const advanceImplicitPages = (y: number) => {
    while (y >= pageEnd - epsilon && pageEnd < rootH - epsilon) {
      if (!pushBreak(pageEnd)) break;
    }
  };

  const directives = Array.from(root.querySelectorAll<HTMLElement>('[pageBreak], [divisionDisable]'))
    .map((el, order) => {
      const rect = el.getBoundingClientRect();
      const top = rect.top - rootRect.top;
      const bottom = rect.bottom - rootRect.top;
      return {
        bottom: Math.max(0, Math.min(rootH, bottom)),
        divisionDisable: el.hasAttribute('divisionDisable'),
        order,
        pageBreak: el.hasAttribute('pageBreak'),
        top: Math.max(0, Math.min(rootH, top)),
      };
    })
    .filter((item) => item.bottom > item.top + epsilon)
    .sort((a, b) => (a.top - b.top) || (a.order - b.order));

  for (const item of directives) {
    advanceImplicitPages(item.top);
    if (item.pageBreak) {
      if (item.top > pageStart + epsilon) {
        pushBreak(item.top);
      }
      continue;
    }
    const height = item.bottom - item.top;
    if (height < breakStep - epsilon && item.bottom > pageEnd + epsilon && item.top > pageStart + epsilon) {
      pushBreak(item.top);
    }
  }

  advanceImplicitPages(rootH);
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

export interface ResolvedPageWatermark {
  watermark: ResolvedWatermark | null;
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
    if (pageConfigExcludesPage(cfg, p + 1)) {
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

/** Resolve per-page HF for object-form pageConfig with excludePage(s) support. */
export function resolveStaticPageConfigHF(
  pageConfig: PageConfigOptions,
  totalPages: number,
): ResolvedPageHF[] {
  const out: ResolvedPageHF[] = [];
  for (let p = 0; p < totalPages; p++) {
    const pageNum = p + 1;
    if (pageConfigExcludesPage(pageConfig, pageNum)) {
      out.push({ header: null, footer: null });
      continue;
    }
    out.push({
      header: resolveRegion(pageConfig.header, false),
      footer: resolveRegion(pageConfig.footer, true),
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

/** Resolve per-page watermark for a function-form config given totalPages. */
export async function resolvePerPageWatermark(
  watermarkConfig: (pageNum: number, totalPages: number) => WatermarkOptions | null,
  totalPages: number,
  images: CollectedImage[] = [],
  imageCache: Map<string, WatermarkImageAsset> = new Map(),
): Promise<ResolvedPageWatermark[]> {
  const out: ResolvedPageWatermark[] = [];
  for (let p = 0; p < totalPages; p++) {
    const pageNum = p + 1;
    const config = watermarkConfig(pageNum, totalPages);
    if (!config || configExcludesPage(config, pageNum)) {
      out.push({ watermark: null });
      continue;
    }
    out.push({ watermark: await resolveWatermark(config, images, imageCache) });
  }
  return out;
}

/** Resolve per-page watermark for object-form config with excludePage(s) support. */
export async function resolveStaticWatermarkPages(
  watermark: WatermarkOptions,
  totalPages: number,
  images: CollectedImage[] = [],
  imageCache: Map<string, WatermarkImageAsset> = new Map(),
): Promise<ResolvedPageWatermark[]> {
  const out: ResolvedPageWatermark[] = [];
  for (let p = 0; p < totalPages; p++) {
    const pageNum = p + 1;
    out.push({
      watermark: configExcludesPage(watermark, pageNum) ? null : await resolveWatermark(watermark, images, imageCache),
    });
  }
  return out;
}

/** Replace placeholders in resolved watermark text (function-form: JS resolves). */
export function resolvePerPageWatermarkText(
  perPage: ResolvedPageWatermark[],
  totalPages: number,
): (ResolvedWatermark | null)[] {
  return perPage.map((entry, p) => (
    entry.watermark
      ? isResolvedTextWatermark(entry.watermark)
        ? { ...entry.watermark, text: resolvePlaceholder(entry.watermark.text, p, totalPages) }
        : entry.watermark
      : null
  ));
}

export { resolveRegion, resolvePlaceholder, normalizeExcludedPages, resolveWatermark };
export type { ResolvedHF, ResolvedWatermark };
