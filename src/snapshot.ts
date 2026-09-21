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

// #region debug-point A-E:pdf-gen-slow-instrumentation
type DebugPerfSnapshotState = {
  startedAt: number;
  strategyVector: number;
  strategyBackgroundRaster: number;
  strategyFullRaster: number;
  resolveBackdropColorCalls: number;
  resolveBackdropColorMs: number;
  resolveBackdropImageCalls: number;
  resolveBackdropImageMs: number;
  resolveBackdropAncestorScans: number;
  rasterBgCalls: number;
  rasterBgMs: number;
  rasterBgDepth: number;
  rasterBgMaxDepth: number;
  rasterBgCacheHits: number;
  rasterBgCacheMisses: number;
  rasterFullCalls: number;
  rasterFullMs: number;
};

type RasterRgbResult = { bytes: Uint8Array; width: number; height: number; format: number } | null;

type DebugPerfState = {
  snapshot: DebugPerfSnapshotState;
  backdropRasterCache: WeakMap<HTMLElement, Promise<RasterRgbResult>>;
};

function debugPerfFreshSnapshotState(): DebugPerfSnapshotState {
  return {
    startedAt: performance.now(),
    strategyVector: 0,
    strategyBackgroundRaster: 0,
    strategyFullRaster: 0,
    resolveBackdropColorCalls: 0,
    resolveBackdropColorMs: 0,
    resolveBackdropImageCalls: 0,
    resolveBackdropImageMs: 0,
    resolveBackdropAncestorScans: 0,
    rasterBgCalls: 0,
    rasterBgMs: 0,
    rasterBgDepth: 0,
    rasterBgMaxDepth: 0,
    rasterBgCacheHits: 0,
    rasterBgCacheMisses: 0,
    rasterFullCalls: 0,
    rasterFullMs: 0,
  };
}

function getDebugPerfState(): DebugPerfState {
  const key = '__dompdfDebugPerfState__';
  const g = globalThis as typeof globalThis & { [key: string]: DebugPerfState | undefined };
  if (!g[key]) {
    g[key] = {
      snapshot: debugPerfFreshSnapshotState(),
      backdropRasterCache: new WeakMap<HTMLElement, Promise<RasterRgbResult>>(),
    };
  }
  return g[key] as DebugPerfState;
}

function resetDebugPerfSnapshotState(): void {
  const state = getDebugPerfState();
  state.snapshot = debugPerfFreshSnapshotState();
  state.backdropRasterCache = new WeakMap<HTMLElement, Promise<RasterRgbResult>>();
}
// #endregion

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

export type HFSemanticPosition =
  | 'center' | 'centerLeft' | 'centerRight' | 'centerTop' | 'centerBottom'
  | 'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom';

export type ContentPosition = HFSemanticPosition | [number, number];

export interface HFCoordinatePosition {
  x: number | string;
  y: number | string;
  anchor?: HFSemanticPosition;
}

export interface PageRegionSlot {
  content: string;
  position?: HFSemanticPosition | HFCoordinatePosition;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  italic?: boolean;
}

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
  slots?: PageRegionSlot[];
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

export type ExportProgressStage =
  | 'collecting'
  | 'countingPages'
  | 'rendering'
  | 'done';

export interface ExportProgress {
  stage: ExportProgressStage;
  totalPages?: number;
  currentPage?: number;
}

export type FormMode = 'static' | 'interactive' | 'hybrid';

export type FormInclude =
  | 'text'
  | 'textarea'
  | 'select'
  | 'checkbox'
  | 'radio'
  | 'date-time'
  | 'range'
  | 'color'
  | 'file'
  | 'progress'
  | 'meter';

export interface FormOptions {
  mode?: FormMode;
  include?: FormInclude[];
}

export interface PdfEncryptionOptions {
  userPassword?: string;
  ownerPassword?: string;
  userPermissions?: EncryptionPermission[];
}

/** PDF document properties written into the Info dictionary. */
export interface PdfMetadataOptions {
  title?: string;
  author?: string;
  subject?: string;
  /** Space-separated keyword list; arrays are joined with spaces. */
  keywords?: string | string[];
  creator?: string;
  /** Defaults to 'dompdf.js' when any metadata is provided. */
  producer?: string;
}

/** Normalized metadata for the snapshot wire format ("" = field not set). */
export interface NormalizedPdfMetadata {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  creationDate: string;
  modDate: string;
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
    form: normalizeFormOptions(options.form),
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
  /** PDF document properties (Info dictionary). */
  metadata?: PdfMetadataOptions;
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
  /** Export progress callback with stage and page-level status. */
  onProgress?: (progress: ExportProgress) => void;
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
  /** Form export behavior. Defaults to static rendering. */
  form?: boolean | FormOptions;

  // ---- advanced pt-level overrides (take precedence over format/margins) ----
  pageWidthPt?: number;
  pageHeightPt?: number;
  /** Margins in pt: number (all sides) or [top, right, bottom, left]. Default 0. */
  marginPt?: number | [number, number, number, number];
  jpegQuality?: number;
}

interface NormalizedFormOptions {
  mode: FormMode;
  include: FormInclude[];
  includeSet: Set<FormInclude>;
}

interface NormalizedExportOptions extends Omit<ExportOptions, 'form'> {
  fontConfig?: FontConfig[];
  langFontConfig?: FontConfig[];
  encryption?: PdfEncryptionOptions;
  metadata?: PdfMetadataOptions;
  form: NormalizedFormOptions;
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

const DEFAULT_FORM_INCLUDE: readonly FormInclude[] = [
  'text',
  'textarea',
  'select',
  'checkbox',
  'radio',
  'date-time',
  'range',
  'color',
  'file',
  'progress',
  'meter',
];

function normalizeFormInclude(value: string): FormInclude | null {
  switch (value) {
    case 'text':
    case 'textarea':
    case 'select':
    case 'checkbox':
    case 'radio':
    case 'date-time':
    case 'range':
    case 'color':
    case 'file':
    case 'progress':
    case 'meter':
      return value;
    default:
      return null;
  }
}

function normalizeFormOptions(form: boolean | FormOptions | undefined): NormalizedFormOptions {
  if (form == null || form === false || form === true) {
    const include = [...DEFAULT_FORM_INCLUDE];
    return {
      mode: 'static',
      include,
      includeSet: new Set(include),
    };
  }
  const mode: FormMode = form.mode === 'interactive' || form.mode === 'hybrid' ? form.mode : 'static';
  const include = (form.include ?? DEFAULT_FORM_INCLUDE)
    .map((entry) => normalizeFormInclude(entry))
    .filter((entry): entry is FormInclude => entry !== null);
  const normalizedInclude = include.length > 0 ? include : [...DEFAULT_FORM_INCLUDE];
  return {
    mode,
    include: normalizedInclude,
    includeSet: new Set(normalizedInclude),
  };
}

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

/**
 * Normalize PDF metadata options. Non-string fields are ignored; a keyword
 * array is joined with spaces (PDF convention). Returns undefined when no
 * field is set, so an empty metadata object emits no Info dictionary.
 */
export function normalizeMetadataOptions(
  metadata?: PdfMetadataOptions,
): NormalizedPdfMetadata | undefined {
  if (!metadata) return undefined;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const keywords = Array.isArray(metadata.keywords)
    ? metadata.keywords.filter((k): k is string => typeof k === 'string').join(' ')
    : str(metadata.keywords);
  const normalized: NormalizedPdfMetadata = {
    title: str(metadata.title),
    author: str(metadata.author),
    subject: str(metadata.subject),
    keywords,
    creator: str(metadata.creator),
    producer: str(metadata.producer),
    creationDate: '',
    modDate: '',
  };
  const hasAny = normalized.title !== ''
    || normalized.author !== ''
    || normalized.subject !== ''
    || normalized.keywords !== ''
    || normalized.creator !== ''
    || normalized.producer !== '';
  return hasAny ? normalized : undefined;
}

/** Format a Date as a PDF date string: D:YYYYMMDDHHmmSS+HH'mm' (local zone). */
function pdfDateString(d: Date): string {
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const base = `D:${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const offsetMinutes = d.getTimezoneOffset();
  if (offsetMinutes === 0) return `${base}Z`;
  const sign = offsetMinutes < 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${base}${sign}${p2(Math.floor(abs / 60))}'${p2(abs % 60)}'`;
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

interface CollectedFormFieldOption {
  label: string;
  value: string;
  selected: boolean;
}

interface CollectedFormField {
  id: number;
  nodeId: number;
  kind: number;
  interactiveKind: number;
  name: string;
  value: string;
  defaultValue: string;
  placeholder: string;
  checked: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  multiple: boolean;
  placeholderShown: boolean;
  password: boolean;
  textAlign: number;
  padding: [number, number, number, number];
  options: CollectedFormFieldOption[];
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
    decorationLineMask: number;
    decorationThicknessPx: number;
  };
  imageId?: number;
  objectFit?: number; // 0 fill, 1 contain, 2 cover, 3 none, 4 scale-down
  objectPositionXPct?: number; // 0 = left, 0.5 = center, 1 = right
  objectPositionXOffsetPx?: number;
  objectPositionYPct?: number; // 0 = top, 0.5 = center, 1 = bottom
  objectPositionYOffsetPx?: number;
  renderMode: number;
  divisionDisable: boolean;
  pageBreak: boolean;
  href?: string;
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
const F_LINK = 0x800;
const F_AVOID_IMAGE_SPLIT = 0x1000;

const FORM_FIELD_KIND_TEXT = 1;
const FORM_FIELD_KIND_TEXTAREA = 2;
const FORM_FIELD_KIND_SELECT = 3;
const FORM_FIELD_KIND_CHECKBOX = 4;
const FORM_FIELD_KIND_RADIO = 5;
const FORM_FIELD_KIND_DATE_TIME = 6;
const FORM_FIELD_KIND_RANGE = 7;
const FORM_FIELD_KIND_COLOR = 8;
const FORM_FIELD_KIND_FILE = 9;
const FORM_FIELD_KIND_PROGRESS = 10;
const FORM_FIELD_KIND_METER = 11;

const FORM_INTERACTIVE_NONE = 0;
const FORM_INTERACTIVE_TEXT = 1;
const FORM_INTERACTIVE_CHOICE = 2;
const FORM_INTERACTIVE_CHECKBOX = 3;
const FORM_INTERACTIVE_RADIO = 4;

const FORM_FLAG_CHECKED = 0x01;
const FORM_FLAG_DISABLED = 0x02;
const FORM_FLAG_READONLY = 0x04;
const FORM_FLAG_REQUIRED = 0x08;
const FORM_FLAG_MULTIPLE = 0x10;
const FORM_FLAG_PLACEHOLDER_SHOWN = 0x20;
const FORM_FLAG_PASSWORD = 0x40;

interface FormControlAnalysis {
  kind: number;
  interactiveKind: number;
  name: string;
  value: string;
  defaultValue: string;
  placeholder: string;
  checked: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  multiple: boolean;
  placeholderShown: boolean;
  password: boolean;
  textAlign: number;
  padding: [number, number, number, number];
  options: CollectedFormFieldOption[];
  hiddenText: string;
}

function normalizeInputType(type: string | null | undefined): string {
  return (type || 'text').trim().toLowerCase() || 'text';
}

function isDateTimeInputType(type: string): boolean {
  return type === 'date'
    || type === 'time'
    || type === 'month'
    || type === 'week'
    || type === 'datetime-local';
}

function formIncludeForInputType(type: string): FormInclude | null {
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (isDateTimeInputType(type)) return 'date-time';
  if (type === 'range') return 'range';
  if (type === 'color') return 'color';
  if (type === 'file') return 'file';
  return 'text';
}

function shouldEmitStaticFormVisual(
  form: NormalizedFormOptions,
  interactiveKind: number,
): boolean {
  return form.mode !== 'interactive' || interactiveKind === FORM_INTERACTIVE_NONE;
}

function shouldEmitInteractiveFormField(
  form: NormalizedFormOptions,
  interactiveKind: number,
): boolean {
  return form.mode !== 'static' && interactiveKind !== FORM_INTERACTIVE_NONE;
}

function isTextualFormKind(kind: number): boolean {
  return kind === FORM_FIELD_KIND_TEXT
    || kind === FORM_FIELD_KIND_TEXTAREA
    || kind === FORM_FIELD_KIND_SELECT
    || kind === FORM_FIELD_KIND_DATE_TIME;
}

function shouldRasterizeStaticFormControl(kind: number): boolean {
  return kind === FORM_FIELD_KIND_CHECKBOX
    || kind === FORM_FIELD_KIND_RADIO
    || kind === FORM_FIELD_KIND_RANGE
    || kind === FORM_FIELD_KIND_COLOR
    || kind === FORM_FIELD_KIND_FILE
    || kind === FORM_FIELD_KIND_PROGRESS
    || kind === FORM_FIELD_KIND_METER;
}

function shouldSuppressBaseNodeForInteractiveField(kind: number): boolean {
  return kind === FORM_FIELD_KIND_CHECKBOX || kind === FORM_FIELD_KIND_RADIO;
}

function collectSelectOptions(select: HTMLSelectElement): CollectedFormFieldOption[] {
  return Array.from(select.options).map((option) => ({
    label: option.text,
    value: option.value,
    selected: option.selected,
  }));
}

function analyzeFormControl(
  el: HTMLElement,
  cs: CSSStyleDeclaration,
  form: NormalizedFormOptions,
): FormControlAnalysis | null {
  // Type gate first: callers invoke this on every full-raster element (SVG,
  // canvas, ...), so non-control elements must bail before any style parsing.
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)
    && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLProgressElement)
    && !(el instanceof HTMLMeterElement)) {
    return null;
  }
  const textAlign = alignNum(cs.textAlign);
  const padding: [number, number, number, number] = [
    parseFloat(cs.paddingTop) || 0,
    parseFloat(cs.paddingRight) || 0,
    parseFloat(cs.paddingBottom) || 0,
    parseFloat(cs.paddingLeft) || 0,
  ];
  if (el instanceof HTMLInputElement) {
    const type = normalizeInputType(el.type);
    const include = formIncludeForInputType(type);
    if (!include || !form.includeSet.has(include)) return null;
    if (type === 'checkbox') {
      return {
        kind: FORM_FIELD_KIND_CHECKBOX,
        interactiveKind: FORM_INTERACTIVE_CHECKBOX,
        name: el.name || '',
        value: el.checked ? 'Yes' : 'Off',
        defaultValue: el.defaultChecked ? 'Yes' : 'Off',
        placeholder: '',
        checked: el.checked,
        disabled: el.disabled,
        readonly: false,
        required: el.required,
        multiple: false,
        placeholderShown: false,
        password: false,
        textAlign,
        padding,
        options: [],
        hiddenText: '',
      };
    }
    if (type === 'radio') {
      return {
        kind: FORM_FIELD_KIND_RADIO,
        interactiveKind: FORM_INTERACTIVE_RADIO,
        name: el.name || '',
        value: el.value || `radio-${el.id || 'option'}`,
        defaultValue: el.defaultChecked ? (el.value || `radio-${el.id || 'option'}`) : '',
        placeholder: '',
        checked: el.checked,
        disabled: el.disabled,
        readonly: false,
        required: el.required,
        multiple: false,
        placeholderShown: false,
        password: false,
        textAlign,
        padding,
        options: [],
        hiddenText: '',
      };
    }
    if (type === 'range') {
      return {
        kind: FORM_FIELD_KIND_RANGE,
        interactiveKind: FORM_INTERACTIVE_NONE,
        name: el.name || '',
        value: el.value,
        defaultValue: el.defaultValue,
        placeholder: '',
        checked: false,
        disabled: el.disabled,
        readonly: false,
        required: el.required,
        multiple: false,
        placeholderShown: false,
        password: false,
        textAlign,
        padding,
        options: [],
        hiddenText: el.value,
      };
    }
    if (type === 'color') {
      return {
        kind: FORM_FIELD_KIND_COLOR,
        interactiveKind: FORM_INTERACTIVE_NONE,
        name: el.name || '',
        value: el.value,
        defaultValue: el.defaultValue,
        placeholder: '',
        checked: false,
        disabled: el.disabled,
        readonly: false,
        required: el.required,
        multiple: false,
        placeholderShown: false,
        password: false,
        textAlign,
        padding,
        options: [],
        hiddenText: el.value,
      };
    }
    if (type === 'file') {
      const fileNames = el.files ? Array.from(el.files).map((file) => file.name) : [];
      return {
        kind: FORM_FIELD_KIND_FILE,
        interactiveKind: FORM_INTERACTIVE_NONE,
        name: el.name || '',
        value: fileNames.join('\n'),
        defaultValue: '',
        placeholder: '',
        checked: false,
        disabled: el.disabled,
        readonly: false,
        required: el.required,
        multiple: el.multiple,
        placeholderShown: false,
        password: false,
        textAlign,
        padding,
        options: [],
        hiddenText: fileNames.join('\n'),
      };
    }
    const placeholder = el.placeholder || '';
    const value = el.value || '';
    const placeholderShown = value.length === 0 && placeholder.length > 0;
    const password = type === 'password';
    return {
      kind: isDateTimeInputType(type) ? FORM_FIELD_KIND_DATE_TIME : FORM_FIELD_KIND_TEXT,
      interactiveKind: FORM_INTERACTIVE_TEXT,
      name: el.name || '',
      value,
      defaultValue: el.defaultValue,
      placeholder,
      checked: false,
      disabled: el.disabled,
      readonly: el.readOnly,
      required: el.required,
      multiple: false,
      placeholderShown,
      password,
      textAlign,
      padding,
      options: [],
      hiddenText: placeholderShown
        ? placeholder
        : password
          ? '•'.repeat(Array.from(value).length)
          : value,
    };
  }
  if (el instanceof HTMLTextAreaElement) {
    if (!form.includeSet.has('textarea')) return null;
    const placeholder = el.placeholder || '';
    const value = el.value || '';
    const placeholderShown = value.length === 0 && placeholder.length > 0;
    return {
      kind: FORM_FIELD_KIND_TEXTAREA,
      interactiveKind: FORM_INTERACTIVE_TEXT,
      name: el.name || '',
      value,
      defaultValue: el.defaultValue,
      placeholder,
      checked: false,
      disabled: el.disabled,
      readonly: el.readOnly,
      required: el.required,
      multiple: true,
      placeholderShown,
      password: false,
      textAlign,
      padding,
      options: [],
      hiddenText: placeholderShown ? placeholder : value,
    };
  }
  if (el instanceof HTMLSelectElement) {
    if (!form.includeSet.has('select')) return null;
    const options = collectSelectOptions(el);
    const selectedOptions = options.filter((option) => option.selected);
    return {
      kind: FORM_FIELD_KIND_SELECT,
      interactiveKind: FORM_INTERACTIVE_CHOICE,
      name: el.name || '',
      value: selectedOptions.map((option) => option.value).join('\n'),
      defaultValue: Array.from(el.options).filter((option) => option.defaultSelected).map((option) => option.value).join('\n'),
      placeholder: '',
      checked: false,
      disabled: el.disabled,
      readonly: false,
      required: el.required,
      multiple: el.multiple,
      placeholderShown: false,
      password: false,
      textAlign,
      padding,
      options,
      hiddenText: selectedOptions.map((option) => option.label).join('\n'),
    };
  }
  if (el instanceof HTMLProgressElement) {
    if (!form.includeSet.has('progress')) return null;
    return {
      kind: FORM_FIELD_KIND_PROGRESS,
      interactiveKind: FORM_INTERACTIVE_NONE,
      name: el.getAttribute('name') || '',
      value: String(el.value),
      defaultValue: String(el.value),
      placeholder: '',
      checked: false,
      disabled: false,
      readonly: true,
      required: false,
      multiple: false,
      placeholderShown: false,
      password: false,
      textAlign,
      padding,
      options: [],
      hiddenText: `${el.value}/${el.max || 1}`,
    };
  }
  if (el instanceof HTMLMeterElement) {
    if (!form.includeSet.has('meter')) return null;
    return {
      kind: FORM_FIELD_KIND_METER,
      interactiveKind: FORM_INTERACTIVE_NONE,
      name: el.getAttribute('name') || '',
      value: String(el.value),
      defaultValue: String(el.value),
      placeholder: '',
      checked: false,
      disabled: false,
      readonly: true,
      required: false,
      multiple: false,
      placeholderShown: false,
      password: false,
      textAlign,
      padding,
      options: [],
      hiddenText: `${el.value}`,
    };
  }
  return null;
}

function isHFSemanticPosition(value: unknown): value is HFSemanticPosition {
  return value === 'center'
    || value === 'centerLeft'
    || value === 'centerRight'
    || value === 'centerTop'
    || value === 'centerBottom'
    || value === 'leftTop'
    || value === 'leftBottom'
    || value === 'rightTop'
    || value === 'rightBottom';
}

function isHFCoordinatePosition(value: unknown): value is HFCoordinatePosition {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'x' in value
    && 'y' in value;
}

// header/footer position enum (must match Rust HFSpec.position / HFSlotCustomPosition.anchor)
function positionNum(p: HFSemanticPosition | ContentPosition | undefined): number {
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

function parseHFCoordinateValue(value: number | string | undefined): { pct: number; offsetPx: number } | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { pct: 0, offsetPx: value } : null;
  }
  if (typeof value !== 'string') return null;
  const compact = value.trim().toLowerCase().replace(/\s+/g, '');
  if (!compact) return null;
  const pctMatch = /^([+-]?\d+(?:\.\d+)?)%(?:(\+|-)(\d+(?:\.\d+)?)(?:px)?)?$/.exec(compact);
  if (pctMatch) {
    const pct = parseFloat(pctMatch[1]);
    const offset = pctMatch[2]
      ? (pctMatch[2] === '-' ? -1 : 1) * parseFloat(pctMatch[3])
      : 0;
    return Number.isFinite(pct) && Number.isFinite(offset)
      ? { pct: pct / 100, offsetPx: offset }
      : null;
  }
  const pxMatch = /^([+-]?\d+(?:\.\d+)?)(?:px)?$/.exec(compact);
  if (!pxMatch) return null;
  const offset = parseFloat(pxMatch[1]);
  return Number.isFinite(offset) ? { pct: 0, offsetPx: offset } : null;
}

// ---- color parsing via canvas ----
const colorCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const colorCtx = colorCanvas ? colorCanvas.getContext('2d')! : null;
const colorCache = new Map<string, [number, number, number, number]>();

function parseColor(str: string | null | undefined): [number, number, number, number] {
  if (!colorCtx) return [0, 0, 0, 1];
  if (!str) return [0, 0, 0, 0];
  const cached = colorCache.get(str);
  if (cached) return cached;
  let result: [number, number, number, number];
  // Fast path for #rrggbb / #rgb (avoids canvas round-trip).
  if (str.charCodeAt(0) === 35 /* '#' */) {
    const hex = str.slice(1);
    if (hex.length === 6) {
      result = [
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255,
        1,
      ];
    } else if (hex.length === 3) {
      result = [
        parseInt(hex[0] + hex[0], 16) / 255,
        parseInt(hex[1] + hex[1], 16) / 255,
        parseInt(hex[2] + hex[2], 16) / 255,
        1,
      ];
    } else {
      result = parseColorViaCanvas(str);
    }
  } else {
    result = parseColorViaCanvas(str);
  }
  colorCache.set(str, result);
  return result;
}

function parseColorViaCanvas(str: string): [number, number, number, number] {
  colorCtx!.fillStyle = '#000';
  colorCtx!.fillStyle = str;
  const f = colorCtx!.fillStyle;
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
  // CSS Color 4 values such as oklch()/lab()/color(display-p3 ...)
  // may survive in canvas.fillStyle as-is instead of normalizing to rgb(...).
  // Sample a painted pixel to force the browser to resolve them.
  try {
    colorCtx!.clearRect(0, 0, 1, 1);
    colorCtx!.fillRect(0, 0, 1, 1);
    const data = colorCtx!.getImageData(0, 0, 1, 1).data;
    return [data[0] / 255, data[1] / 255, data[2] / 255, data[3] / 255];
  } catch {
    // ignore and fall through
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

function textDecorationMask(cs: CSSStyleDeclaration): number {
  const value = ((cs.textDecorationLine || cs.textDecoration || '') + '').toLowerCase();
  let mask = 0;
  if (value.includes('underline')) mask |= 0x01;
  if (value.includes('line-through')) mask |= 0x02;
  if (value.includes('overline')) mask |= 0x04;
  return mask;
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

type ObjectPositionAxis = {
  pct: number;
  offsetPx: number;
};

function objectPositionAxisDefault(): ObjectPositionAxis {
  return { pct: 0.5, offsetPx: 0 };
}

type ParsedPositionToken =
  | { kind: 'pct'; value: number }
  | { kind: 'px'; value: number }
  | { kind: 'mixed'; pct: number; offsetPx: number };

function splitPositionTokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (start !== -1) {
        out.push(value.slice(start, i));
        start = -1;
      }
      continue;
    }
    if (start === -1) start = i;
  }
  if (start !== -1) out.push(value.slice(start));
  return out;
}

function parsePositionToken(token: string): ParsedPositionToken | null {
  const trimmed = (token || '').trim().toLowerCase();
  if (!trimmed) return null;
  const calcMatch = /^calc\(\s*(-?\d+(?:\.\d+)?)%\s*([+-])\s*(-?\d+(?:\.\d+)?)px\s*\)$/i.exec(trimmed);
  if (calcMatch) {
    const pct = parseFloat(calcMatch[1]);
    const px = parseFloat(calcMatch[3]);
    if (Number.isFinite(pct) && Number.isFinite(px)) {
      return {
        kind: 'mixed',
        pct: pct / 100,
        offsetPx: calcMatch[2] === '+' ? px : -px,
      };
    }
  }
  if (trimmed.endsWith('%')) {
    const n = parseFloat(trimmed.slice(0, -1));
    return Number.isFinite(n) ? { kind: 'pct', value: n / 100 } : null;
  }
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? { kind: 'px', value: n } : null;
}

function isXPositionKeyword(token: string): boolean {
  return token === 'left' || token === 'right' || token === 'center';
}

function isYPositionKeyword(token: string): boolean {
  return token === 'top' || token === 'bottom' || token === 'center';
}

function parseObjectPositionAxis(
  keywordToken: string | null,
  valueToken: string | null,
  axis: 'x' | 'y',
): ObjectPositionAxis | null {
  const keyword = (keywordToken || '').trim().toLowerCase();
  const parsedValue = valueToken ? parsePositionToken(valueToken) : null;
  const positiveEdge = axis === 'x' ? 'right' : 'bottom';
  const negativeEdge = axis === 'x' ? 'left' : 'top';

  if (!keyword) {
    if (!parsedValue) return null;
    if (parsedValue.kind === 'mixed') {
      return { pct: parsedValue.pct, offsetPx: parsedValue.offsetPx };
    }
    return parsedValue.kind === 'pct'
      ? { pct: parsedValue.value, offsetPx: 0 }
      : { pct: 0, offsetPx: parsedValue.value };
  }
  if (keyword === 'center') {
    if (!parsedValue) return { pct: 0.5, offsetPx: 0 };
    if (parsedValue.kind === 'mixed') {
      return { pct: 0.5 + parsedValue.pct, offsetPx: parsedValue.offsetPx };
    }
    return parsedValue.kind === 'pct'
      ? { pct: 0.5 + parsedValue.value, offsetPx: 0 }
      : { pct: 0.5, offsetPx: parsedValue.value };
  }
  if (keyword === negativeEdge) {
    if (!parsedValue) return { pct: 0, offsetPx: 0 };
    if (parsedValue.kind === 'mixed') {
      return { pct: parsedValue.pct, offsetPx: parsedValue.offsetPx };
    }
    return parsedValue.kind === 'pct'
      ? { pct: parsedValue.value, offsetPx: 0 }
      : { pct: 0, offsetPx: parsedValue.value };
  }
  if (keyword === positiveEdge) {
    if (!parsedValue) return { pct: 1, offsetPx: 0 };
    if (parsedValue.kind === 'mixed') {
      return { pct: 1 - parsedValue.pct, offsetPx: -parsedValue.offsetPx };
    }
    return parsedValue.kind === 'pct'
      ? { pct: 1 - parsedValue.value, offsetPx: 0 }
      : { pct: 1, offsetPx: -parsedValue.value };
  }
  return null;
}

function parseObjectPosition(value: string): { x: ObjectPositionAxis; y: ObjectPositionAxis } {
  const tokens = splitPositionTokens((value || '').trim().toLowerCase());
  const x = objectPositionAxisDefault();
  const y = objectPositionAxisDefault();
  if (tokens.length === 0) return { x, y };

  const applyAxis = (target: ObjectPositionAxis, next: ObjectPositionAxis | null): void => {
    if (!next) return;
    target.pct = next.pct;
    target.offsetPx = next.offsetPx;
  };

  if (tokens.length >= 4) {
    const firstKeyword = tokens[0];
    const secondKeyword = tokens[2];
    const firstValue = parsePositionToken(tokens[1]);
    const secondValue = parsePositionToken(tokens[3]);
    if (firstValue && secondValue) {
      if (firstKeyword !== 'center' && secondKeyword !== 'center') {
        if (isXPositionKeyword(firstKeyword) && isYPositionKeyword(secondKeyword)) {
          applyAxis(x, parseObjectPositionAxis(firstKeyword, tokens[1], 'x'));
          applyAxis(y, parseObjectPositionAxis(secondKeyword, tokens[3], 'y'));
          return { x, y };
        }
        if (isYPositionKeyword(firstKeyword) && isXPositionKeyword(secondKeyword)) {
          applyAxis(y, parseObjectPositionAxis(firstKeyword, tokens[1], 'y'));
          applyAxis(x, parseObjectPositionAxis(secondKeyword, tokens[3], 'x'));
          return { x, y };
        }
      }
    }
  }

  if (tokens.length === 1) {
    const token = tokens[0];
    if (token === 'top' || token === 'bottom') applyAxis(y, parseObjectPositionAxis(token, null, 'y'));
    else if (token === 'left' || token === 'right') applyAxis(x, parseObjectPositionAxis(token, null, 'x'));
    else if (token === 'center') {
      applyAxis(x, parseObjectPositionAxis(token, null, 'x'));
      applyAxis(y, parseObjectPositionAxis(token, null, 'y'));
    } else {
      applyAxis(x, parseObjectPositionAxis(null, token, 'x'));
    }
    return { x, y };
  }

  if (tokens.length === 2) {
    const [t0, t1] = tokens;
    if ((t0 === 'top' || t0 === 'bottom') && isXPositionKeyword(t1)) {
      applyAxis(y, parseObjectPositionAxis(t0, null, 'y'));
      applyAxis(x, parseObjectPositionAxis(t1, null, 'x'));
      return { x, y };
    }
    if ((t1 === 'top' || t1 === 'bottom') && isXPositionKeyword(t0)) {
      applyAxis(x, parseObjectPositionAxis(t0, null, 'x'));
      applyAxis(y, parseObjectPositionAxis(t1, null, 'y'));
      return { x, y };
    }
    if (t0 === 'top' || t0 === 'bottom') {
      applyAxis(y, parseObjectPositionAxis(t0, null, 'y'));
      applyAxis(x, parseObjectPositionAxis(null, t1, 'x'));
      return { x, y };
    }
    if (t1 === 'top' || t1 === 'bottom') {
      applyAxis(x, parseObjectPositionAxis(null, t0, 'x'));
      applyAxis(y, parseObjectPositionAxis(t1, null, 'y'));
      return { x, y };
    }
    applyAxis(x, parseObjectPositionAxis(t0, null, 'x') ?? parseObjectPositionAxis(null, t0, 'x'));
    applyAxis(y, parseObjectPositionAxis(t1, null, 'y') ?? parseObjectPositionAxis(null, t1, 'y'));
    return { x, y };
  }

  if (tokens.length === 3) {
    const [t0, t1, t2] = tokens;
    if ((t0 === 'left' || t0 === 'right') && parsePositionToken(t1) && isYPositionKeyword(t2)) {
      applyAxis(x, parseObjectPositionAxis(t0, t1, 'x'));
      applyAxis(y, parseObjectPositionAxis(t2, null, 'y'));
      return { x, y };
    }
    if ((t0 === 'top' || t0 === 'bottom') && parsePositionToken(t1) && isXPositionKeyword(t2)) {
      applyAxis(y, parseObjectPositionAxis(t0, t1, 'y'));
      applyAxis(x, parseObjectPositionAxis(t2, null, 'x'));
      return { x, y };
    }
    if (isXPositionKeyword(t0) && (t1 === 'top' || t1 === 'bottom') && parsePositionToken(t2)) {
      applyAxis(x, parseObjectPositionAxis(t0, null, 'x'));
      applyAxis(y, parseObjectPositionAxis(t1, t2, 'y'));
      return { x, y };
    }
    if (isYPositionKeyword(t0) && (t1 === 'left' || t1 === 'right') && parsePositionToken(t2)) {
      applyAxis(y, parseObjectPositionAxis(t0, null, 'y'));
      applyAxis(x, parseObjectPositionAxis(t1, t2, 'x'));
      return { x, y };
    }
  }

  applyAxis(x, parseObjectPositionAxis(tokens[0], null, 'x') ?? parseObjectPositionAxis(null, tokens[0], 'x'));
  if (tokens.length > 1) {
    applyAxis(y, parseObjectPositionAxis(tokens[1], null, 'y') ?? parseObjectPositionAxis(null, tokens[1], 'y'));
  }
  return { x, y };
}

function borderStyleNum(style: string): number {
  return style === 'dashed' ? BORDER_DASHED : BORDER_SOLID;
}

function clipsOverflow(cs: CSSStyleDeclaration): boolean {
  const check = (value: string): boolean => {
    const parts = (value || '').split(/\s+/);
    for (let i = 0; i < parts.length; i++) {
      const v = parts[i];
      if (v === 'hidden' || v === 'clip' || v === 'scroll' || v === 'auto') return true;
    }
    return false;
  };
  return check(cs.overflow) || check(cs.overflowX) || check(cs.overflowY);
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
    const naturalW = Math.max(1, Math.round(sourceImg.naturalWidth || img.naturalWidth || sourceImg.width || img.width || 0));
    const naturalH = Math.max(1, Math.round(sourceImg.naturalHeight || img.naturalHeight || sourceImg.height || img.height || 0));
    const cssW = Math.max(1, Math.round(rect.width || img.width || naturalW || 0));
    const cssH = Math.max(1, Math.round(rect.height || img.height || naturalH || 0));
    // Preserve the source image's intrinsic aspect ratio here; layout-driven
    // fitting like object-fit/object-position is applied later during PDF draw.
    const w = naturalW || cssW;
    const h = naturalH || cssH;
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

// Cached canvas used by measureTextWidth. Reused across calls to avoid
// allocating a new <canvas> per marker measurement.
let _measureCanvas: HTMLCanvasElement | null = null;

// Measure a text run's width in CSS pixels using the given CSS font shorthand
// (e.g. "700 16px Arial"). Falls back to 0 when Canvas2D is unavailable.
function measureTextWidth(text: string, fontShorthand: string): number {
  if (!text) return 0;
  if (!_measureCanvas) _measureCanvas = document.createElement('canvas');
  const ctx = _measureCanvas.getContext('2d');
  if (!ctx) return 0;
  ctx.font = fontShorthand;
  return ctx.measureText(text).width;
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

// Convert a 1-based index to alphabetic (a, b, ..., z, aa, ab, ...).
function decimalToAlpha(n: number, upper: boolean): string {
  if (n < 1) return String(n);
  let s = '';
  let v = n;
  while (v > 0) {
    v--;
    s = String.fromCharCode(97 + (v % 26)) + s;
    v = Math.floor(v / 26);
  }
  return upper ? s.toUpperCase() : s;
}

// Convert a 1-based index to Roman numerals (i, ii, iii, iv, ...).
function decimalToRoman(n: number, upper: boolean): string {
  if (n < 1) return String(n);
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let s = '';
  let v = n;
  for (const [val, sym] of table) {
    while (v >= val) {
      s += sym;
      v -= val;
    }
  }
  return upper ? s : s.toLowerCase();
}

// Resolve ::marker text. Priority: explicit `content` string > list-style-type.
// Returns null when the marker should not render (list-style-type: none or
// content: none). `index` is 1-based and only used for counter-based styles.
function markerTextFromListStyle(
  listStyleType: string,
  contentValue: string,
  index: number,
): string | null {
  // Explicit `content: "..."` wins over list-style-type.
  const quoted = cssQuotedContentToText(contentValue);
  if (quoted !== null) return quoted;
  const t = (listStyleType || 'disc').trim().toLowerCase();
  if (t === 'none') return null;
  switch (t) {
    case 'disc': return '\u2022';
    case 'circle': return '\u25E6';
    case 'square': return '\u25AA';
    case 'decimal': return `${index}.`;
    case 'decimal-leading-zero': return `${String(index).padStart(2, '0')}.`;
    case 'lower-alpha':
    case 'lower-latin': return `${decimalToAlpha(index, false)}.`;
    case 'upper-alpha':
    case 'upper-latin': return `${decimalToAlpha(index, true)}.`;
    case 'lower-roman': return `${decimalToRoman(index, false)}.`;
    case 'upper-roman': return `${decimalToRoman(index, true)}.`;
    default: return '\u2022';
  }
}

// Compute the 1-based index of an <li> among its sibling <li>s, honoring
// <ol start> and per-item <li value> overrides. Returns null when the element
// is not a direct child of an <ol>/<ul>.
function computeListItemIndex(li: HTMLElement): number | null {
  const parent = li.parentElement;
  if (!parent) return null;
  const tag = parent.tagName.toUpperCase();
  if (tag !== 'OL' && tag !== 'UL') return null;
  let idx = 1;
  if (tag === 'OL') {
    const startAttr = parent.getAttribute('start');
    if (startAttr !== null) {
      const s = parseInt(startAttr, 10);
      idx = isNaN(s) ? 1 : Math.max(1, s);
    }
  }
  for (let child = parent.firstElementChild; child; child = child.nextElementSibling) {
    if (child === li) return idx;
    if (child.tagName.toUpperCase() === 'LI') {
      const valueAttr = child.getAttribute('value');
      if (valueAttr !== null) {
        const v = parseInt(valueAttr, 10);
        if (!isNaN(v)) idx = v;
      }
      idx++;
    }
  }
  return null;
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

function pseudoNeedsForegroundRaster(cs: CSSStyleDeclaration): boolean {
  const pseudoText = cssQuotedContentToText(cs.content);
  return !!pseudoText && pseudoText.trim().length > 0;
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

function colorToCssRgb(color: [number, number, number, number]): string {
  return `rgb(${Math.round(color[0] * 255)}, ${Math.round(color[1] * 255)}, ${Math.round(color[2] * 255)})`;
}

function hasComplexBackdropVisual(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (hasComplexBackground(cs)) return true;
  const before = getComputedStyle(el, '::before');
  const after = getComputedStyle(el, '::after');
  return pseudoHasVisual(before) || pseudoHasVisual(after);
}

function sampleRawRgbRegion(
  bytes: Uint8Array,
  width: number,
  height: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): [number, number, number, number] | null {
  const x0 = Math.max(0, Math.min(width, Math.round(rx)));
  const y0 = Math.max(0, Math.min(height, Math.round(ry)));
  const x1 = Math.max(0, Math.min(width, Math.round(rx + rw)));
  const y1 = Math.max(0, Math.min(height, Math.round(ry + rh)));
  if (x1 <= x0 || y1 <= y0) return null;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 8));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 8));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const idx = (y * width + x) * 3;
      rs.push(bytes[idx]);
      gs.push(bytes[idx + 1]);
      bs.push(bytes[idx + 2]);
    }
  }
  if (rs.length === 0) return null;
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = rs.length >> 1;
  const pick = (arr: number[]) => (arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2);
  return [pick(rs) / 255, pick(gs) / 255, pick(bs) / 255, 1];
}

function cropRawRgbToDataUrl(
  bytes: Uint8Array,
  width: number,
  height: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): string | null {
  const x0 = Math.max(0, Math.min(width, Math.round(rx)));
  const y0 = Math.max(0, Math.min(height, Math.round(ry)));
  const x1 = Math.max(0, Math.min(width, Math.round(rx + rw)));
  const y1 = Math.max(0, Math.min(height, Math.round(ry + rh)));
  const outW = x1 - x0;
  const outH = y1 - y0;
  if (outW <= 0 || outH <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(outW, outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const srcIdx = ((y + y0) * width + (x + x0)) * 3;
      const dstIdx = (y * outW + x) * 4;
      imageData.data[dstIdx] = bytes[srcIdx];
      imageData.data[dstIdx + 1] = bytes[srcIdx + 1];
      imageData.data[dstIdx + 2] = bytes[srcIdx + 2];
      imageData.data[dstIdx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
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

// --- ::marker pseudo-element support ---
//
// list-item markers (bullets, numbers) are generated by the browser's layout
// engine as ::marker pseudo-elements. They are not part of the DOM and cannot
// be captured by cloneNode or CSS property inspection. We synthesize a span
// carrying the marker text + ::marker computed styles so it can be baked into
// the raster (full-raster or background-raster) alongside the element's content.

function listItemIndex(el: HTMLElement): number {
  const explicit = parseInt(el.getAttribute('value') || '', 10);
  if (!Number.isNaN(explicit)) return explicit;
  const parent = el.parentElement;
  const startAttr = parent?.tagName.toUpperCase() === 'OL'
    ? parseInt(parent.getAttribute('start') || '1', 10)
    : 1;
  let count = 0;
  for (let sib = parent?.firstElementChild; sib; sib = sib.nextElementSibling) {
    if (sib === el) return startAttr + count;
    if (sib.tagName.toUpperCase() === 'LI') {
      const v = parseInt((sib as HTMLElement).getAttribute('value') || '', 10);
      count = Number.isNaN(v) ? count + 1 : v;
    }
  }
  return startAttr;
}

function toAlpha(n: number): string {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(97 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
    [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
    [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'],
    [1, 'I'],
  ];
  let s = '';
  for (const [v, sym] of table) {
    while (n >= v) { s += sym; n -= v; }
  }
  return s;
}

function markerTextForListItem(el: HTMLElement, cs: CSSStyleDeclaration): string {
  const type = (cs.listStyleType || '').trim();
  if (!type || type === 'none') return '';
  // Explicit content on ::marker takes precedence
  let markerContent = '';
  try {
    markerContent = getComputedStyle(el, '::marker').content || '';
  } catch {
    markerContent = '';
  }
  const explicit = cssQuotedContentToText(markerContent);
  if (explicit) return explicit;
  // String list-style-type (e.g. list-style-type: "-")
  if (type.startsWith('"') || type.startsWith("'")) {
    const asString = cssQuotedContentToText(type);
    if (asString) return asString;
  }
  switch (type) {
    case 'disc': return '\u2022';
    case 'circle': return '\u25CB';
    case 'square': return '\u25AA';
    case 'disclosure-open': return '\u25BE';
    case 'disclosure-closed': return '\u25B8';
    case 'decimal': return `${listItemIndex(el)}.`;
    case 'decimal-leading-zero': return `${String(listItemIndex(el)).padStart(2, '0')}.`;
    case 'lower-alpha':
    case 'lower-latin': return `${toAlpha(listItemIndex(el))}.`;
    case 'upper-alpha':
    case 'upper-latin': return `${toAlpha(listItemIndex(el)).toUpperCase()}.`;
    case 'lower-roman': return `${toRoman(listItemIndex(el)).toLowerCase()}.`;
    case 'upper-roman': return `${toRoman(listItemIndex(el))}.`;
    default: return '\u2022';
  }
}

function buildMarkerClone(owner: HTMLElement): HTMLElement | null {
  const cs = getComputedStyle(owner);
  if (cs.display !== 'list-item') return null;
  const type = (cs.listStyleType || '').trim();
  if (!type || type === 'none') return null;
  const img = (cs.listStyleImage || '').trim();
  if (img && img !== 'none') return null; // image marker - can't clone as text
  const text = markerTextForListItem(owner, cs);
  if (!text) return null;
  // ::marker pseudo-element may not be supported in all environments. Fall back
  // to the element's own computed style (color, font, etc. are inherited).
  let markerCs: CSSStyleDeclaration;
  try {
    markerCs = getComputedStyle(owner, '::marker');
  } catch {
    markerCs = cs;
  }
  const span = document.createElement('span');
  span.setAttribute('data-dom2pdf-pseudo', '::marker');
  copyComputedStyles(span, markerCs);
  // Ensure the span renders as inline content, not as a marker box
  span.style.display = 'inline';
  span.textContent = text;
  return span;
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

  const marker = buildMarkerClone(src);
  if (marker) {
    // Suppress the browser's auto-generated marker so only our clone renders.
    clone.style.listStyleType = 'none';
    clone.appendChild(marker);
  }

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

// Clone only an element's own background layer: its computed styles + decorative
// pseudos, with NO real children/text and NO box-shadow. Used to bake a backdrop
// image that sits under the element's still-vector text. box-shadow is dropped
// because the box node paints it vectorially (avoids double shadow). Purely
// decorative ::after overlays (no text content) can also be baked here to avoid
// unnecessary full-raster fallback for gradient cards / highlight sheens.
function cloneElementBackgroundOnly(src: HTMLElement): HTMLElement {
  const clone = src.cloneNode(false) as HTMLElement;
  copyComputedStyles(clone, getComputedStyle(src));
  clone.style.boxShadow = 'none';
  const marker = buildMarkerClone(src);
  if (marker) {
    clone.style.listStyleType = 'none';
    clone.appendChild(marker);
  }
  const before = buildPseudoClone(src, '::before');
  if (before) clone.appendChild(before);
  const afterComputed = getComputedStyle(src, '::after');
  if (pseudoHasVisual(afterComputed) && !pseudoNeedsForegroundRaster(afterComputed)) {
    const after = buildPseudoClone(src, '::after');
    if (after) clone.appendChild(after);
  }
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
  backdropCss?: string,
  backdropImageUrl?: string,
): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  wrapper.style.width = `${captureWidth}px`;
  wrapper.style.height = `${captureHeight}px`;
  wrapper.style.overflow = 'hidden';
  wrapper.style.background = backdropCss || findOpaqueBackdropColor(el);
  if (backdropImageUrl) {
    wrapper.style.backgroundImage = `url("${backdropImageUrl}")`;
    wrapper.style.backgroundSize = '100% 100%';
    wrapper.style.backgroundRepeat = 'no-repeat';
    wrapper.style.backgroundPosition = '0 0';
  }

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

async function resolveBackdropImage(el: HTMLElement, rawRect: DOMRect): Promise<string | null> {
  const stats = getDebugPerfState().snapshot;
  const startedAt = performance.now();
  let scanned = 0;
  try {
    for (let cur: HTMLElement | null = el.parentElement; cur; cur = cur.parentElement) {
      scanned += 1;
      if (!hasComplexBackdropVisual(cur)) continue;
      const ancestorRect = cur.getBoundingClientRect();
      if (ancestorRect.width <= 0 || ancestorRect.height <= 0) continue;
      const raster = await getCachedBackdropRaster(cur, findOpaqueBackdropColor(cur));
      if (!raster) continue;
      const scaleX = raster.width / Math.max(1, Math.ceil(ancestorRect.width));
      const scaleY = raster.height / Math.max(1, Math.ceil(ancestorRect.height));
      const relX = Math.max(0, rawRect.left - ancestorRect.left);
      const relY = Math.max(0, rawRect.top - ancestorRect.top);
      const dataUrl = cropRawRgbToDataUrl(
        raster.bytes,
        raster.width,
        raster.height,
        relX * scaleX,
        relY * scaleY,
        Math.max(1, rawRect.width * scaleX),
        Math.max(1, rawRect.height * scaleY),
      );
      if (dataUrl) return dataUrl;
    }
    return null;
  } finally {
    stats.resolveBackdropImageCalls += 1;
    stats.resolveBackdropImageMs += performance.now() - startedAt;
    stats.resolveBackdropAncestorScans += scanned;
  }
}

async function getCachedBackdropRaster(
  el: HTMLElement,
  backdropCss?: string,
): Promise<RasterRgbResult> {
  const state = getDebugPerfState();
  const cached = state.backdropRasterCache.get(el);
  if (cached) {
    state.snapshot.rasterBgCacheHits += 1;
    return cached;
  }
  state.snapshot.rasterBgCacheMisses += 1;
  const rect = el.getBoundingClientRect();
  const promise = rect.width <= 0 || rect.height <= 0
    ? Promise.resolve(null)
    : rasterizeElementBackgroundOnly(el, rect, backdropCss, false);
  state.backdropRasterCache.set(el, promise);
  return promise;
}

async function resolveBackdropColor(
  el: HTMLElement,
  rawRect: DOMRect,
): Promise<[number, number, number, number]> {
  const stats = getDebugPerfState().snapshot;
  const startedAt = performance.now();
  let scanned = 0;
  try {
    for (let cur: HTMLElement | null = el.parentElement; cur; cur = cur.parentElement) {
      scanned += 1;
      if (!hasComplexBackdropVisual(cur)) continue;
      const ancestorRect = cur.getBoundingClientRect();
      if (ancestorRect.width <= 0 || ancestorRect.height <= 0) continue;
      const raster = await getCachedBackdropRaster(cur, findOpaqueBackdropColor(cur));
      if (!raster) continue;
      const scaleX = raster.width / Math.max(1, Math.ceil(ancestorRect.width));
      const scaleY = raster.height / Math.max(1, Math.ceil(ancestorRect.height));
      const relX = Math.max(0, rawRect.left - ancestorRect.left);
      const relY = Math.max(0, rawRect.top - ancestorRect.top);
      const inset = 0.25;
      const sample = sampleRawRgbRegion(
        raster.bytes,
        raster.width,
        raster.height,
        (relX + rawRect.width * inset) * scaleX,
        (relY + rawRect.height * inset) * scaleY,
        Math.max(1, rawRect.width * (1 - inset * 2) * scaleX),
        Math.max(1, rawRect.height * (1 - inset * 2) * scaleY),
      );
      if (sample) return sample;
    }
    return parseColor(findOpaqueBackdropColor(el));
  } finally {
    stats.resolveBackdropColorCalls += 1;
    stats.resolveBackdropColorMs += performance.now() - startedAt;
    stats.resolveBackdropAncestorScans += scanned;
  }
}

async function rasterizeElement(
  el: HTMLElement,
  rawRect: DOMRect,
  _quality: number,
  cs: CSSStyleDeclaration,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: number; cssWidth: number; cssHeight: number; rawLeft: number; rawTop: number } | null> {
  const stats = getDebugPerfState().snapshot;
  const startedAt = performance.now();
  try {
    const shadowPad = computeBoxShadowPadding(cs.boxShadow);
    const captureWidth = Math.max(1, Math.ceil(rawRect.width + shadowPad.left + shadowPad.right));
    const captureHeight = Math.max(1, Math.ceil(rawRect.height + shadowPad.top + shadowPad.bottom));
    const backdropFilter = (cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter') || '').trim();
    const bg = parseColor(cs.backgroundColor);
    const needsBackdropColorSample = bg[3] > 0.001 && bg[3] < 1;
    const backdropCss = needsBackdropColorSample
      ? colorToCssRgb(await resolveBackdropColor(el, rawRect))
      : findOpaqueBackdropColor(el);
    const backdropImageUrl = backdropFilter && backdropFilter !== 'none'
      ? await resolveBackdropImage(el, rawRect)
      : null;
    const wrapper = buildRasterWrapper(el, rawRect, shadowPad, captureWidth, captureHeight, false, backdropCss, backdropImageUrl ?? undefined);
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
  } finally {
    stats.rasterFullCalls += 1;
    stats.rasterFullMs += performance.now() - startedAt;
  }
}

// Background-only raster: bakes just the element's own background + ::before
// decoration (no real text/children, no box-shadow) so text stays vector. The
// backdrop node uses objectFit:0, so pixel count is decoupled from layout size —
// no cssWidth round-trip needed.
async function rasterizeElementBackgroundOnly(
  el: HTMLElement,
  rawRect: DOMRect,
  backdropCss?: string,
  allowBackdropSampling = true,
): Promise<{ bytes: Uint8Array; width: number; height: number; format: number } | null> {
  const stats = getDebugPerfState().snapshot;
  const startedAt = performance.now();
  stats.rasterBgCalls += 1;
  stats.rasterBgDepth += 1;
  stats.rasterBgMaxDepth = Math.max(stats.rasterBgMaxDepth, stats.rasterBgDepth);
  try {
    // No shadow padding: box-shadow is painted vectorially by the box node.
    const captureWidth = Math.max(1, Math.ceil(rawRect.width));
    const captureHeight = Math.max(1, Math.ceil(rawRect.height));
    const noPad: EdgePadding = { top: 0, right: 0, bottom: 0, left: 0 };
    const resolvedBackdrop = backdropCss
      || (allowBackdropSampling
        ? colorToCssRgb(await resolveBackdropColor(el, rawRect))
        : findOpaqueBackdropColor(el));
    const backdropImageUrl = allowBackdropSampling
      ? await resolveBackdropImage(el, rawRect)
      : null;
    const wrapper = buildRasterWrapper(el, rawRect, noPad, captureWidth, captureHeight, true, resolvedBackdrop, backdropImageUrl ?? undefined);
    return await rasterizeWrapper(wrapper, captureWidth, captureHeight);
  } catch {
    return null;
  } finally {
    stats.rasterBgDepth -= 1;
    stats.rasterBgMs += performance.now() - startedAt;
  }
}

// Inline <svg> elements live in the SVG namespace, so their `tagName` keeps its
// original case ("svg") instead of being upper-cased like HTML tags. Compare
// case-insensitively or these icons silently skip rasterization and vanish.
//
// Native form controls (checkbox, radio) are replaced elements whose visual
// appearance (checkmark, fill state, native border) comes from the browser's
// widget rendering, not from CSS. They must be baked to an image so the PDF
// shows what the browser shows. appearance:none means the author replaced the
// native widget with custom CSS, so treat it as an ordinary element.
function isRasterTag(el: HTMLElement, cs: CSSStyleDeclaration): boolean {
  const tag = el.tagName.toUpperCase();
  if (tag === 'SVG' || tag === 'CANVAS') return true;
  if (tag === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      const appearance = (cs.appearance || cs.webkitAppearance || '').trim();
      return appearance !== 'none';
    }
  }
  return false;
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
  if (isRasterTag(el, cs)) return 'full-raster';
  const backdropFilter = (cs.getPropertyValue('backdrop-filter') || cs.getPropertyValue('-webkit-backdrop-filter') || '').trim();
  if (backdropFilter && backdropFilter !== 'none') return 'full-raster';
  if (el.tagName === 'CODE') {
    const bg = parseColor(cs.backgroundColor);
    const hasRadius = (parseFloat(cs.borderTopLeftRadius) || 0)
      + (parseFloat(cs.borderTopRightRadius) || 0)
      + (parseFloat(cs.borderBottomRightRadius) || 0)
      + (parseFloat(cs.borderBottomLeftRadius) || 0);
    if (bg[3] > 0.001 || hasRadius > 0) {
      // Inline code chips are tiny and visually sensitive to exact browser
      // painting (background fill, corner clipping, font AA). Rasterizing the
      // chip preserves that appearance while hidden text fallback keeps them
      // extractable in the PDF text layer.
      return 'full-raster';
    }
  }
  const clipsText = cs.backgroundImage !== 'none'
    && ((cs.backgroundClip || '').trim() === 'text'
      || (cs.webkitBackgroundClip || '').trim() === 'text');
  const transparentTextFill = (cs.webkitTextFillColor || '').trim() === 'rgba(0, 0, 0, 0)'
    || (cs.getPropertyValue('-webkit-text-fill-color') || '').trim() === 'rgba(0, 0, 0, 0)';
  if (clipsText || transparentTextFill) return 'full-raster';
  // Non-translate transforms skew/scale/rotate the text — must check before the
  // background branch so e.g. "rotate + gradient" doesn't try to keep text vector.
  if (!transformIsPureTranslate(cs)) return 'full-raster';
  const afterPseudo = getComputedStyle(el, '::after');
  // Textual ::after content must stay in the foreground paint order, so keep the
  // old full-raster fallback for those cases. Decorative overlays can be baked
  // into the backdrop image while real text remains vector.
  if (pseudoHasVisual(afterPseudo) && pseudoNeedsForegroundRaster(afterPseudo)) return 'full-raster';
  const beforeVisual = pseudoHasVisual(getComputedStyle(el, '::before'));
  if (beforeVisual || hasComplexBackground(cs)) return 'background-raster';
  return 'vector';
}

function collectFullRasterExtractableText(root: HTMLElement): string {
  const parts: string[] = [];

  const append = (value: string | null | undefined) => {
    if (!value) return;
    parts.push(value);
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      append((node as Text).data);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    append(cssQuotedContentToText(getComputedStyle(el, '::before').content));
    for (let child = el.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
    append(cssQuotedContentToText(getComputedStyle(el, '::after').content));
  };

  walk(root);
  return parts
    .join('')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t\f\r]+/g, ' ')
    .trim();
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

  const rgb = new Uint8Array(w * h * 3);
  const base = blendOver([1, 1, 1, 1], fallbackBg ?? [1, 1, 1, 1]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      let out = base;
      for (let i = layers.length - 1; i >= 0; i--) {
        out = blendOver(out, sampleGradientLayer(layers[i], x, y));
      }
      rgb[idx] = Math.round(out[0] * 255);
      rgb[idx + 1] = Math.round(out[1] * 255);
      rgb[idx + 2] = Math.round(out[2] * 255);
    }
  }
  return { bytes: rgb, width: w, height: h, format: IMG_RAW_RGB };

}

interface ResolvedHFSlotCustomPosition {
  xPct: number;
  xOffsetPx: number;
  yPct: number;
  yOffsetPx: number;
  anchor: number;
}

interface ResolvedHFSlot {
  content: string;
  color: [number, number, number, number];
  fontFamily: string;
  fontSizePx: number;
  fontWeight: number;
  italic: number;
  position: number;
  custom: [number, number] | null;
  customPosition: ResolvedHFSlotCustomPosition | null;
}

interface ResolvedHF {
  heightPx: number;
  padding: [number, number, number, number];
  slots: ResolvedHFSlot[];
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

function resolveHFSlotPosition(
  position: HFSemanticPosition | HFCoordinatePosition | ContentPosition | undefined,
): Pick<ResolvedHFSlot, 'position' | 'custom' | 'customPosition'> {
  if (Array.isArray(position)) {
    return {
      position: 9,
      custom: position,
      customPosition: null,
    };
  }
  if (isHFCoordinatePosition(position)) {
    const x = parseHFCoordinateValue(position.x) ?? { pct: 0, offsetPx: 0 };
    const y = parseHFCoordinateValue(position.y) ?? { pct: 0, offsetPx: 0 };
    return {
      position: 10,
      custom: null,
      customPosition: {
        xPct: x.pct,
        xOffsetPx: x.offsetPx,
        yPct: y.pct,
        yOffsetPx: y.offsetPx,
        anchor: positionNum(position.anchor ?? 'leftTop'),
      },
    };
  }
  return {
    position: positionNum(isHFSemanticPosition(position) ? position : undefined),
    custom: null,
    customPosition: null,
  };
}

function resolveHFSlot(
  slot: PageRegionSlot,
  region: PageRegionConfig,
  fallbackPosition: HFSemanticPosition | ContentPosition | undefined,
): ResolvedHFSlot {
  const position = resolveHFSlotPosition(slot.position ?? fallbackPosition);
  return {
    content: slot.content,
    color: parseColor(slot.color ?? region.contentColor ?? '#333333'),
    fontFamily: slot.fontFamily?.trim() || 'Helvetica',
    fontSizePx: slot.fontSize ?? region.contentFontSize ?? 16,
    fontWeight: Math.max(1, Math.round(slot.fontWeight ?? 400)),
    italic: slot.italic ? 1 : 0,
    position: position.position,
    custom: position.custom,
    customPosition: position.customPosition,
  };
}

function resolveRegion(
  region: PageRegionConfig | undefined,
  isFooter: boolean,
): ResolvedHF | null {
  if (!region) return null;
  const slots = Array.isArray(region.slots)
    ? region.slots.map((slot) => resolveHFSlot(slot, region, region.contentPosition))
    : [];
  if (slots.length === 0) {
    const content = typeof region.content === 'string' ? region.content
      : isFooter ? '${currentPage}/${totalPages}'
      : '';
    if (content) {
      slots.push(resolveHFSlot({ content }, region, region.contentPosition));
    }
  }
  return {
    heightPx: region.height ?? 50,
    padding: region.padding ?? [0, 24, 0, 24],
    slots,
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
  resetDebugPerfSnapshotState();
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
  // Metadata: normalize user options, fill defaults (WASM has no clock, so
  // dates are generated here on the JS side).
  const metadata = normalizeMetadataOptions(normalizedOptions.metadata);
  if (metadata) {
    if (metadata.producer === '') metadata.producer = 'dompdf.js';
    const now = pdfDateString(new Date());
    metadata.creationDate = now;
    metadata.modDate = now;
  }
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
  const rootScrollX = root.scrollLeft;
  const rootScrollY = root.scrollTop;
  const offX = rootRect.left + window.scrollX;
  const offY = rootRect.top + window.scrollY;
  const layoutScale = computeLayoutScale(rootRect.width, pageWidthPt, mLeft, mRight);

  const nodes: NodeRec[] = [];
  const formFields: CollectedFormField[] = [];
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

  function findFirstTextFragmentX(el: HTMLElement): number | null {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null;
    while (node) {
      if (node.data && node.data.trim().length > 0) {
        const fragments = collectTextFragments(node);
        if (fragments.length > 0) return fragments[0].x;
      }
      node = walker.nextNode() as Text | null;
    }
    return null;
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
    const decorationThicknessRaw = parseFloat((cs.textDecorationThickness || '').trim());
    const decorationThicknessPx = Number.isFinite(decorationThicknessRaw) && decorationThicknessRaw > 0
      ? decorationThicknessRaw * layoutScale
      : 0;
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
      decorationLineMask: textDecorationMask(cs),
      decorationThicknessPx,
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
    // Single-pass min/max to avoid 4 array allocations + spread stack risk.
    let maxRight = lines[0].x + lines[0].w, minLeft = lines[0].x;
    let maxBottom = lines[0].y + lines[0].h, minTop = lines[0].y;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.x < minLeft) minLeft = l.x;
      if (l.x + l.w > maxRight) maxRight = l.x + l.w;
      if (l.y < minTop) minTop = l.y;
      if (l.y + l.h > maxBottom) maxBottom = l.y + l.h;
    }
    nodes.push({
      id: nodes.length,
      parent: parentId,
      kind: 1,
      x: lines[0].x,
      y: lines[0].y,
      w: maxRight - minLeft,
      h: maxBottom - minTop,
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

  async function appendFormRasterNode(
    parentId: number,
    el: HTMLElement,
    rawRect: DOMRect,
    cs: CSSStyleDeclaration,
  ): Promise<void> {
    const raster = await rasterizeElement(el, rawRect, quality, cs);
    if (!raster) return;
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
    nodes.push({
      id: nodes.length,
      parent: parentId,
      kind: 2,
      x: rawX * layoutScale,
      y: rawY * layoutScale,
      w: raster.cssWidth * layoutScale,
      h: raster.cssHeight * layoutScale,
      flags: F_IMAGE,
      overflowHidden: false,
      renderMode: 0,
      divisionDisable: false,
      pageBreak: false,
      imageId,
      objectFit: 0,
    });
  }

  function pushFormFieldEntry(nodeId: number, formControl: FormControlAnalysis): void {
    formFields.push({
      id: formFields.length + 1,
      nodeId,
      kind: formControl.kind,
      interactiveKind: formControl.interactiveKind,
      name: formControl.name,
      value: formControl.value,
      defaultValue: formControl.defaultValue,
      placeholder: formControl.placeholder,
      checked: formControl.checked,
      disabled: formControl.disabled,
      readonly: formControl.readonly,
      required: formControl.required,
      multiple: formControl.multiple,
      placeholderShown: formControl.placeholderShown,
      password: formControl.password,
      textAlign: formControl.textAlign,
      padding: formControl.padding,
      options: formControl.options,
    });
  }

  function pushFormHiddenText(
    parentId: number,
    box: NodeRec,
    cs: CSSStyleDeclaration,
    text: string,
    multiline: boolean,
  ): void {
    if (!text) return;
    const font = makeFont(cs) as NonNullable<NodeRec['font']>;
    const paddingTop = (parseFloat(cs.paddingTop) || 0) * layoutScale;
    const paddingRight = (parseFloat(cs.paddingRight) || 0) * layoutScale;
    const paddingBottom = (parseFloat(cs.paddingBottom) || 0) * layoutScale;
    const paddingLeft = (parseFloat(cs.paddingLeft) || 0) * layoutScale;
    const contentX = box.x + paddingLeft;
    const contentY = box.y + paddingTop;
    const contentW = Math.max(1, box.w - paddingLeft - paddingRight);
    const contentH = Math.max(1, box.h - paddingTop - paddingBottom);
    if (!multiline) {
      const utf8End = utf8Offsets(text)[text.length];
      pushTextNode(parentId, font, text, [{
        x: contentX,
        y: contentY,
        w: contentW,
        h: Math.max(1, Math.min(contentH, font.lineHeightPx)),
        start: 0,
        end: utf8End,
      }], undefined, 3);
      return;
    }
    const utf8 = utf8Offsets(text);
    const lines: LineBox[] = [];
    const parts = text.split(/\r\n|\r|\n/);
    let cursor = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const start = cursor;
      const end = start + part.length;
      lines.push({
        x: contentX,
        y: contentY + i * font.lineHeightPx,
        w: contentW,
        h: Math.max(1, font.lineHeightPx),
        start: utf8[start],
        end: utf8[end],
      });
      cursor = end;
      while (cursor < text.length && (text[cursor] === '\r' || text[cursor] === '\n')) cursor += 1;
    }
    pushTextNode(parentId, font, text, lines, undefined, 3);
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
    const hrefAttr = el.tagName === 'A' ? el.getAttribute('href')?.trim() : '';
    const resolvedHref = hrefAttr ? (el as HTMLAnchorElement).href.trim() : '';
    const href = resolvedHref && !/^javascript:/i.test(resolvedHref) ? resolvedHref : undefined;

    const kind = isImg ? 2 : 0;
    const strategy: RenderStrategy = isImg ? 'vector' : classifyRenderStrategy(el, cs);
    const stats = getDebugPerfState().snapshot;
    if (strategy === 'full-raster') stats.strategyFullRaster += 1;
    else if (strategy === 'background-raster') stats.strategyBackgroundRaster += 1;
    else stats.strategyVector += 1;

    if (strategy === 'full-raster' && r.w > 0 && r.h > 0) {
      // Form controls can legitimately land here: native-appearance checkbox /
      // radio (isRasterTag) or a custom style whose ::after checkmark forces
      // foreground raster. The generic form collection below runs AFTER this
      // early return, so collect the field here or the interactive widget
      // silently vanishes from the PDF.
      const frFormControl = analyzeFormControl(el, cs, normalizedOptions.form);
      const frInteractive = frFormControl !== null
        && shouldEmitInteractiveFormField(normalizedOptions.form, frFormControl.interactiveKind);
      if (frFormControl && frInteractive && shouldSuppressBaseNodeForInteractiveField(frFormControl.kind)) {
        // Interactive checkbox/radio: the PDF widget renders its own appearance
        // (box + check state), so baking the browser's pixels would only draw a
        // second, stale-looking control underneath. Push a hidden placeholder
        // node carrying the input's rect purely for widget placement.
        nodes.push({
          id,
          parent: parentId,
          kind: 0,
          x: r.x, y: r.y, w: r.w, h: r.h,
          flags: F_RENDER_MODE | F_DIVISION_DISABLE,
          overflowHidden: false,
          renderMode: 2,
          divisionDisable: true,
          pageBreak: false,
        });
        pushFormFieldEntry(id, frFormControl);
        return;
      }
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
        const rawX = raster.rawLeft + window.scrollX - offX + rootScrollX;
        const rawY = raster.rawTop + window.scrollY - offY + rootScrollY;
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
          href,
          imageId,
          objectFit: 0,
        });

        let extractedAnyText = false;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let textNode = walker.nextNode() as Text | null;
        while (textNode) {
          const text = textNode.data;
          if (text && text.trim().length > 0) {
            const owner = (textNode.parentElement || el) as HTMLElement;
            const lines = collectTextLines(textNode);
            if (lines.length > 0) {
              const font = makeFont(getComputedStyle(owner)) as NonNullable<NodeRec['font']>;
              pushTextNode(parentId, font, text, lines, undefined, 3);
              extractedAnyText = true;
            }
          }
          textNode = walker.nextNode() as Text | null;
        }
        if (!extractedAnyText) {
          const hiddenText = collectFullRasterExtractableText(el);
          if (hiddenText) {
            const font = makeFont(cs) as NonNullable<NodeRec['font']>;
            const fontSizePx = parseFloat(cs.fontSize) || 16;
            const lineHeightRaw = parseFloat(cs.lineHeight);
            const lineHeightPx = isNaN(lineHeightRaw) ? fontSizePx * 1.2 : lineHeightRaw;
            const baselineY = rawY * layoutScale + Math.max(0, (lineHeightPx - fontSizePx) * 0.5) * layoutScale;
            const utf8End = utf8Offsets(hiddenText)[hiddenText.length];
            pushTextNode(parentId, font, hiddenText, [{
              x: rawX * layoutScale,
              y: baselineY,
              w: Math.max(1, scaledW),
              h: Math.max(1, lineHeightPx * layoutScale),
              start: 0,
              end: utf8End,
            }], undefined, 3);
          }
        }
        // Textual controls that reach full-raster (e.g. transformed inputs):
        // keep the raster visible and place the widget on top of it.
        if (frFormControl && frInteractive) {
          pushFormFieldEntry(id, frFormControl);
        }
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
      const bd = await resolveBackdropColor(el, rawRect);
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
    // The exported root represents the full document, including scrollable
    // off-screen content. Nested clipping containers keep their CSS behavior.
    const overflowHidden = parentId !== -1 && clipsOverflow(cs);
    const opacity = parseFloat(cs.opacity);
    const hasOpacity = opacity < 1;

    const dm = el.dataset.dom2pdfMode;
    const renderMode = dm === 'raster' ? 1 : dm === 'skip' ? 2 : 0;
    const objectPosition = isImg ? parseObjectPosition(cs.objectPosition) : null;

    const breakInside = cs.breakInside || cs.getPropertyValue('break-inside');
    const pageBreakInside = cs.getPropertyValue('page-break-inside');
    const divisionDisable = el.hasAttribute('divisionDisable')
      || breakInside === 'avoid'
      || breakInside === 'avoid-page'
      || pageBreakInside === 'avoid';
    const pageBreak = el.hasAttribute('pageBreak');

    let flags = 0;
    if (hasBg) flags |= F_BG;
    if (visibleBorder) flags |= F_BORDER;
    if (shadow.length > 0) flags |= F_SHADOW;
    if (hasRadius) flags |= F_RADIUS;
    if (overflowHidden) flags |= F_OVERFLOW;
    if (hasOpacity) flags |= F_OPACITY;
    if (isImg) flags |= F_IMAGE;
    if (isImg) flags |= F_AVOID_IMAGE_SPLIT;
    if (renderMode !== 0) flags |= F_RENDER_MODE;
    if (divisionDisable) flags |= F_DIVISION_DISABLE;
    if (pageBreak) flags |= F_PAGE_BREAK;
    if (href) flags |= F_LINK;

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
      href,
      imageId: isImg ? imgToId.get(el) : undefined,
      objectFit: isImg ? objectFitNum(cs.objectFit) : undefined,
      objectPositionXPct: objectPosition?.x.pct,
      objectPositionXOffsetPx: objectPosition?.x.offsetPx,
      objectPositionYPct: objectPosition?.y.pct,
      objectPositionYOffsetPx: objectPosition?.y.offsetPx,
    };

    if (isRasterTag(el, cs)) {
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

    const formControl = analyzeFormControl(el, cs, normalizedOptions.form);
    if (formControl) {
      if (!node.divisionDisable) {
        node.divisionDisable = true;
        node.flags |= F_DIVISION_DISABLE;
      }
      const emitInteractive = shouldEmitInteractiveFormField(normalizedOptions.form, formControl.interactiveKind);
      const emitStaticText = normalizedOptions.form.mode === 'static'
        && isTextualFormKind(formControl.kind)
        && formControl.hiddenText.length > 0;
      const emitStaticRaster = normalizedOptions.form.mode === 'static'
        && shouldRasterizeStaticFormControl(formControl.kind);

      if (emitInteractive && shouldSuppressBaseNodeForInteractiveField(formControl.kind)) {
        if (node.renderMode === 0) {
          node.renderMode = 1;
          node.flags |= F_RENDER_MODE;
        }
      }

      if (emitStaticRaster) {
        if (node.renderMode === 0) {
          node.renderMode = 1;
          node.flags |= F_RENDER_MODE;
        }
        await appendFormRasterNode(id, el, rawRect, cs);
      }
      if (emitStaticText) {
        pushFormHiddenText(
          id,
          node,
          cs,
          formControl.hiddenText,
          formControl.kind === FORM_FIELD_KIND_TEXTAREA || formControl.multiple,
        );
      }
      if (emitInteractive) {
        pushFormFieldEntry(node.id, formControl);
      }
      return;
    }

    // --- ::marker synthesis for <li> ---
    // When a <li> is rendered as vector / background-raster, its ::marker box
    // is NOT a real DOM child (browsers paint it from list-style semantics), so
    // the text-collector below would skip it. We synthesize a marker text node
    // here so bullets/numbers survive into the PDF. full-raster is handled by
    // cloneElementForRaster, which lets the browser paint the marker natively.
    if (
      strategy !== 'full-raster'
      && el.tagName.toUpperCase() === 'LI'
      && (cs.display || '').trim() === 'list-item'
    ) {
      const markerCs = getComputedStyle(el, '::marker');
      const listStyleType = (cs.listStyleType || markerCs.listStyleType || 'disc').trim();
      const idx = computeListItemIndex(el);
      if (idx !== null) {
        const markerText = markerTextFromListStyle(listStyleType, markerCs.content, idx);
        if (markerText) {
          const markerFont = makeFont(markerCs) as NonNullable<NodeRec['font']>;
          const fontStr = `${markerCs.fontWeight} ${markerCs.fontSize} ${markerCs.fontFamily}`;
          const textWidthPx = measureTextWidth(markerText, fontStr);
          const fontSizePx = parseFloat(markerCs.fontSize) || parseFloat(cs.fontSize) || 16;
          const lineHeightRaw = parseFloat(markerCs.lineHeight);
          const lineHeightPx = isNaN(lineHeightRaw) ? fontSizePx * 1.2 : lineHeightRaw;

          const liDoc = docRect(el.getBoundingClientRect());
          const position = (cs.listStylePosition || 'outside').trim();
          const listCs = el.parentElement ? getComputedStyle(el.parentElement) : null;
          const listPaddingLeftPx = listCs ? (parseFloat(listCs.paddingLeft) || 0) : 0;
          const paddingLeftPx = parseFloat(cs.paddingLeft) || 0;
          const markerMarginLeftPx = parseFloat(markerCs.marginLeft) || 0;
          const markerMarginRightPx = parseFloat(markerCs.marginRight) || 0;
          const markerGapPx = Math.max(4, fontSizePx * 0.33);

          // Vertical: align marker cap with the first text line of the <li>.
          // Using liDoc.y + (lineHeight - fontSize)/2 approximates the text
          // top for the common single-line case; multi-line <li> still get a
          // correct first-line marker because lineHeight matches the first
          // line box height.
          const markerY = liDoc.y + (lineHeightPx - fontSizePx) * 0.5 * layoutScale;
          const firstTextX = findFirstTextFragmentX(el);
          let markerX: number;
          let markerW: number;
          let markerAlign = markerFont.align;
          if (position === 'inside') {
            // Marker flows as the first inline child, so it starts at the
            // padding-left edge of the <li>.
            markerX = firstTextX !== null
              ? firstTextX - textWidthPx * layoutScale
              : liDoc.x + paddingLeftPx * layoutScale;
            markerW = Math.max(1, textWidthPx * layoutScale);
          } else {
            // Outside: reserve the browser-like marker column (usually the
            // parent list's padding-left) and right-align marker text inside it.
            const markerRight = firstTextX !== null
              ? firstTextX - markerGapPx * layoutScale
              : liDoc.x + (paddingLeftPx - markerMarginRightPx) * layoutScale;
            const markerColumnPx = Math.max(textWidthPx + markerGapPx, listPaddingLeftPx + markerMarginLeftPx);
            markerW = Math.max(1, markerColumnPx * layoutScale);
            markerX = markerRight - markerW;
            markerAlign = 1;
          }
          const utf8End = utf8Offsets(markerText)[markerText.length];
          const markerFontNode: NonNullable<NodeRec['font']> = { ...markerFont, align: markerAlign };
          pushTextNode(id, markerFontNode, markerText, [{
            x: markerX,
            y: markerY,
            w: markerW,
            h: Math.max(1, fontSizePx * layoutScale),
            start: 0,
            end: utf8End,
          }]);
        }
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
          forcedBg = await resolveBackdropColor(cell, cell.getBoundingClientRect());
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
    fonts, nodes, formFields, images,
    metadata: metadata ?? null,
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
  /** PDF Info-dictionary fields; null when no metadata was provided (v16). */
  metadata: NormalizedPdfMetadata | null;
  perPageHF: (ResolvedHF | null)[][]; // each: [header|null, footer|null]
  perPageWatermark: (ResolvedWatermark | null)[];
  fonts: CollectedFont[];
  nodes: NodeRec[];
  formFields: CollectedFormField[];
  images: CollectedImage[];
}

function writeHF(w: BinWriter, hf: ResolvedHF) {
  w.f32(hf.heightPx);
  w.f32(hf.padding[0]); w.f32(hf.padding[1]); w.f32(hf.padding[2]); w.f32(hf.padding[3]);
  w.u16(hf.slots.length);
  for (const slot of hf.slots) {
    const clen = BinWriter.utf8Len(slot.content);
    const flen = BinWriter.utf8Len(slot.fontFamily);
    w.u16(clen);
    w.utf8(slot.content);
    w.f32(slot.color[0]); w.f32(slot.color[1]); w.f32(slot.color[2]); w.f32(slot.color[3]);
    w.u16(flen);
    w.utf8(slot.fontFamily);
    w.f32(slot.fontSizePx);
    w.u16(slot.fontWeight);
    w.u8(slot.italic);
    w.u8(slot.position);
    if (slot.position === 9 && slot.custom) {
      w.f32(slot.custom[0]); w.f32(slot.custom[1]);
    } else if (slot.position === 10 && slot.customPosition) {
      w.f32(slot.customPosition.xPct);
      w.f32(slot.customPosition.xOffsetPx);
      w.f32(slot.customPosition.yPct);
      w.f32(slot.customPosition.yOffsetPx);
      w.u8(slot.customPosition.anchor);
    }
  }
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

function writeString32(w: BinWriter, value: string): void {
  const len = BinWriter.utf8Len(value);
  w.u32(len);
  w.utf8(value);
}

function writeFormField(w: BinWriter, field: CollectedFormField): void {
  let flags = 0;
  if (field.checked) flags |= FORM_FLAG_CHECKED;
  if (field.disabled) flags |= FORM_FLAG_DISABLED;
  if (field.readonly) flags |= FORM_FLAG_READONLY;
  if (field.required) flags |= FORM_FLAG_REQUIRED;
  if (field.multiple) flags |= FORM_FLAG_MULTIPLE;
  if (field.placeholderShown) flags |= FORM_FLAG_PLACEHOLDER_SHOWN;
  if (field.password) flags |= FORM_FLAG_PASSWORD;
  w.u32(field.id);
  w.u32(field.nodeId);
  w.u8(field.kind);
  w.u8(field.interactiveKind);
  w.u8(field.textAlign);
  w.u16(flags);
  w.f32(field.padding[0]);
  w.f32(field.padding[1]);
  w.f32(field.padding[2]);
  w.f32(field.padding[3]);
  writeString32(w, field.name);
  writeString32(w, field.value);
  writeString32(w, field.defaultValue);
  writeString32(w, field.placeholder);
  w.u32(field.options.length);
  for (const option of field.options) {
    writeString32(w, option.label);
    writeString32(w, option.value);
    w.u8(option.selected ? 1 : 0);
  }
}

function encode(a: EncodeArgs): Uint8Array {
  const w = new BinWriter();
  w.bytes(new Uint8Array([0x44, 0x32, 0x50, 0x31])); // "D2P1"
  w.u32(16); // version 16 (PDF metadata / Info dictionary)
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

  // v16: metadata block
  w.u8(a.metadata ? 1 : 0);
  if (a.metadata) {
    writeString32(w, a.metadata.title);
    writeString32(w, a.metadata.author);
    writeString32(w, a.metadata.subject);
    writeString32(w, a.metadata.keywords);
    writeString32(w, a.metadata.creator);
    writeString32(w, a.metadata.producer);
    writeString32(w, a.metadata.creationDate);
    writeString32(w, a.metadata.modDate);
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
    if (n.href) flags |= F_LINK;
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
      w.u8(n.font.decorationLineMask);
      w.f32(n.font.decorationThicknessPx);
    }
    if (n.imageId !== undefined) {
      w.u32(n.imageId);
      w.u8(n.objectFit ?? 0);
      w.f32(n.objectPositionXPct ?? 0.5);
      w.f32(n.objectPositionXOffsetPx ?? 0);
      w.f32(n.objectPositionYPct ?? 0.5);
      w.f32(n.objectPositionYOffsetPx ?? 0);
    }
    if (n.renderMode !== 0) w.u8(n.renderMode);
    if (n.href) {
      const hrefLen = BinWriter.utf8Len(n.href);
      w.u32(hrefLen);
      w.utf8(n.href);
    }
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

  // Form fields
  w.u32(a.formFields.length);
  for (const field of a.formFields) {
    writeFormField(w, field);
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
      ? {
        ...hf.header,
        slots: hf.header.slots.map((slot) => ({
          ...slot,
          content: resolvePlaceholder(slot.content, p, totalPages),
        })),
      }
      : null,
    footer: hf.footer
      ? {
        ...hf.footer,
        slots: hf.footer.slots.map((slot) => ({
          ...slot,
          content: resolvePlaceholder(slot.content, p, totalPages),
        })),
      }
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
