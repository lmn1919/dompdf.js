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

function norm(s) {
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Convert a pdfjs text item into target-root CSS-px space (top-origin).
// pdfjs reports the baseline origin (item.y = transform[5]) in PDF user space,
// which is BOTTOM-origin: y grows upward with 0 at the page bottom. We flip it to
// a top-origin distance from the page top, subtract the content top offset
// (margin + header), and add the per-page slice offset so the result lands in the
// same top-origin target-root space as the oracle boxes. Skipping the flip makes
// every item read as (pageHeight - y) — a constant-sum mirror that masquerades as
// a huge, page-wide "text-y-drift".
function actualItemToRootPx(item, metrics) {
  const [mTopPt, , , mLeftPt] = normalizeMarginPt(metrics.options?.marginPt ?? 0);
  const headerOffsetPt = (metrics.options?.pageConfig?.header?.height || 0) * PX_TO_PT;
  const contentTopPt = mTopPt + headerOffsetPt;
  const layoutScale = metrics.layoutScale || 1;

  // Media-box height in pt (each item carries its page's height; fall back to the
  // computed metrics for safety).
  const pageHeightPt = item.pageHeightPt || (metrics.pageHeightPx || 0) * PX_TO_PT;
  const yFromTopPt = pageHeightPt - item.y;
  // Each PDF page maps to one contentHeightPx-tall slice of the continuous root.
  const pageIndex = Math.max(0, (item.page || 1) - 1);
  const pageOffsetPx = pageIndex * (metrics.contentHeightPx || 0);

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
      dp[i][j] = a[i - 1].norm === b[j - 1].norm
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
    if (a[i - 1].norm === b[j - 1].norm) {
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
        yBaseline: b.yBaseline,
        fontSize: b.fontSize,
        fontFamily: b.fontFamily,
        nodeIds: [b.nodeId],
      };
    } else {
      current.words.push(b.text);
      current.right = Math.max(current.right, b.right);
      if (b.fontSize > current.fontSize) current.fontSize = b.fontSize;
      current.nodeIds.push(b.nodeId);
    }
  }
  if (current) lines.push(finishLine(current));
  return lines;
}

function finishLine(line) {
  const text = line.words.join(' ').replace(/\s+([.,;:!?])/g, '$1');
  return {
    norm: norm(text),
    text,
    x: line.x,
    yBaseline: line.yBaseline,
    fontSize: line.fontSize,
    width: line.right - line.x,
    fontFamily: line.fontFamily,
    nodeId: line.nodeIds[0],
  };
}

export function buildActualSequence(pdfTextItems, metrics) {
  const layoutScale = metrics.layoutScale || 1;
  return pdfTextItems
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const c = actualItemToRootPx(it, metrics);
      return {
        norm: norm(it.str),
        text: it.str,
        x: c.xRootPx,
        yBaseline: c.yRootPx,
        fontSize: c.fontSizePx,
        width: (it.w * PT_TO_PX) / layoutScale,
        fontName: c.fontName,
        page: c.page,
      };
    });
}

export function diffTexts(oracle, pdfTextItems, metrics) {
  const oracleSeq = buildOracleSequence(oracle);
  const actualSeq = buildActualSequence(pdfTextItems, metrics);
  const { matches, unmatchedA, unmatchedB } = alignSequences(oracleSeq, actualSeq);

  // First pass: raw per-match deltas.
  const matched = matches.map((pair) => {
    const o = oracleSeq[pair.a];
    const a = actualSeq[pair.b];
    return {
      o,
      a,
      dx: a.x - o.x,
      dy: a.yBaseline - o.yBaseline,
      dFontSize: a.fontSize - o.fontSize,
      dWidth: a.width - o.width,
    };
  });

  // A uniform vertical offset between the oracle's estimated baseline
  // (box.y + fontSize*ASCENT_FACTOR — an approximation) and dompdf's real text
  // baseline is a systematic calibration constant, not per-line drift. Remove its
  // robust center (median) so reported dy reflects *relative* deviation; surface
  // the constant separately as dyOffset, where a genuinely large uniform shift
  // (e.g. a real top-margin error) stays visible without flagging every line.
  const dyOffset = median(matched.map((m) => m.dy));

  const cov = charCoverageDetail(oracleSeq, actualSeq);

  const discrepancies = [];
  const deltas = { dx: [], dy: [], dFontSize: [], dWidth: [] };

  for (const m of matched) {
    const { o, a, dx, dFontSize, dWidth } = m;
    const dy = m.dy - dyOffset; // baseline-calibrated residual
    deltas.dx.push(dx);
    deltas.dy.push(dy);
    deltas.dFontSize.push(dFontSize);
    deltas.dWidth.push(dWidth);

    if (Math.abs(dx) > DX_TOL_PX || Math.abs(dy) > DY_TOL_PX
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
      aligned: matches.length,
      unmatchedOracle: unmatchedA.length,
      unmatchedActual: unmatchedB.length,
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
      actual: unmatchedB.map((i) => ({ text: actualSeq[i].text, page: actualSeq[i].page })),
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
