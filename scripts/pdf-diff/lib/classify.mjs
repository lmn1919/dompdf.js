// Tier 3 — root-cause classification.
//
// Maps Tier 2 discrepancies (+ Tier 1 pixel mismatch + inspect tree) to a small
// set of categories, each pointing at the suspected Rust/WASM core method that
// would produce that kind of drift. This is the bridge to Tier 4: it tells the
// fix-loop *where to look*, not what to change.

const SUSPECTED = {
  'text-x-drift': { file: 'wasm/src/font.rs', fn: 'text_width_units', also: 'wasm/src/ttf.rs (hmtx advance widths)' },
  'text-y-drift': { file: 'wasm/src/paginate.rs', fn: 'paginate', also: 'wasm/src/paginate.rs (line stacking)' },
  'page-break': { file: 'wasm/src/paginate.rs', fn: 'assign_pages', also: 'wasm/src/paginate.rs (break placement)' },
  'font-size': { file: 'src/snapshot.ts', fn: 'PX_TO_PT / fontSize collection', also: 'wasm/src/font.rs (size scaling)' },
  'font-family': { file: 'wasm/src/font.rs', fn: 'font selection / CID embedding', also: 'wasm/src/ttf.rs' },
  'font-encoding': { file: 'wasm/src/font.rs', fn: 'encode_winansi / ToUnicode', also: 'wasm/src/ttf.rs (cmap) / paginate.rs (text stream)' },
  'missing-glyph': { file: 'wasm/src/font.rs', fn: 'encode_cid (per-glyph fallback)', also: 'wasm/src/ttf.rs gid_for (cmap miss → gid 0/.notdef)' },
  color: { file: 'src/snapshot.ts', fn: 'color parsing', also: 'wasm/src/paginate.rs (alpha compositing)' },
  'bg-color': { file: 'src/snapshot.ts', fn: 'background-color capture', also: 'wasm/src/paginate.rs (rect fill / alpha)' },
  border: { file: 'src/snapshot.ts', fn: 'border capture', also: 'wasm/src/paginate.rs (border stroke)' },
  shadow: { file: 'src/snapshot.ts', fn: 'box-shadow capture', also: 'wasm/src/paginate.rs (shadow paint — may be unimplemented)' },
  icon: { file: 'wasm/src/snapshot.rs', fn: 'Image', also: 'wasm/src/paginate.rs (image/svg render) / useCORS' },
  image: { file: 'wasm/src/snapshot.rs', fn: 'Image', also: 'wasm/src/paginate.rs (image render) / useCORS' },
  transform: { file: 'wasm/src/paginate.rs', fn: 'transform matrix', also: 'src/snapshot.ts (transform capture)' },
  wrap: { file: 'wasm/src/paginate.rs', fn: 'line breaking', also: 'wasm/src/font.rs text_width_units' },
};

const HINTS = {
  'text-x-drift': 'Advance-width measurement diverges from the browser. Check the TTF hmtx table read in ttf.rs and the per-glyph width sum in font.rs::text_width_units. A growing Δx along a line is the signature.',
  'text-y-drift': 'Vertical positions drift as lines stack. Inspect line-box height / leading handling in paginate.rs::paginate and how line spacing is derived from font metrics.',
  'page-break': 'Large Δy spikes at page boundaries. Check paginate.rs::assign_pages — break Y positions or unsplittable-unit handling.',
  'font-size': 'Font size is off by a constant ratio. Verify the px→pt conversion (PX_TO_PT) in snapshot collection and any scaling in font.rs. A consistent ΔfontSize across all items is the signature.',
  'font-family': 'A different font/glyph set is embedded than the page uses. Check font.rs font selection and CID-font embedding; confirm the injected FontConfig reached the WASM side.',
  'font-encoding': 'Text is visible in the PDF but not extractable (many oracle lines have no matching PDF text item, yet pixel mismatch is low). The text stream lacks a usable ToUnicode / character encoding. Check font.rs::encode_winansi and the CID font ToUnicode mapping, and ttf.rs cmap handling.',
  'missing-glyph': 'Specific codepoints present in the browser text are absent from the PDF text stream and render as blank .notdef, while the rest of the text extracts fine (charCoverage stays near 1). Signature of a cmap miss with no per-glyph font fallback: the selected CID font lacks these glyphs (gid_for → 0 in ttf.rs) and encode_cid emits the blank glyph instead of falling back to another embedded font that covers the codepoint. Check encode_cid in font.rs and route missing codepoints to a fallback font.',
  color: 'Colors differ while text positions align. Check color parsing in src/snapshot.ts and alpha compositing in paginate.rs.',
  'bg-color': "An element's painted background color diverges from the browser (located per element, ΔE in Lab). Check background-color capture in src/snapshot.ts and rect fill/alpha in paginate.rs.",
  border: "An element's border color/presence diverges from the browser at the box edge. Check border capture in src/snapshot.ts and border stroking in paginate.rs.",
  shadow: 'The dompdf raster lacks the box-shadow the browser paints just outside the box. Likely box-shadow is unimplemented in paginate.rs (or not captured in snapshot.ts). Low confidence / known gap.',
  icon: 'An icon region (img/svg/background-image) differs from the browser (localized pixel mismatch). Check Image capture in snapshot.rs, image/SVG placement in paginate.rs, and CORS/useCORS handling.',
  image: 'Image missing or misplaced. Check Image capture in snapshot.rs, image placement in paginate.rs, and CORS/useCORS handling.',
  transform: 'Whole subtree is shifted by a constant Δx/Δy. Check the transform matrix application in paginate.rs and transform capture in src/snapshot.ts.',
  wrap: 'Text wraps differently (many unmatched actual/oracle items). Check line-breaking in paginate.rs and the text-width measurement feeding it.',
};

function severityFor(category, count, meanDelta) {
  if (category === 'page-break' && count > 0) return 'high';
  if (count >= 20 || Math.abs(meanDelta) >= 8) return 'high';
  if (count >= 5 || Math.abs(meanDelta) >= 3) return 'medium';
  return 'low';
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx2 += a * a;
    dy2 += b * b;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den === 0 ? 0 : num / den;
}

export function classify({ textDiff, pixelDiff, visualDiff, inspectText, meta }) {
  const categories = [];
  const discrepancies = textDiff?.discrepancies || [];
  const summary = textDiff?.summary || {};

  // Per-discrepancy primary category assignment.
  const byCat = {};
  function push(cat, disc) {
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(disc);
  }

  // Outlier detection on dy for page-break spikes.
  const dys = discrepancies.map((d) => d.delta.dy);
  const dyMean = summary.meanDy || 0;
  const dyStd = summary.stdDy || 0;
  const dyOutlierThresh = Math.max(12, Math.abs(dyMean) + 3 * dyStd);

  for (const d of discrepancies) {
    const { dx, dy, dFontSize, dWidth } = d.delta;
    if (Math.abs(dFontSize) > 0.5) {
      push('font-size', d);
    } else if (Math.abs(dy) > dyOutlierThresh) {
      push('page-break', d);
    } else if (Math.abs(dy) > 2) {
      push('text-y-drift', d);
    } else if (Math.abs(dWidth) > 3) {
      // line-width mismatch = advance-width measurement drift on that line
      push('text-x-drift', d);
    } else if (Math.abs(dx) > 2) {
      push('transform', d);
    }
  }

  // Global: constant whole-subtree shift (transform).
  if (Math.abs(summary.meanDx) > 1 && Math.abs(summary.meanDy) > 1
    && (summary.stdDx ?? 0) < 1.5 && (summary.stdDy ?? 0) < 1.5) {
    categories.push(makeCategory('transform', 0, summary.meanDx, {
      kind: 'constant-shift',
      meanDx: round(summary.meanDx),
      meanDy: round(summary.meanDy),
    }));
  }

  // Global: text rendered but not extractable. Many oracle lines have no match
  // in the PDF text stream while pixel mismatch stays low → the content may be
  // drawn without a usable ToUnicode/encoding. BUT a high charCoverage means the
  // characters *are* present in the extracted stream and the unmatched lines are
  // only a wrap/segmentation difference (logical oracle lines vs pdfjs Tj runs),
  // not an encoding bug — so only call it font-encoding when coverage is low.
  const unmatchedActual = summary.unmatchedActual || 0;
  const unmatchedOracle = summary.unmatchedOracle || 0;
  const oracleItems = summary.oracleItems || 1;
  const aligned = summary.aligned || 1;
  const pixelMismatch = pixelDiff?.aggregateMismatchRatio || 0;
  const charCoverage = summary.charCoverage ?? 1;
  const missingChars = summary.missingChars || [];
  const manyUnmatchedOracle = unmatchedOracle / oracleItems > 0.3;
  if (manyUnmatchedOracle && pixelMismatch < 0.3 && charCoverage < 0.6) {
    categories.push(makeCategory('font-encoding', unmatchedOracle, 0, {
      kind: 'unextractable-text',
      unmatchedOracle,
      oracleItems,
      aligned,
      charCoverage,
      aggregateMismatchRatio: round(pixelMismatch),
      note: 'Content is visually present (low pixel mismatch) but missing from the PDF text stream — suspect ToUnicode/encoding, not layout.',
    }));
  } else if (unmatchedActual / aligned > 0.15 || manyUnmatchedOracle) {
    const cat = makeCategory('wrap', unmatchedActual, 0, {
      kind: 'unmatched-ratio',
      unmatchedActual,
      unmatchedOracle,
      aligned,
      charCoverage,
      note: charCoverage >= 0.6
        ? (missingChars.length === 0
          ? 'Characters are present in the extracted text (high charCoverage); unmatched lines are a wrap/segmentation difference between logical oracle lines and pdfjs Tj runs, not missing text.'
          : `Most text is present, but ${missingChars.length} oracle codepoint(s) are missing from the PDF stream — see the missing-glyph category; the remaining unmatched lines are a wrap/segmentation difference.`)
        : 'Text wraps/segments differently from the oracle.',
    });
    // Severity of a wrap/segmentation difference is set by its VISUAL impact, not
    // by the raw count of unmatched segments (which the oracle's overlapping
    // per-word rects inflate). If the characters are present and the page barely
    // moves pixels, differently-wrapped text reads the same — that's cosmetic.
    cat.severity = charCoverage < 0.6
      ? 'high'
      : pixelMismatch >= 0.2 ? 'high' : pixelMismatch >= 0.08 ? 'medium' : 'low';
    categories.push(cat);
  }

  // Specific codepoints dropped to a blank .notdef — present in the oracle text
  // but absent from the extracted PDF stream — even when overall coverage is high
  // and the wrap/font-encoding gates above never fired. This is the no-per-glyph
  // -fallback signature: a few symbols (∫ √ ± ∇ × …) vanish while the bulk of the
  // text extracts cleanly, so it would otherwise hide inside the wrap noise.
  //
  // Gate on high coverage: when coverage is LOW the missing codepoints are a
  // *systemic* failure (broken ToUnicode → text rendered but unextractable, owned
  // by the font-encoding category above), not a handful of per-glyph fallback
  // gaps. Without this gate a CJK page with broken ToUnicode would mislabel
  // hundreds of rendered-but-unextractable characters as "missing glyphs".
  if (missingChars.length > 0 && charCoverage >= 0.6) {
    const nonAscii = missingChars.filter((m) => (m.char?.codePointAt(0) || 0) > 0x7f);
    const cat = makeCategory('missing-glyph', missingChars.length, 0, {
      kind: 'dropped-codepoints',
      charCoverage,
      missingCount: missingChars.length,
      nonAsciiCount: nonAscii.length,
      missing: missingChars.slice(0, 30).map((m) => `${m.codepoint} ${JSON.stringify(m.char)}`),
    });
    // A handful of vanished symbols is a real, localized defect. Escalate to
    // medium when several distinct glyphs drop or any are non-ASCII symbols
    // (almost always the .notdef-blank case rather than an extraction quirk like
    // an em-dash extracting as a hyphen); a lone ASCII miss stays low.
    cat.severity = (nonAscii.length >= 2 || missingChars.length >= 5) ? 'medium' : 'low';
    cat.samples = missingChars.slice(0, 10);
    categories.push(cat);
  }

  // font-size drift correlation: ΔfontSize grows with fontSize?
  const sizeDisc = byCat['font-size'] || [];
  if (sizeDisc.length > 0) {
    const corr = pearson(
      sizeDisc.map((d) => d.oracle.fontSize),
      sizeDisc.map((d) => d.delta.dFontSize),
    );
    const cat = makeCategory('font-size', sizeDisc.length, summary.meanDFontSize || 0, {
      kind: 'per-item',
      meanDFontSize: round(summary.meanDFontSize || 0),
      correlationWithSize: round(corr),
    });
    cat.samples = sizeDisc.slice(0, 5);
    categories.push(cat);
    delete byCat['font-size'];
  }

  // x-drift = line-width mismatch (advance-width measurement). Correlate Δwidth
  // with the line's font-size: a growing Δwidth for larger fonts points at the
  // per-glyph width table (ttf.rs hmtx / font.rs::text_width_units).
  const xDisc = byCat['text-x-drift'] || [];
  if (xDisc.length > 0) {
    const corr = pearson(
      xDisc.map((d) => d.oracle.fontSize),
      xDisc.map((d) => d.delta.dWidth),
    );
    const cat = makeCategory('text-x-drift', xDisc.length, summary.meanDWidth || 0, {
      kind: 'per-item',
      meanDWidth: round(summary.meanDWidth || 0),
      stdDWidth: round(summary.stdDWidth || 0),
      correlationWithFontSize: round(corr),
    });
    cat.samples = xDisc.slice(0, 5);
    categories.push(cat);
    delete byCat['text-x-drift'];
  }

  // Remaining per-item categories.
  for (const [cat, discs] of Object.entries(byCat)) {
    if (discs.length === 0) continue;
    const meanDelta = cat === 'text-y-drift' ? summary.meanDy : 0;
    const c = makeCategory(cat, discs.length, meanDelta, { kind: 'per-item' });
    c.samples = discs.slice(0, 5);
    categories.push(c);
  }

  // Tier 2b — non-text visual diffs (bg-color / border / shadow / icon), already
  // located per element by visualdiff. Each kind becomes one category, with the
  // raw per-element findings as samples.
  const visualByKind = {};
  for (const d of visualDiff?.discrepancies || []) {
    if (!visualByKind[d.kind]) visualByKind[d.kind] = [];
    visualByKind[d.kind].push(d);
  }
  const meanDeltaE = visualDiff?.summary?.meanDeltaE || 0;
  for (const [kind, discs] of Object.entries(visualByKind)) {
    const cat = makeCategory(kind, discs.length, 0, {
      kind: 'per-element',
      count: discs.length,
      meanDeltaE: kind === 'bg-color' ? meanDeltaE : undefined,
    });
    // shadow is a known low-confidence gap; never escalate it on count alone.
    if (kind === 'shadow') cat.severity = 'low';
    else cat.severity = discs.length >= 20 ? 'high' : discs.length >= 5 ? 'medium' : 'low';
    cat.samples = discs.slice(0, 5);
    categories.push(cat);
  }
  const hasLocatedBgColor = Boolean(visualByKind['bg-color']);

  // color / image / font-family: low-confidence, driven by pixel mismatch + inspect.
  const textDeltaSmall = Math.abs(summary.meanDx) < 2 && Math.abs(summary.meanDy) < 2 && (summary.discrepancyCount || 0) < 10;
  if (pixelMismatch > 0.03 && textDeltaSmall && !hasLocatedBgColor) {
    categories.push(makeCategory('color', 0, 0, {
      kind: 'inferred-from-pixels',
      aggregateMismatchRatio: round(pixelMismatch),
      note: 'Pixel mismatch is high while text positions align — suspect color/alpha, not layout.',
    }));
  }

  const hasImages = /imageId/i.test(inspectText || '') || /<img/i.test(String(meta?.selector || ''));
  if (hasImages && pixelMismatch > 0.05 && !visualByKind.icon) {
    categories.push(makeCategory('image', 0, 0, {
      kind: 'inferred-from-pixels',
      aggregateMismatchRatio: round(pixelMismatch),
      note: 'Inspect tree reports images and pixel mismatch is high — verify image capture/placement.',
    }));
  }

  // Order by severity then count.
  const order = { high: 0, medium: 1, low: 2 };
  categories.sort((a, b) => (order[a.severity] - order[b.severity]) || (b.count - a.count));
  return categories;
}

function makeCategory(category, count, meanDelta, evidence) {
  return {
    category,
    count,
    severity: severityFor(category, count, meanDelta),
    suspected: SUSPECTED[category] || { file: 'unknown', fn: 'unknown' },
    hint: HINTS[category] || '',
    evidence,
    samples: [],
  };
}

function round(v) {
  return Math.round(v * 100) / 100;
}
