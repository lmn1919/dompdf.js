// Tier 2 — structured text diff.
//
// Ground truth: oracle.json Range.getClientRects() boxes (per-word, CSS px,
// target-root space, top-origin).
// Actual:       pdfjs getTextContent() items from actual.pdf (PDF pt, bottom-origin).
//
// We convert actual items into the same target-root CSS-px space (undoing
// PX_TO_PT and the fit-to-width layoutScale, and flipping y to top-origin),
// align the two text streams by normalized string (LCS), and compute per-item
// Δx / Δy / ΔfontSize. These deltas are the locatable signal Tier 3 classifies.

import { PT_TO_PX, PX_TO_PT, normalizeMarginPt } from './layout.mjs';

const ASCENT_FACTOR = 0.8; // approximate baseline offset relative to font-size
const DX_TOL_PX = 2;
const DY_TOL_PX = 2;
const DFSIZE_TOL_PX = 0.5;
const DWIDTH_TOL_PX = 3;
const LINE_Y_TOL_PX = 3; // boxes within this y distance are treated as one line
const X_OFFSET_STABLE_STD_PX = 0.2;
const X_OFFSET_MIN_COUNT = 3;
const X_OFFSET_APPLY_TOL_PX = 0.35;
const SINGLE_SYMBOL_DX_TOL_PX = 3.75;
// Matches any CJK / full-width Unicode block character.
const CJK_RE_TRAILING = /([\u3000-\u303f\u2e80-\u2eff\u3400-\u4dbf\u4e00-\u9faf\uac00-\ud7af\uff00-\uffef]) /gu;
const CJK_RE_LEADING  = / ([\u3000-\u303f\u2e80-\u2eff\u3400-\u4dbf\u4e00-\u9faf\uac00-\ud7af\uff00-\uffef])/gu;

function norm(s) {
  // Collapse whitespace, then strip spaces at CJK↔non-CJK boundaries so oracle
  // (browser HTML, preserves explicit spaces) and actual (dompdf PDF, no boundary
  // spaces in shaped runs) normalise to the same string.
  return String(s).trim().toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(CJK_RE_TRAILING, '$1')
    .replace(CJK_RE_LEADING, '$1');
}

function fontSizeBucket(px) {
  return Math.round((Number(px) || 0) * 2) / 2;
}

function actualFontBucket(item) {
  return `${item?.fontName || ''}@${fontSizeBucket(item?.fontSize)}`;
}

function isSingleSymbolText(text) {
  const value = String(text || '').trim();
  if ([...value].length !== 1) return false;
  return /[^\p{L}\p{N}\s]/u.test(value);
}

function pageSliceStartPx(pageIndex, meta, metrics) {
  const breaks = Array.isArray(meta?.pageBreaks) ? meta.pageBreaks : [];
  if (pageIndex <= 0) return 0;
  if (pageIndex - 1 < breaks.length) {
    return breaks[pageIndex - 1] || 0;
  }
  return pageIndex * (metrics.contentHeightPx || 0);
}

// Convert a pdfjs text item into target-root CSS-px space (top-origin).
// pdfjs reports the baseline origin (item.y = transform[5]) in PDF user space,
// which is BOTTOM-origin: y grows upward with 0 at the page bottom. We flip it to
// a top-origin distance from the page top, subtract the content top offset
// (margin + header), and add the per-page slice offset so the result lands in the
// same top-origin target-root space as the oracle boxes. Skipping the flip makes
// every item read as (pageHeight - y) — a constant-sum mirror that masquerades as
// a huge, page-wide "text-y-drift".
function actualItemToRootPx(item, metrics, meta) {
  const [mTopPt, , , mLeftPt] = normalizeMarginPt(metrics.options?.marginPt ?? 0);
  const headerOffsetPt = (metrics.options?.pageConfig?.header?.height || 0) * PX_TO_PT;
  const contentTopPt = mTopPt + headerOffsetPt;
  const layoutScale = metrics.layoutScale || 1;

  // Media-box height in pt (each item carries its page's height; fall back to the
  // computed metrics for safety).
  const pageHeightPt = item.pageHeightPt || (metrics.pageHeightPx || 0) * PX_TO_PT;
  const yFromTopPt = pageHeightPt - item.y;
  // In paginated mode, pageBreak/divisionDisable can move whole subtrees so page
  // slices are not always a simple pageIndex * contentHeightPx grid. Prefer the
  // actual DOM slice starts captured in meta.pageBreaks; fall back to the fixed
  // page-height model for callers that do not provide them.
  const pageIndex = Math.max(0, (item.page || 1) - 1);
  const pageOffsetPx = pageSliceStartPx(pageIndex, meta, metrics);

  const xRootPx = (item.x * PT_TO_PX) / layoutScale;
  const yRootPx = pageOffsetPx + ((yFromTopPt - contentTopPt) * PT_TO_PX) / layoutScale;
  const fontSizePx = (item.fontSize * PT_TO_PX) / layoutScale;
  return { xRootPx, yRootPx, fontSizePx, fontName: item.fontName, page: item.page };
}

// LCS alignment over normalized strings. Returns matched index pairs + unmatched.
function alignSequences(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) {
    return { matches: [], unmatchedA: a.map((_, i) => i), unmatchedB: b.map((_, i) => i) };
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      dp[i][j] = matchKey(a[i - 1]) === matchKey(b[j - 1])
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matches = [];
  let i = n;
  let j = m;
  const matchedA = new Set();
  const matchedB = new Set();
  while (i > 0 && j > 0) {
    if (matchKey(a[i - 1]) === matchKey(b[j - 1])) {
      matches.unshift({ a: i - 1, b: j - 1 });
      matchedA.add(i - 1);
      matchedB.add(j - 1);
      i -= 1;
      j -= 1;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  const unmatchedA = a.map((_, idx) => idx).filter((idx) => !matchedA.has(idx));
  const unmatchedB = b.map((_, idx) => idx).filter((idx) => !matchedB.has(idx));
  return { matches, unmatchedA, unmatchedB };
}

function matchKey(item) {
  return item.matchNorm || item.norm;
}

function shouldDisambiguateShortNorm(norm, countA, countB) {
  if (!norm || norm.length === 0 || norm.length > 2) return false;
  if (countA !== countB || countA <= 1 || countA > 8) return false;
  if (norm.includes(' ')) return false;
  return true;
}

function isShortAmbiguousNorm(norm) {
  return !!norm && norm.length > 0 && norm.length <= 2 && !norm.includes(' ');
}

function pageIndexForY(y, meta, metrics) {
  const breaks = Array.isArray(meta?.pageBreaks) ? meta.pageBreaks : [];
  if (!breaks.length) {
    const contentHeightPx = metrics?.contentHeightPx || 0;
    return contentHeightPx > 0 ? Math.max(0, Math.floor((Number(y) || 0) / contentHeightPx)) : 0;
  }
  let pageIndex = 0;
  while (pageIndex < breaks.length && y >= breaks[pageIndex]) {
    pageIndex += 1;
  }
  return pageIndex;
}

// Repeated 1-2 character formula tokens like "B", "0", "∂" are common in the
// math demo. Plain LCS can legally match the wrong occurrence when nearby
// superscript/subscript runs cause the surrounding tokenization to diverge. When
// both streams contain the same number of such short tokens on the same page
// slice, tag them with their occurrence order so alignment stays stable without
// affecting longer prose.
function annotateRepeatedShortNorms(oracleSeq, actualSeq, meta, metrics) {
  const oracleCounts = new Map();
  const actualCounts = new Map();
  for (const item of oracleSeq) {
    const page = pageIndexForY(item.yBaseline, meta, metrics);
    const key = `${item.norm}@${page}`;
    oracleCounts.set(key, (oracleCounts.get(key) || 0) + 1);
  }
  for (const item of actualSeq) {
    const page = Math.max(0, (item.page || 1) - 1);
    const key = `${item.norm}@${page}`;
    actualCounts.set(key, (actualCounts.get(key) || 0) + 1);
  }

  const occurrence = new Map();
  const annotate = (seq, countsA, countsB, resolvePage) => seq.map((item) => {
    const page = resolvePage(item);
    const key = `${item.norm}@${page}`;
    const countA = countsA.get(key) || 0;
    const countB = countsB.get(key) || 0;
    if (!shouldDisambiguateShortNorm(item.norm, countA, countB)) {
      return item;
    }
    const next = (occurrence.get(key) || 0) + 1;
    occurrence.set(key, next);
    return { ...item, matchNorm: `${item.norm}@${page}#${next}` };
  });

  return {
    oracleSeq: annotate(
      oracleSeq,
      oracleCounts,
      actualCounts,
      (item) => pageIndexForY(item.yBaseline, meta, metrics),
    ),
    actualSeq: (() => {
      occurrence.clear();
      return annotate(
        actualSeq,
        actualCounts,
        oracleCounts,
        (item) => Math.max(0, (item.page || 1) - 1),
      );
    })(),
  };
}

function spatialScore(oracleItem, actualItem) {
  const dx = actualItem.x - oracleItem.x;
  const dy = actualItem.yBaseline - oracleItem.yBaseline;
  return (dx * dx) + (dy * dy);
}

function repairShortTokenMatches(matches, oracleSeq, actualSeq, unmatchedB) {
  const unmatchedBSet = new Set(unmatchedB);
  const repaired = matches.map((pair) => ({ ...pair }));
  for (const pair of repaired) {
    const oracleItem = oracleSeq[pair.a];
    const actualItem = actualSeq[pair.b];
    if (!isShortAmbiguousNorm(oracleItem.norm)) continue;
    const currentScore = spatialScore(oracleItem, actualItem);
    let bestIndex = pair.b;
    let bestScore = currentScore;
    for (const candidateIndex of unmatchedBSet) {
      const candidate = actualSeq[candidateIndex];
      if (candidate.norm !== oracleItem.norm) continue;
      if (Math.abs((candidate.page || 1) - (actualItem.page || 1)) > 1) continue;
      const candidateScore = spatialScore(oracleItem, candidate);
      if (candidateScore + 4 < bestScore) {
        bestScore = candidateScore;
        bestIndex = candidateIndex;
      }
    }
    if (bestIndex !== pair.b) {
      unmatchedBSet.delete(bestIndex);
      unmatchedBSet.add(pair.b);
      pair.b = bestIndex;
    }
  }
  return {
    matches: repaired,
    unmatchedB: Array.from(unmatchedBSet).sort((a, b) => a - b),
  };
}

// Group per-word Range boxes into line-level entries so the granularity matches
// dompdf's line-level text items. Consecutive boxes (DOM = reading order) whose
// baseline y is within LINE_Y_TOL_PX form one line. Line width (last word's right
// edge - first word's left edge) is kept so within-line advance-width drift is
// still detectable as a Δwidth even though we no longer align per word.
export function buildOracleSequence(oracle) {
  const boxes = (Array.isArray(oracle?.boxes) ? oracle.boxes : [])
    .filter((b) => b.text && b.text.trim())
    .map((b) => ({
      text: b.text,
      x: b.x,
      right: b.x + b.w,
      width: b.w,
      visibleRight: b.x + (b.visibleW ?? b.w),
      visibleWidth: b.visibleW ?? b.w,
      hasTrailingWhitespace: /\s+$/u.test(b.text),
      yBaseline: b.y + b.fontSize * ASCENT_FACTOR,
      fontSize: b.fontSize,
      fontFamily: b.fontFamily,
      nodeId: b.nodeId,
    }));

  const lines = [];
  let current = null;
  for (const b of boxes) {
    if (!current || Math.abs(b.yBaseline - current.yBaseline) > LINE_Y_TOL_PX) {
      if (current) lines.push(finishLine(current));
      current = {
        words: [b.text],
        x: b.x,
        right: b.right,
        width: b.width,
        visibleRight: b.visibleRight,
        visibleWidth: b.visibleWidth,
        yBaseline: b.yBaseline,
        fontSize: b.fontSize,
        fontFamily: b.fontFamily,
        nodeIds: [b.nodeId],
        hasTrailingWhitespace: b.hasTrailingWhitespace,
      };
    } else {
      current.words.push(b.text);
      current.right = Math.max(current.right, b.right);
      current.width += b.width;
      current.visibleRight = Math.max(current.visibleRight, b.visibleRight);
      current.visibleWidth += b.visibleWidth;
      if (b.fontSize > current.fontSize) current.fontSize = b.fontSize;
      current.nodeIds.push(b.nodeId);
      current.hasTrailingWhitespace = current.hasTrailingWhitespace || b.hasTrailingWhitespace;
    }
  }
  if (current) lines.push(finishLine(current));
  return lines;
}

function joinWordsIntelligently(words) {
  let result = '';
  const isAlphaNum = (c) => /[a-zA-Z0-9]/i.test(c);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i === 0) {
      result = w;
    } else {
      const lastChar = result.slice(-1);
      const firstChar = w.charAt(0);
      if (!lastChar || !firstChar) {
        result += w;
      } else if (/\s/.test(lastChar) || /\s/.test(firstChar)) {
        result += w;
      } else if (isAlphaNum(lastChar) && isAlphaNum(firstChar)) {
        result += ' ' + w;
      } else {
        result += w;
      }
    }
  }
  return result;
}

function finishLine(line) {
  const text = joinWordsIntelligently(line.words).replace(/\s+([.,;:!?])/g, '$1');
  const singleNode = new Set(line.nodeIds).size === 1;
  return {
    norm: norm(text),
    text,
    x: line.x,
    yBaseline: line.yBaseline,
    fontSize: line.fontSize,
    width: line.right - line.x,
    visibleWidth: line.visibleRight - line.x,
    summedWidth: singleNode ? line.width : undefined,
    summedVisibleWidth: singleNode ? line.visibleWidth : undefined,
    hasTrailingWhitespace: line.hasTrailingWhitespace,
    fontFamily: line.fontFamily,
    nodeId: line.nodeIds[0],
  };
}

export function buildActualSequence(pdfTextItems, metrics, meta) {
  const layoutScale = metrics.layoutScale || 1;
  const items = pdfTextItems
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const c = actualItemToRootPx(it, metrics, meta);
      return {
        text: it.str,
        x: c.xRootPx,
        right: c.xRootPx + (it.w * PT_TO_PX) / layoutScale,
        width: (it.w * PT_TO_PX) / layoutScale,
        yBaseline: c.yRootPx,
        fontSize: c.fontSizePx,
        fontName: c.fontName,
        page: c.page,
        hasTrailingWhitespace: /\s+$/u.test(it.str),
      };
    });

  const lines = [];
  let current = null;
  for (const b of items) {
    if (!current || b.page !== current.page || Math.abs(b.yBaseline - current.yBaseline) > LINE_Y_TOL_PX) {
      if (current) lines.push(finishActualLine(current));
      current = {
        words: [b.text],
        x: b.x,
        right: b.right,
        width: b.width,
        yBaseline: b.yBaseline,
        fontSize: b.fontSize,
        fontName: b.fontName,
        page: b.page,
        hasTrailingWhitespace: b.hasTrailingWhitespace,
      };
    } else {
      current.words.push(b.text);
      current.right = Math.max(current.right, b.right);
      current.width += b.width;
      if (b.fontSize > current.fontSize) current.fontSize = b.fontSize;
      current.hasTrailingWhitespace = current.hasTrailingWhitespace || b.hasTrailingWhitespace;
    }
  }
  if (current) lines.push(finishActualLine(current));
  return lines;
}

function finishActualLine(line) {
  const text = joinWordsIntelligently(line.words).replace(/\s+([.,;:!?])/g, '$1');
  return {
    norm: norm(text),
    text,
    x: line.x,
    yBaseline: line.yBaseline,
    fontSize: line.fontSize,
    width: line.right - line.x,
    fontName: line.fontName,
    page: line.page,
  };
}

export function diffTexts(oracle, pdfTextItems, metrics, meta) {
  const oracleSeqRaw = buildOracleSequence(oracle);
  const actualSeqRaw = buildActualSequence(pdfTextItems, metrics, meta);
  const { oracleSeq, actualSeq } = annotateRepeatedShortNorms(oracleSeqRaw, actualSeqRaw, meta, metrics);
  const { matches, unmatchedA, unmatchedB } = alignSequences(oracleSeq, actualSeq);
  const repaired = repairShortTokenMatches(matches, oracleSeq, actualSeq, unmatchedB);

  // First pass: raw per-match deltas.
  const matched = repaired.matches.map((pair) => {
    const o = oracleSeq[pair.a];
    const a = actualSeq[pair.b];
    const oracleWidth = effectiveOracleWidth(o, a);
    return {
      o: { ...o, width: oracleWidth },
      a,
      dx: a.x - o.x,
      dy: a.yBaseline - o.yBaseline,
      dFontSize: a.fontSize - o.fontSize,
      dWidth: a.width - oracleWidth,
    };
  });

  // A uniform vertical offset between the oracle's estimated baseline
  // (box.y + fontSize*ASCENT_FACTOR — an approximation) and dompdf's real text
  // baseline is a systematic calibration constant, not per-line drift. Remove its
  // robust center (median) so reported dy reflects *relative* deviation; surface
  // the constant separately as dyOffset, where a genuinely large uniform shift
  // (e.g. a real top-margin error) stays visible without flagging every line.
  const dyOffset = median(matched.map((m) => m.dy));
  // Pagination preserves whitespace by shifting later content downward in
  // document space. That creates page-wise dy steps in the extracted PDF text
  // which are not local line-stacking errors. Remove the per-page median first,
  // then apply the finer font-size baseline calibration to the page-normalized
  // residuals.
  const dyOffsetsByPage = medianMap(
    matched,
    (m) => m.a.page || 1,
    (m) => m.dy,
    4,
  );
  const dyOffsetsByFontSize = medianMap(
    matched,
    (m) => fontSizeBucket(m.o.fontSize),
    (m) => {
      const pageDyOffset = dyOffsetsByPage.get(m.a.page || 1) ?? dyOffset;
      return m.dy - pageDyOffset;
    },
    1,
  );
  // Some CID fonts extract from pdfjs with a stable text-origin x offset while
  // preserving the correct visual width. Treat that as an extraction baseline,
  // not a real subtree transform, but only when the pattern is stable within a
  // font bucket and width agreement says layout itself is correct.
  const xOffsetsByActualFont = stableXOffsetsByActualFont(matched);

  const cov = charCoverageDetail(oracleSeq, actualSeq);

  const discrepancies = [];
  const deltas = { dx: [], dy: [], dFontSize: [], dWidth: [] };

  for (const m of matched) {
    const { o, a, dFontSize, dWidth } = m;
    const pageDyOffset = dyOffsetsByPage.get(a.page || 1) ?? dyOffset;
    const fontDyOffset = dyOffsetsByFontSize.get(fontSizeBucket(o.fontSize)) ?? 0;
    const rawFontXOffset = xOffsetsByActualFont.get(actualFontBucket(a)) ?? 0;
    const fontXOffset = Math.abs(dWidth) <= DWIDTH_TOL_PX
      && Math.abs(m.dx - rawFontXOffset) <= X_OFFSET_APPLY_TOL_PX
      ? rawFontXOffset
      : 0;
    const dx = m.dx - fontXOffset;
    const dy = m.dy - pageDyOffset - fontDyOffset; // page + baseline calibrated residual
    deltas.dx.push(dx);
    deltas.dy.push(dy);
    deltas.dFontSize.push(dFontSize);
    deltas.dWidth.push(dWidth);

    const dxTol = singleSymbolDxTolerance(o, dx, dy, dFontSize, dWidth);
    if (Math.abs(dx) > dxTol || Math.abs(dy) > DY_TOL_PX
      || Math.abs(dFontSize) > DFSIZE_TOL_PX || Math.abs(dWidth) > DWIDTH_TOL_PX) {
      discrepancies.push({
        text: o.text,
        oracle: { x: round(o.x), y: round(o.yBaseline), fontSize: round(o.fontSize), width: round(o.width), nodeId: o.nodeId },
        actual: { x: round(a.x), y: round(a.yBaseline), fontSize: round(a.fontSize), width: round(a.width), page: a.page, fontName: a.fontName },
        delta: { dx: round(dx), dy: round(dy), dFontSize: round(dFontSize), dWidth: round(dWidth) },
      });
    }
  }

  return {
    summary: {
      oracleItems: oracleSeq.length,
      actualItems: actualSeq.length,
      aligned: repaired.matches.length,
      unmatchedOracle: unmatchedA.length,
      unmatchedActual: repaired.unmatchedB.length,
      // Distinct-character coverage of oracle text by the extracted PDF text.
      // ~1.0 means the text IS present in the stream (any unmatched lines are a
      // wrap/segmentation artifact); a low value means it is genuinely
      // unextractable (broken ToUnicode/encoding). Lets Tier 3 tell them apart.
      charCoverage: cov.coverage,
      // Distinct oracle codepoints absent from the extracted PDF text — i.e. the
      // characters that dropped to a blank .notdef (no per-glyph font fallback).
      // Surfaced even when charCoverage is near 1, so a few vanished symbols
      // (∫ √ ± …) are classifiable instead of hiding inside the wrap noise.
      missingChars: cov.missing,
      // Systematic uniform vertical baseline offset (px) removed before y-drift
      // detection. Small values are oracle/dompdf baseline-model calibration.
      dyOffset: round(dyOffset),
      meanDx: mean(deltas.dx),
      meanDy: mean(deltas.dy),
      meanDFontSize: mean(deltas.dFontSize),
      meanDWidth: mean(deltas.dWidth),
      stdDx: std(deltas.dx),
      stdDy: std(deltas.dy),
      stdDWidth: std(deltas.dWidth),
      discrepancyCount: discrepancies.length,
    },
    discrepancies,
    unmatched: {
      oracle: unmatchedA.map((i) => ({ text: oracleSeq[i].text, nodeId: oracleSeq[i].nodeId })),
      actual: repaired.unmatchedB.map((i) => ({ text: actualSeq[i].text, page: actualSeq[i].page })),
    },
  };
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianMap(items, keyOf, valueOf, minCount = 1) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const value = valueOf(item);
    const list = grouped.get(key);
    if (list) {
      list.push(value);
    } else {
      grouped.set(key, [value]);
    }
  }
  const medians = new Map();
  for (const [key, values] of grouped) {
    if (values.length >= minCount) {
      medians.set(key, median(values));
    }
  }
  return medians;
}

function stableXOffsetsByActualFont(matches) {
  const grouped = new Map();
  for (const match of matches) {
    if (Math.abs(match.dx) <= DX_TOL_PX || Math.abs(match.dWidth) > DWIDTH_TOL_PX) continue;
    const key = actualFontBucket(match.a);
    if (!key || key.startsWith('@')) continue;
    const list = grouped.get(key);
    if (list) {
      list.push(match.dx);
    } else {
      grouped.set(key, [match.dx]);
    }
  }
  const offsets = new Map();
  for (const [key, values] of grouped) {
    if (values.length < X_OFFSET_MIN_COUNT) continue;
    const offset = median(values);
    if (Math.abs(offset) <= DX_TOL_PX) continue;
    const scatter = std(values);
    if (scatter > X_OFFSET_STABLE_STD_PX) continue;
    offsets.set(key, offset);
  }
  return offsets;
}

function singleSymbolDxTolerance(oracleItem, dx, dy, dFontSize, dWidth) {
  if (!isSingleSymbolText(oracleItem?.text)) return DX_TOL_PX;
  if (Math.abs(dy) > DY_TOL_PX || Math.abs(dFontSize) > DFSIZE_TOL_PX) return DX_TOL_PX;
  if (Math.abs(dWidth) > 0.25) return DX_TOL_PX;
  if (Math.abs(dx) <= DX_TOL_PX) return DX_TOL_PX;
  return SINGLE_SYMBOL_DX_TOL_PX;
}

function effectiveOracleWidth(oracleItem, actualItem) {
  const fullWidth = oracleItem.width;
  const actualWidth = actualItem?.width ?? fullWidth;
  const candidates = [{ width: fullWidth, error: Math.abs(actualWidth - fullWidth) }];
  const visibleWidth = oracleItem.visibleWidth ?? fullWidth;
  if (oracleItem.hasTrailingWhitespace && Number.isFinite(visibleWidth)) {
    candidates.push({ width: visibleWidth, error: Math.abs(actualWidth - visibleWidth) });
  }
  const summedWidth = oracleItem.summedWidth;
  if (Number.isFinite(summedWidth)) {
    candidates.push({ width: summedWidth, error: Math.abs(actualWidth - summedWidth) });
  }
  const summedVisibleWidth = oracleItem.summedVisibleWidth;
  if (oracleItem.hasTrailingWhitespace && Number.isFinite(summedVisibleWidth)) {
    candidates.push({ width: summedVisibleWidth, error: Math.abs(actualWidth - summedVisibleWidth) });
  }
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.error + 0.25 < best.error) best = candidate;
  }
  return best.width;
}

// Whitespace-insensitive distinct-character coverage of oracle text by actual
// text, PLUS the list of oracle characters that never appear in the extracted
// PDF text. Distinct (set), NOT multiset, on purpose — the oracle captures
// per-word client rects that can overlap and double-count the same visual text
// (e.g. a wrapped heading), which would deflate a multiset ratio even when every
// character extracts cleanly. A broken ToUnicode/encoding emits NUL/garbage
// codepoints, so the real characters go missing and `coverage` collapses (the
// font-encoding signal). A few specific symbols dropping to .notdef (no
// per-glyph fallback) instead leaves `coverage` near 1 but populates `missing`
// — the signal Tier 3 turns into the missing-glyph category.
function charCoverageDetail(oracleSeq, actualSeq) {
  const actualChars = new Set();
  for (const item of actualSeq) {
    for (const ch of item.norm) {
      if (ch !== ' ') actualChars.add(ch);
    }
  }
  const oracleChars = new Set();
  const sampleFor = new Map(); // char -> first oracle line containing it
  for (const item of oracleSeq) {
    for (const ch of item.norm) {
      if (ch === ' ') continue;
      oracleChars.add(ch);
      if (!sampleFor.has(ch)) sampleFor.set(ch, item.text);
    }
  }
  if (oracleChars.size === 0) return { coverage: 1, missing: [] };
  let covered = 0;
  const missing = [];
  for (const ch of oracleChars) {
    if (actualChars.has(ch)) {
      covered += 1;
    } else {
      const cp = ch.codePointAt(0) || 0;
      missing.push({
        char: ch,
        codepoint: `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        sample: sampleFor.get(ch),
      });
    }
  }
  return { coverage: round(covered / oracleChars.size), missing };
}

function std(arr) {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function round(v) {
  return Math.round(v * 100) / 100;
}
