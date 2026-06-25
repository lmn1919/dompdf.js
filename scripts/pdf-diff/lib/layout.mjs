// Layout helpers extracted from scripts/pdf-diff-mvp.mjs (kept in sync, not imported
// to avoid touching the existing test infra).

export const PX_TO_PT = 0.75;
export const PT_TO_PX = 1 / PX_TO_PT;

export const PAGE_SIZES = {
  a0: [2384.25, 3370.5],
  a1: [1683.75, 2384.25],
  a2: [1190.25, 1683.75],
  a3: [842.25, 1190.25],
  a4: [595.5, 842.25],
  a5: [419.25, 595.5],
  a6: [297.75, 419.25],
  a7: [210, 297.75],
  a8: [147.75, 210],
  a9: [105, 147.75],
  a10: [73.5, 105],
  b0: [2835, 4008],
  b1: [2004, 2835],
  b2: [1417.5, 2004],
  b3: [1000.5, 1417.5],
  b4: [708.75, 1000.5],
  b5: [498.75, 708.75],
  b6: [354, 498.75],
  b7: [249.75, 354],
  b8: [175.5, 249.75],
  b9: [124.5, 175.5],
  b10: [87.75, 124.5],
  c0: [2599.5, 3676.5],
  c1: [1836.75, 2599.5],
  c2: [1298.25, 1836.75],
  c3: [918.75, 1298.25],
  c4: [648.75, 918.75],
  c5: [459, 648.75],
  c6: [323.25, 459],
  c7: [229.5, 323.25],
  c8: [161.25, 229.5],
  c9: [113.25, 161.25],
  c10: [79.5, 113.25],
  letter: [612, 792],
  'government-letter': [576, 756],
  legal: [612, 1008],
  'junior-legal': [360, 576],
  tabloid: [792, 1224],
  ledger: [1224, 792],
  'government-legal': [612, 936],
};

export function roundSize(value) {
  return Math.max(1, Math.round(value));
}

export function normalizeMarginPt(marginPt) {
  if (Array.isArray(marginPt)) {
    return [marginPt[0] ?? 36, marginPt[1] ?? 36, marginPt[2] ?? 36, marginPt[3] ?? 36];
  }
  const value = typeof marginPt === 'number' ? marginPt : 36;
  return [value, value, value, value];
}

export function resolvePageSizePt(options) {
  if (typeof options.pageWidthPt === 'number' && typeof options.pageHeightPt === 'number') {
    return [options.pageWidthPt, options.pageHeightPt];
  }
  const format = Array.isArray(options.format) ? options.format : String(options.format || 'a4').toLowerCase();
  if (Array.isArray(format) && format.length === 2) return format;
  return PAGE_SIZES[format] || PAGE_SIZES.a4;
}

export function computeLayoutScale(rootWidthPx, pageWidthPt, marginLeftPt, marginRightPt) {
  if (!(rootWidthPx > 0)) return 1;
  const contentWidthPx = Math.max(1, (pageWidthPt - marginLeftPt - marginRightPt) / PX_TO_PT);
  return Math.min(1, contentWidthPx / rootWidthPx);
}

export function computeLayoutMetrics(meta) {
  const options = meta.options || {};
  const [pageWidthPt, pageHeightPt] = resolvePageSizePt(options);
  const [mTopPt, mRightPt, mBottomPt, mLeftPt] = normalizeMarginPt(options.marginPt);
  const headerHeightPx = options.pageConfig?.header?.height || 0;
  const footerHeightPx = options.pageConfig?.footer?.height || 0;
  const layoutScale = computeLayoutScale(meta.rootWidthPx, pageWidthPt, mLeftPt, mRightPt);
  const pageWidthPx = pageWidthPt * PT_TO_PX;
  const marginTopPx = mTopPt * PT_TO_PX;
  const marginRightPx = mRightPt * PT_TO_PX;
  const marginBottomPx = mBottomPt * PT_TO_PX;
  const marginLeftPx = mLeftPt * PT_TO_PX;
  const contentWidthPx = Math.max(1, pageWidthPx - marginLeftPx - marginRightPx);
  const paginated = options.pagination !== false;
  const contentHeightPx = paginated
    ? ((pageHeightPt - mTopPt - mBottomPt - headerHeightPx * PX_TO_PT - footerHeightPx * PX_TO_PT > 0
      ? pageHeightPt - mTopPt - mBottomPt - headerHeightPx * PX_TO_PT - footerHeightPx * PX_TO_PT
      : pageHeightPt - mTopPt - mBottomPt) * PT_TO_PX)
    : Math.max(1, meta.rootHeightPx * layoutScale);
  const pageHeightPx = paginated
    ? pageHeightPt * PT_TO_PX
    : marginTopPx + headerHeightPx + contentHeightPx + footerHeightPx + marginBottomPx;
  return {
    contentHeightPx,
    contentWidthPx,
    footerHeightPx,
    headerHeightPx,
    layoutScale,
    marginBottomPx,
    marginLeftPx,
    marginRightPx,
    marginTopPx,
    pageHeightPx,
    pageWidthPx,
  };
}
