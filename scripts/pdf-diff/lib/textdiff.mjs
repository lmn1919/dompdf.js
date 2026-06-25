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
// dompdf lays out top-down and emits text in a top-origin coordinate space, so
// item.y is already measured from the top (not the PDF bottom-left). We still
// subtract the content top offset (margin + header) so the result is in the same
// target-root space as the oracle boxes.
function actualItemToRootPx(item, metrics) {
  const [mTopPt, , , mLeftPt] = normalizeMarginPt(metrics.options?.marginPt ?? 0);
  const headerOffsetPt = (metrics.options?.pageConfig?.header?.height || 0) * PX_TO_PT;
  const contentTopPt = mTopPt + headerOffsetPt;
  const layoutScale = metrics.layoutScale || 1;

  const xRootPx = (item.x * PT_TO_PX) / layoutScale;
  const yRootPx = ((item.y - contentTopPt) * PT_TO_PX) / layoutScale;
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

  const discrepancies = [];
  const deltas = { dx: [], dy: [], dFontSize: [], dWidth: [] };

  for (const pair of matches) {
    const o = oracleSeq[pair.a];
    const a = actualSeq[pair.b];
    const dx = a.x - o.x;
    const dy = a.yBaseline - o.yBaseline;
    const dFontSize = a.fontSize - o.fontSize;
    const dWidth = a.width - o.width;
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

function std(arr) {
  if (arr.length === 0) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

function round(v) {
  return Math.round(v * 100) / 100;
}
