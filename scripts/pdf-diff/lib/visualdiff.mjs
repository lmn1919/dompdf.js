// Tier 2b — structured NON-TEXT visual diff (background color, border, box-shadow, icon).
//
// Ground truth: oracle.elements — per-element CSS boxes (target-root px) with their
// computed visual properties (backgroundColor / border / boxShadow / isIcon).
// Actual: the normalized content-box rasters produced by pixeldiff.mjs (expected =
// headless screenshot, actual = dompdf PDF raster), both in the SAME per-page px
// space (contentWidthPx × contentHeightPx).
//
// We map each element box into that page-image space with the exact same slice math
// as createExpectedPageImage (page from meta.pageBreaks, scale by metrics.layoutScale)
// and compare:
//   bg-color — element's computed backgroundColor vs the dompdf raster interior (ΔE).
//   border   — element's computed border color vs the dompdf raster edge strip (ΔE).
//   shadow   — does the dompdf raster darken just outside the box like the browser does?
//   icon     — localized expected-vs-actual pixel mismatch inside the icon box.
// Output mirrors textdiff: { summary, discrepancies:[{ kind, nodeId, box, expected, actual, delta }] }.

import { PNG } from 'pngjs';

// Thresholds (tuned to suppress antialiasing / JPEG noise, surface real gaps).
const BG_DELTA_E = 6; // CIE76 ΔE; <2.3 is imperceptible
const BG_DECLARED_VISIBILITY_E = 10; // browser interior this far from declared bg => background is mostly covered by descendants
const BG_Y_SEARCH_PX = 48; // tolerate small post-pagination y remaps when locating a box on the page raster
const PAGE_CROSS_SEARCH_PX = 64; // boxes straddling a page break can legitimately land on an adjacent page after pagination
const BORDER_MATCH_E = 20; // an edge pixel within this ΔE of the wanted color "is" the border
const BORDER_MIN_PRESENCE = 0.1; // <10% of the edge strip showing the border color → missing/wrong
const BORDER_REGION_MISMATCH = 0.12; // if expected/actual edge rasters already match, do not flag color-presence noise
const BORDER_REGION_MISMATCH_ROUNDED = 0.25; // large rounded thin borders antialias more heavily along the edge strip
const SHADOW_LUMA_DROP = 18; // browser band this much darker (0..255) than dompdf → shadow missing
const ICON_MISMATCH = 0.25; // fraction of differing pixels in the icon box
const ICON_PIXEL_DIST = 48; // per-pixel channel-sum distance counted as "different"
const GRID = 24; // max samples per axis when sampling a region

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function med(arr) {
  if (arr.length === 0) return 0;
  arr.sort((a, b) => a - b);
  const mid = arr.length >> 1;
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function parseCssColor(s) {
  if (!s) return null;
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(',').map((x) => parseFloat(x));
  return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length >= 4 ? p[3] : 1 };
}

// CIE76 ΔE in Lab.
function srgbToLin(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
function rgbToLab(r, g, b) {
  const R = srgbToLin(r); const G = srgbToLin(g); const B = srgbToLin(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE(c1, c2) {
  const a = rgbToLab(c1.r, c1.g, c1.b);
  const b = rgbToLab(c2.r, c2.g, c2.b);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
function luma(c) { return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; }
function rgbHex(c) {
  const h = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

// Median color over opaque pixels in a strided sub-rect. Median (not mean) so a few
// text/edge outliers inside the region don't drag the result off the true fill.
function sampleColor(png, rx, ry, rw, rh) {
  const { data, width, height } = png;
  const x0 = clamp(Math.round(rx), 0, width);
  const y0 = clamp(Math.round(ry), 0, height);
  const x1 = clamp(Math.round(rx + rw), 0, width);
  const y1 = clamp(Math.round(ry + rh), 0, height);
  if (x1 <= x0 || y1 <= y0) return null;
  const stepX = Math.max(1, Math.floor((x1 - x0) / GRID));
  const stepY = Math.max(1, Math.floor((y1 - y0) / GRID));
  const rs = []; const gs = []; const bs = [];
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < 8) continue;
      rs.push(data[idx]); gs.push(data[idx + 1]); bs.push(data[idx + 2]);
    }
  }
  if (rs.length === 0) return null;
  return { r: med(rs), g: med(gs), b: med(bs), n: rs.length };
}

function bestVerticalColorSample(png, truth, rx, ry, rw, rh, searchPx) {
  const offsets = [0];
  for (let delta = 2; delta <= searchPx; delta += 2) {
    offsets.push(delta, -delta);
  }
  let best = null;
  for (const offset of offsets) {
    const got = sampleColor(png, rx, ry + offset, rw, rh);
    if (!got) continue;
    const de = deltaE(truth, got);
    if (!best || de < best.de) {
      best = { de, got, offset };
      if (de <= BG_DELTA_E) break;
    }
  }
  return best;
}

function bestVerticalEdgeMatchFraction(png, want, sx, sy, sw, sh, searchPx) {
  const offsets = [0];
  for (let delta = 2; delta <= searchPx; delta += 2) {
    offsets.push(delta, -delta);
  }
  let best = null;
  for (const offset of offsets) {
    const frac = colorMatchFraction(png, sx, sy + offset, sw, sh, want, BORDER_MATCH_E);
    if (frac == null) continue;
    if (!best || frac > best.frac) {
      best = { frac, offset };
      if (frac >= BORDER_MIN_PRESENCE) break;
    }
  }
  return best;
}

// Fraction of opaque pixels in a rect whose color is within `matchE` ΔE of `want`.
// Used for borders: a thin colored border scaled down + antialiased washes out any
// median, so instead we ask "does the wanted border color appear along this edge?".
function colorMatchFraction(png, rx, ry, rw, rh, want, matchE) {
  const { data, width, height } = png;
  const x0 = clamp(Math.round(rx), 0, width);
  const y0 = clamp(Math.round(ry), 0, height);
  const x1 = clamp(Math.round(rx + rw), 0, width);
  const y1 = clamp(Math.round(ry + rh), 0, height);
  if (x1 <= x0 || y1 <= y0) return null;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 64));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 64));
  let total = 0; let hit = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < 8) continue;
      total += 1;
      if (deltaE(want, { r: data[idx], g: data[idx + 1], b: data[idx + 2] }) < matchE) hit += 1;
    }
  }
  return total === 0 ? null : hit / total;
}

function borderRadiiPx(el, scale, iw, ih) {
  const raw = Array.isArray(el?.borderRadius) ? el.borderRadius : [0, 0, 0, 0];
  const maxR = Math.max(0, Math.min(iw, ih) / 2);
  return raw.map((v) => clamp(Math.round((Number(v) || 0) * scale), 0, maxR));
}

function trimBorderSampleRect(side, rect, radii) {
  let { sx, sy, sw, sh } = rect;
  const [rtl, rtr, rbr, rbl] = radii;
  if (side === 'top') {
    const trimL = Math.max(0, Math.round(rtl * 0.8));
    const trimR = Math.max(0, Math.round(rtr * 0.8));
    sx += trimL;
    sw -= trimL + trimR;
  } else if (side === 'bottom') {
    const trimL = Math.max(0, Math.round(rbl * 0.8));
    const trimR = Math.max(0, Math.round(rbr * 0.8));
    sx += trimL;
    sw -= trimL + trimR;
  } else if (side === 'left') {
    const trimT = Math.max(0, Math.round(rtl * 0.8));
    const trimB = Math.max(0, Math.round(rbl * 0.8));
    sy += trimT;
    sh -= trimT + trimB;
  } else if (side === 'right') {
    const trimT = Math.max(0, Math.round(rtr * 0.8));
    const trimB = Math.max(0, Math.round(rbr * 0.8));
    sy += trimT;
    sh -= trimT + trimB;
  }
  return { sx, sy, sw, sh };
}

function borderRegionMismatchThreshold(radii, spec) {
  const maxRadius = Math.max(...radii, 0);
  const borderWidth = Number(spec?.width) || 0;
  if (maxRadius >= 10 && borderWidth <= 1.5) {
    return BORDER_REGION_MISMATCH_ROUNDED;
  }
  return BORDER_REGION_MISMATCH;
}

// Fraction of differing pixels between the two normalized rasters within a rect.
function regionMismatch(expPng, actPng, rx, ry, rw, rh) {
  const width = Math.min(expPng.width, actPng.width);
  const height = Math.min(expPng.height, actPng.height);
  const x0 = clamp(Math.round(rx), 0, width);
  const y0 = clamp(Math.round(ry), 0, height);
  const x1 = clamp(Math.round(rx + rw), 0, width);
  const y1 = clamp(Math.round(ry + rh), 0, height);
  if (x1 <= x0 || y1 <= y0) return null;
  const stepX = Math.max(1, Math.floor((x1 - x0) / 48));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 48));
  let total = 0; let diff = 0;
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const idx = (y * width + x) * 4;
      total += 1;
      const d = Math.abs(expPng.data[idx] - actPng.data[idx])
        + Math.abs(expPng.data[idx + 1] - actPng.data[idx + 1])
        + Math.abs(expPng.data[idx + 2] - actPng.data[idx + 2]);
      if (d > ICON_PIXEL_DIST) diff += 1;
    }
  }
  return total === 0 ? null : diff / total;
}

// Element (root-css-px) → page index + slice start, using the page-break positions.
function pageForY(y, meta) {
  const breaks = Array.isArray(meta.pageBreaks) ? meta.pageBreaks : [];
  for (let i = 0; i < breaks.length; i += 1) {
    if (y < breaks[i]) return { index: i, sliceStart: i === 0 ? 0 : breaks[i - 1] };
  }
  return { index: breaks.length, sliceStart: breaks.length ? breaks[breaks.length - 1] : 0 };
}

function sliceStartForPage(index, meta) {
  const breaks = Array.isArray(meta?.pageBreaks) ? meta.pageBreaks : [];
  if (index <= 0) return 0;
  if (index - 1 < breaks.length) return breaks[index - 1] || 0;
  return breaks.length ? breaks[breaks.length - 1] : 0;
}

function pageCandidateIndices(y, h, meta, pageCount) {
  const breaks = Array.isArray(meta?.pageBreaks) ? meta.pageBreaks : [];
  const primary = pageForY(y, meta).index;
  const out = [];
  const push = (idx) => {
    if (idx < 0 || idx >= pageCount || out.includes(idx)) return;
    out.push(idx);
  };
  push(primary);
  if (primary < breaks.length && y + h >= (breaks[primary] - PAGE_CROSS_SEARCH_PX)) {
    push(primary + 1);
  }
  if (primary > 0 && y <= (breaks[primary - 1] + PAGE_CROSS_SEARCH_PX)) {
    push(primary - 1);
  }
  return out;
}

export function diffVisuals({ elements, pixelPages, meta, metrics }) {
  const els = Array.isArray(elements) ? elements : [];
  const pages = Array.isArray(pixelPages) ? pixelPages : [];
  const scale = metrics.layoutScale || 1;
  const counts = { 'bg-color': 0, border: 0, shadow: 0, icon: 0 };
  const discrepancies = [];
  const deltaEs = [];

  // Decode each page's rasters once.
  const decoded = pages.map((p) => ({
    expected: p.expectedBuffer ? PNG.sync.read(p.expectedBuffer) : null,
    actual: p.actualBuffer ? PNG.sync.read(p.actualBuffer) : null,
  }));

  for (const el of els) {
    const { index, sliceStart } = pageForY(el.y, meta);
    if (index >= decoded.length) continue; // element on a page we did not rasterize
    const { expected, actual } = decoded[index];
    if (!actual) continue;

    // Map the element box into normalized page-image px.
    const ix = el.x * scale;
    const iy = (el.y - sliceStart) * scale;
    const iw = el.w * scale;
    const ih = el.h * scale;
    if (iw < 2 || ih < 2) continue;
    const box = { x: round(el.x), y: round(el.y), w: round(el.w), h: round(el.h) };
    const base = { nodeId: el.nodeId, tag: el.tag, box, page: index + 1 };

    // bg-color — only opaque backgrounds, and not on icon/image elements (their
    // painted image content covers the background, so the box interior is the image,
    // not the declared background-color).
    const bg = parseCssColor(el.backgroundColor);
    if (bg && bg.a >= 0.95 && !el.isIcon) {
      const inset = 0.25;
      const rx = ix + iw * inset;
      const ry = iy + ih * inset;
      const rw = iw * (1 - 2 * inset);
      const rh = ih * (1 - 2 * inset);
      let got = sampleColor(actual, rx, ry, rw, rh);
      // Ground truth is the BROWSER raster, not the declared CSS color. A child box,
      // a gradient/image layer, or an ancestor's overflow:hidden legitimately changes
      // the rendered interior — and the browser shows the very same thing the PDF does.
      // Comparing against the declared color flags those composited/clipped boxes as
      // false positives (e.g. a progress track covered by its fill, a clipped child).
      // Only flag when the PDF interior actually diverges from the browser interior.
      // (Fall back to the declared color only when no browser raster is available.)
      const ref = expected ? sampleColor(expected, rx, ry, rw, rh) : null;
      if (ref && deltaE(ref, bg) > BG_DECLARED_VISIBILITY_E) continue;
      const truth = ref || bg;
      if (got) {
        let de = deltaE(truth, got);
        if (de > BG_DELTA_E && Array.isArray(meta?.pageBreaks) && meta.pageBreaks.length > 0) {
          const best = bestVerticalColorSample(actual, truth, rx, ry, rw, rh, BG_Y_SEARCH_PX);
          if (best && best.de < de) {
            got = best.got;
            de = best.de;
          }
        }
        if (de > BG_DELTA_E) {
          counts['bg-color'] += 1;
          deltaEs.push(de);
          discrepancies.push({
            ...base,
            kind: 'bg-color',
            expected: rgbHex(truth),
            actual: rgbHex(got),
            delta: { deltaE: round(de), declared: rgbHex(bg) },
          });
        }
      }
    }

    // border — does the wanted border color actually appear along each edge strip
    // in the dompdf raster? Report the side where it is most absent.
    if (el.border) {
      let worst = null;
      const radii = borderRadiiPx(el, scale, iw, ih);
      const candidatePages = pageCandidateIndices(el.y, el.h, meta, decoded.length);
      for (const [side, spec] of Object.entries(el.border)) {
        const want = parseCssColor(spec.color);
        if (!want) continue;
        const t = Math.max(2, Math.min(8, Math.round((spec.width || 1) * scale) + 2));
        let bestHit = null;
        for (const candidateIndex of candidatePages) {
          const cand = decoded[candidateIndex];
          if (!cand?.actual) continue;
          const candidateSliceStart = sliceStartForPage(candidateIndex, meta);
          const candidateIy = (el.y - candidateSliceStart) * scale;
          let sx = ix; let sy = candidateIy; let sw = iw; let sh = ih;
          if (side === 'top') { sh = t; }
          else if (side === 'bottom') { sy = candidateIy + ih - t; sh = t; }
          else if (side === 'left') { sw = t; }
          else if (side === 'right') { sx = ix + iw - t; sw = t; }
          ({ sx, sy, sw, sh } = trimBorderSampleRect(side, { sx, sy, sw, sh }, radii));
          // Tiny circular markers (e.g. 12x12 timeline dots) and heavily rounded
          // corners do not have a meaningful straight-edge strip to sample; their
          // top edge is mostly antialiasing, so treat them as non-actionable here.
          if (sw < Math.max(3, t) || sh < Math.max(3, t)) continue;
          let frac = colorMatchFraction(cand.actual, sx, sy, sw, sh, want, BORDER_MATCH_E);
          if (frac != null && frac < BORDER_MIN_PRESENCE && Array.isArray(meta?.pageBreaks) && meta.pageBreaks.length > 0) {
            const best = bestVerticalEdgeMatchFraction(cand.actual, want, sx, sy, sw, sh, BG_Y_SEARCH_PX);
            if (best && best.frac > frac) frac = best.frac;
          }
          if (frac == null) continue;
          if (cand.expected) {
            const fracExp = colorMatchFraction(cand.expected, sx, sy, sw, sh, want, BORDER_MATCH_E);
            if (fracExp == null || fracExp < BORDER_MIN_PRESENCE) continue;
            const edgeMismatch = regionMismatch(cand.expected, cand.actual, sx, sy, sw, sh);
            const mismatchThreshold = borderRegionMismatchThreshold(radii, spec);
            if (edgeMismatch != null && edgeMismatch <= mismatchThreshold) continue;
          }
          if (!bestHit || frac > bestHit.frac) {
            bestHit = { frac, page: candidateIndex + 1 };
          }
        }
        if (!bestHit || bestHit.frac >= BORDER_MIN_PRESENCE) continue;
        if (!worst || bestHit.frac < worst.frac) {
          worst = { frac: bestHit.frac, side, want, page: bestHit.page };
        }
      }
      if (worst) {
        counts.border += 1;
        discrepancies.push({
          ...base,
          page: worst.page || base.page,
          kind: 'border',
          side: worst.side,
          expected: rgbHex(worst.want),
          actual: `border color present in ${Math.round(worst.frac * 100)}% of edge`,
          delta: { presence: round(worst.frac) },
        });
      }
    }

    // shadow — browser darkens a band just outside the box; if dompdf does not,
    // the band's luminance stays higher on the actual side. Real gap when dompdf
    // omits box-shadow entirely.
    if (el.boxShadow && expected) {
      const bandPx = Math.max(2, Math.round(6 * scale));
      const bandX = ix;
      const bandY = iy + ih; // just below the box
      const bandW = iw;
      const expBand = sampleColor(expected, bandX, bandY, bandW, bandPx);
      const actBand = sampleColor(actual, bandX, bandY, bandW, bandPx);
      if (expBand && actBand) {
        const drop = luma(actBand) - luma(expBand); // browser darker → positive
        if (drop > SHADOW_LUMA_DROP) {
          counts.shadow += 1;
          discrepancies.push({
            ...base,
            kind: 'shadow',
            expected: `shadow band luma ${round(luma(expBand))}`,
            actual: `flat band luma ${round(luma(actBand))}`,
            delta: { lumaDrop: round(drop) },
            note: 'Browser paints a shadow the dompdf raster lacks (dompdf may not render box-shadow).',
          });
        }
      }
    }

    // icon — localized expected-vs-actual mismatch inside the icon box.
    if (el.isIcon && expected) {
      const ratio = regionMismatch(expected, actual, ix, iy, iw, ih);
      if (ratio != null && ratio > ICON_MISMATCH) {
        counts.icon += 1;
        discrepancies.push({
          ...base,
          kind: 'icon',
          expected: 'icon rendered in browser',
          actual: `${Math.round(ratio * 100)}% of icon box differs`,
          delta: { mismatchRatio: round(ratio) },
        });
      }
    }
  }

  return {
    summary: {
      elementCount: els.length,
      comparedPages: decoded.length,
      counts,
      discrepancyCount: discrepancies.length,
      meanDeltaE: deltaEs.length ? round(deltaEs.reduce((s, v) => s + v, 0) / deltaEs.length) : 0,
    },
    discrepancies,
  };
}

function round(v) { return Math.round(v * 100) / 100; }
