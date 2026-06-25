import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { roundSize } from './layout.mjs';

// Tier 1 — pixel-level diff between the headless screenshot (expected) and the
// dompdf PDF raster (actual), normalized to the same content box. Coarse metric
// only; Tier 2 is the locatable signal.
export function diffImages(expectedBuffer, actualBuffer, threshold) {
  const expectedPng = PNG.sync.read(expectedBuffer);
  const actualPng = PNG.sync.read(actualBuffer);
  const width = Math.min(expectedPng.width, actualPng.width);
  const height = Math.min(expectedPng.height, actualPng.height);
  const expected = new PNG({ width, height });
  const actual = new PNG({ width, height });
  PNG.bitblt(expectedPng, expected, 0, 0, width, height, 0, 0);
  PNG.bitblt(actualPng, actual, 0, 0, width, height, 0, 0);
  const diff = new PNG({ width, height });
  const mismatchPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, {
    includeAA: false,
    threshold,
  });
  return {
    diffBuffer: PNG.sync.write(diff),
    height,
    mismatchPixels,
    mismatchRatio: width * height > 0 ? mismatchPixels / (width * height) : 0,
    width,
  };
}

// Crop the PDF page raster down to the content box (drop margins/header/footer)
// and scale to the content width so it lines up with the headless screenshot.
export async function normalizePdfContentImage(pdfPageBuffer, metrics) {
  const image = await loadImage(pdfPageBuffer);
  const targetWidth = roundSize(metrics.contentWidthPx);
  const targetHeight = roundSize(metrics.contentHeightPx);
  const cropX = metrics.marginLeftPx;
  const cropY = metrics.marginTopPx + metrics.headerHeightPx;
  const cropWidth = metrics.contentWidthPx;
  const cropHeight = metrics.contentHeightPx;
  const scaleX = image.width / metrics.pageWidthPx;
  const scaleY = image.height / metrics.pageHeightPx;
  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetWidth, targetHeight);
  context.drawImage(
    image,
    cropX * scaleX,
    cropY * scaleY,
    cropWidth * scaleX,
    cropHeight * scaleY,
    0,
    0,
    targetWidth,
    targetHeight,
  );
  return canvas.toBuffer('image/png');
}

// Slice the headless screenshot (full node height) into per-page expected images
// using the page-break positions, so each page compares against the matching slice.
export async function createExpectedPageImage(htmlScreenshotBuffer, meta, metrics, pageIndex) {
  const image = await loadImage(htmlScreenshotBuffer);
  const targetWidth = roundSize(metrics.contentWidthPx);
  const targetHeight = roundSize(metrics.contentHeightPx);
  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, targetWidth, targetHeight);

  const pageBreaks = Array.isArray(meta.pageBreaks) ? meta.pageBreaks : [];
  const sourceStartCss = pageIndex === 0 ? 0 : pageBreaks[pageIndex - 1] || 0;
  const sourceEndCss = pageIndex < pageBreaks.length ? pageBreaks[pageIndex] : meta.rootHeightPx;
  const sourceHeightCss = Math.max(0, sourceEndCss - sourceStartCss);
  const htmlScaleY = image.height / meta.rootHeightPx;
  const outputHeight = Math.min(targetHeight, Math.round(sourceHeightCss * metrics.layoutScale));

  if (outputHeight > 0) {
    context.drawImage(
      image,
      0,
      sourceStartCss * htmlScaleY,
      image.width,
      sourceHeightCss * htmlScaleY,
      0,
      0,
      targetWidth,
      outputHeight,
    );
  }
  return canvas.toBuffer('image/png');
}

export async function pixelDiffPages({
  htmlScreenshotBuffer,
  renderedPages,
  meta,
  metrics,
  threshold,
  outDir,
  pageLimit = 0,
}) {
  const totalPages = pageLimit > 0 ? Math.min(pageLimit, renderedPages.numPages) : renderedPages.numPages;
  const pages = [];
  for (let i = 0; i < totalPages; i += 1) {
    const expectedBuffer = await createExpectedPageImage(htmlScreenshotBuffer, meta, metrics, i);
    const actualBuffer = await normalizePdfContentImage(renderedPages.pages[i].buffer, metrics);
    const diffResult = diffImages(expectedBuffer, actualBuffer, threshold);
    if (outDir) {
      writeFileSync(resolve(outDir, `expected-page-${i + 1}.png`), expectedBuffer);
      writeFileSync(resolve(outDir, `actual-page-${i + 1}.png`), actualBuffer);
      writeFileSync(resolve(outDir, `diff-page-${i + 1}.png`), diffResult.diffBuffer);
    }
    pages.push({
      pageNumber: i + 1,
      mismatchPixels: diffResult.mismatchPixels,
      mismatchRatio: diffResult.mismatchRatio,
      size: { height: diffResult.height, width: diffResult.width },
    });
  }
  const aggregateMismatchRatio = pages.length > 0
    ? pages.reduce((sum, item) => sum + item.mismatchRatio, 0) / pages.length
    : 0;
  const maxMismatchRatio = pages.reduce((max, item) => Math.max(max, item.mismatchRatio), 0);
  return { pages, comparedPages: totalPages, aggregateMismatchRatio, maxMismatchRatio };
}
