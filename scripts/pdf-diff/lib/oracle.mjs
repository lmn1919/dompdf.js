import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { base64ToBuffer } from './fs-util.mjs';
import { withTimeout } from './fs-util.mjs';
import {
  ensureAutomationBridge,
  normalizeTargetFonts,
  hideOverlaysForLocatorScreenshot,
  captureLocatorScreenshot,
} from './bridge.mjs';

// Tier 0 — collect the reference pair + structured HTML/CSS oracle for one corpus entry.
//
// Produces:
//   actual.pdf  — dompdf export (single tall page, pagination:false)
//   ref.pdf     — Chromium headless print of the same node (archival "headless PDF")
//   html-source.png — cropped headless screenshot of the node (Tier 1 pixel reference)
//   oracle.json — Range.getClientRects() text boxes in document space (Tier 2 ground truth)
//   inspect.txt — dompdf's own internal layout tree (cross-check)
//
// All three text sources (actual/ref/oracle) share the injected CJK font so font
// differences are not noise.
export async function collectOracle({
  page,
  selector,
  distBundleSource,
  defaultFontConfig,
  removeSelectors = [],
  exportTimeoutMs = 120000,
  inspectTimeoutMs = 20000,
  skipInspect = false,
}) {
  await page.addStyleTag({
    content: '* { animation: none !important; transition: none !important; caret-color: transparent !important; }',
  });

  await ensureAutomationBridge(page, selector, distBundleSource, defaultFontConfig);
  const normalizedFont = await normalizeTargetFonts(page, selector, defaultFontConfig);

  await page.waitForFunction(() => Boolean(window.__DOMPDF_AUTOMATION__), undefined, { timeout: 10000 });

  if (removeSelectors.length > 0) {
    await page.evaluate((rs) => window.__DOMPDF_AUTOMATION__.prepare({ removeSelectors: rs }), removeSelectors);
  }

  const readiness = await page.evaluate(() => window.__DOMPDF_AUTOMATION__.ready());

  let inspectText = 'inspect skipped';
  if (!skipInspect) {
    try {
      inspectText = await withTimeout(
        page.evaluate(() => window.__DOMPDF_AUTOMATION__.inspect()),
        inspectTimeoutMs,
        'inspect',
      );
    } catch (error) {
      inspectText = `inspect failed: ${error.message}`;
    }
  }

  const exportResult = await withTimeout(
    page.evaluate(() => window.__DOMPDF_AUTOMATION__.exportPdf()),
    exportTimeoutMs,
    'exportPdf',
  );
  const meta = exportResult.meta;
  meta.selector = meta.selector || selector;

  const actualPdfBuffer = base64ToBuffer(exportResult.pdfBase64);

  // Range-API text boxes: the browser's own layout as ground truth.
  const oracle = await page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof Element)) {
      throw new Error(`Target selector not found for oracle: ${targetSelector}`);
    }
    const targetRect = target.getBoundingClientRect();
    const rootLeft = targetRect.left + window.scrollX;
    const rootTop = targetRect.top + window.scrollY;

    const boxes = [];
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const range = document.createRange();
    let nodeIdSeq = 0;
    let textNode;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      const style = getComputedStyle(parent);
      const fontSize = parseFloat(style.fontSize) || 0;
      const fontFamily = (style.fontFamily || '').split(',')[0].replace(/^["']|["']$/g, '').trim();
      const fontWeight = style.fontWeight;
      const color = style.color;
      const nodeId = `t${nodeIdSeq += 1}`;

      const text = textNode.nodeValue;
      // Walk word by word so each box is a meaningful text run the PDF can be aligned to.
      const tokens = text.match(/\S+\s*/g) || [];
      let offset = 0;
      for (const token of tokens) {
        const start = text.indexOf(token, offset);
        if (start < 0) break;
        const end = start + token.length;
        offset = end;
        try {
          range.setStart(textNode, start);
          range.setEnd(textNode, end);
        } catch (e) {
          continue;
        }
        const rects = range.getClientRects();
        for (const rect of rects) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          boxes.push({
            nodeId,
            text: token,
            // Document-space absolute coords...
            absX: rect.left + window.scrollX,
            absY: rect.top + window.scrollY,
            // ...and coords relative to the target root (aligns with PDF content space).
            x: rect.left + window.scrollX - rootLeft,
            y: rect.top + window.scrollY - rootTop,
            w: rect.width,
            h: rect.height,
            fontSize,
            fontFamily,
            fontWeight,
            color,
          });
        }
      }
    }

    // Element-level visual boxes: backgrounds, borders, box-shadows, icons.
    // These are the ground truth for the non-text (Tier 2b) visual diff. Only
    // elements that actually carry a visual property of interest are kept, so the
    // list stays small even on large pages.
    const colorAlpha = (c) => {
      if (!c || c === 'transparent') return 0;
      const m = c.match(/rgba?\(([^)]+)\)/i);
      if (!m) return 1;
      const parts = m[1].split(',').map((s) => parseFloat(s));
      return parts.length >= 4 ? parts[3] : 1;
    };
    const pseudoIsIcon = (el, which) => {
      const ps = getComputedStyle(el, which);
      if (!ps) return false;
      const content = ps.content;
      const hasContent = content && !['none', 'normal', '""', "''"].includes(content);
      const hasBgImg = ps.backgroundImage && ps.backgroundImage !== 'none';
      return Boolean(hasContent || hasBgImg);
    };

    const elements = [];
    const ELEMENT_CAP = 800;
    const rootArea = targetRect.width * targetRect.height || 1;
    for (const el of target.querySelectorAll('*')) {
      if (elements.length >= ELEMENT_CAP) break;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      // Skip elements that span (almost) the whole root — their "background" is
      // really the page background and would swamp the per-element signal.
      if (rect.width * rect.height >= rootArea * 0.95) continue;

      const bg = style.backgroundColor;
      const hasBg = colorAlpha(bg) > 0.01;

      const sides = ['Top', 'Right', 'Bottom', 'Left'];
      const border = {};
      let hasBorder = false;
      for (const s of sides) {
        const width = parseFloat(style[`border${s}Width`]) || 0;
        const bStyle = style[`border${s}Style`];
        const bColor = style[`border${s}Color`];
        if (width > 0 && bStyle !== 'none' && colorAlpha(bColor) > 0.01) {
          border[s.toLowerCase()] = { width, color: bColor };
          hasBorder = true;
        }
      }

      const boxShadow = style.boxShadow;
      const hasShadow = boxShadow && boxShadow !== 'none';

      const tag = el.tagName.toUpperCase();
      const isIcon = tag === 'IMG' || tag === 'SVG'
        || (style.backgroundImage && style.backgroundImage !== 'none')
        || pseudoIsIcon(el, '::before') || pseudoIsIcon(el, '::after');

      if (!hasBg && !hasBorder && !hasShadow && !isIcon) continue;

      elements.push({
        nodeId: `e${elements.length + 1}`,
        tag,
        x: rect.left + window.scrollX - rootLeft,
        y: rect.top + window.scrollY - rootTop,
        w: rect.width,
        h: rect.height,
        backgroundColor: hasBg ? bg : null,
        border: hasBorder ? border : null,
        boxShadow: hasShadow ? boxShadow : null,
        isIcon: Boolean(isIcon),
      });
    }

    return {
      selector: targetSelector,
      root: {
        left: rootLeft,
        top: rootTop,
        width: targetRect.width,
        height: targetRect.height,
      },
      devicePixelRatio: window.devicePixelRatio || 1,
      boxes,
      elements,
    };
  }, meta.selector);

  // ref.pdf — Chromium headless print. Best-effort: prints the whole document page;
  // archived as the "headless browser PDF". Pixel diff uses html-source.png instead.
  let refPdfBuffer = null;
  try {
    refPdfBuffer = await page.pdf({
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      width: `${Math.round(oracle.root.width)}px`,
      height: `${Math.round(oracle.root.height)}px`,
    });
  } catch (error) {
    refPdfBuffer = null;
  }

  const overlayInfo = await hideOverlaysForLocatorScreenshot(page, meta.selector);
  const htmlScreenshotBuffer = await captureLocatorScreenshot(page, meta.selector);

  return {
    actualPdfBuffer,
    refPdfBuffer,
    htmlScreenshotBuffer,
    oracle,
    inspectText,
    meta,
    readiness,
    normalizedFont,
    overlayHiddenCount: overlayInfo.hiddenCount,
  };
}

export function writeOracleArtifacts(outDir, oracle) {
  writeFileSync(resolve(outDir, 'actual.pdf'), oracle.actualPdfBuffer);
  if (oracle.refPdfBuffer) writeFileSync(resolve(outDir, 'ref.pdf'), oracle.refPdfBuffer);
  writeFileSync(resolve(outDir, 'html-source.png'), oracle.htmlScreenshotBuffer);
  writeFileSync(resolve(outDir, 'oracle.json'), JSON.stringify(oracle.oracle, null, 2));
  writeFileSync(resolve(outDir, 'inspect.txt'), String(oracle.inspectText), 'utf8');
}
