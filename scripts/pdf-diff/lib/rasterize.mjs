import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { roundSize } from './layout.mjs';

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }

  reset(target, width, height) {
    target.canvas.width = width;
    target.canvas.height = height;
  }

  destroy(target) {
    target.canvas.width = 0;
    target.canvas.height = 0;
  }
}

// Tier 1 — rasterize a PDF buffer to per-page PNGs via pdfjs.
export async function rasterizePdf(pdfBuffer, scale, outDir) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const pageBuffers = [];
  const canvasFactory = new NodeCanvasFactory();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const { canvas, context } = canvasFactory.create(roundSize(viewport.width), roundSize(viewport.height));
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, canvasFactory, viewport }).promise;
    const pngBuffer = canvas.toBuffer('image/png');
    if (outDir) {
      const filePath = resolve(outDir, `pdf-page-${pageNumber}.png`);
      writeFileSync(filePath, pngBuffer);
      pageBuffers.push({ buffer: pngBuffer, filePath, pageNumber });
    } else {
      pageBuffers.push({ buffer: pngBuffer, filePath: null, pageNumber });
    }
  }
  await loadingTask.destroy();
  return { numPages: pdf.numPages, pages: pageBuffers };
}

// Tier 2 helper — extract structured text via pdfjs getTextContent.
export async function extractPdfTextItems(pdfBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const items = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (typeof item.str !== 'string' || item.str.length === 0) continue;
      const tr = item.transform; // [a, b, c, d, e, f]
      const fontSize = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]) || item.height || 0;
      // pdfjs transform is in PDF units (pt); e,f are the baseline origin in pt.
      items.push({
        str: item.str,
        x: tr[4],
        y: tr[5],
        w: item.width,
        h: item.height,
        fontSize,
        fontName: item.fontName,
        page: pageNumber,
        // viewport height lets callers convert pdfjs bottom-origin y to top-origin.
        pageHeightPt: viewport.viewBox[3] || viewport.height,
      });
    }
  }
  await loadingTask.destroy();
  return items;
}
