import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createCanvas, DOMMatrix, ImageData, loadImage, Path2D } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const defaultOutDir = resolve(rootDir, 'tmp', 'pdf-diff-mvp', new Date().toISOString().replace(/[:.]/g, '-'));
const defaultChineseFontPath = resolve(rootDir, 'examples', 'SourceHanSansSC-Regular.ttf');
const injectedCjkFontFamily = 'DompdfAutoCJK';
const PX_TO_PT = 0.75;
const PT_TO_PX = 1 / PX_TO_PT;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const PAGE_SIZES = {
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

if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix;
if (!globalThis.ImageData) globalThis.ImageData = ImageData;
if (!globalThis.Path2D) globalThis.Path2D = Path2D;

function parseArgs(argv) {
  const options = {
    cssSelector: '',
    exportTimeoutMs: 120000,
    inspectTimeoutMs: 20000,
    outDir: defaultOutDir,
    pageLimit: 0,
    port: 4173,
    removeSelectors: [],
    skipInspect: false,
    strictSelector: false,
    threshold: 0.1,
    url: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url' && next) {
      options.url = next;
      i += 1;
    } else if ((arg === '--css-selector' || arg === '--target-selector' || arg === '--selector') && next) {
      options.cssSelector = next;
      options.strictSelector = true;
      i += 1;
    } else if ((arg === '--remove' || arg === '--remove-selectors') && next) {
      options.removeSelectors = next
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      i += 1;
    } else if (arg === '--out-dir' && next) {
      options.outDir = resolve(next);
      i += 1;
    } else if (arg === '--port' && next) {
      options.port = Number(next) || options.port;
      i += 1;
    } else if (arg === '--page-limit' && next) {
      options.pageLimit = Number(next) || 0;
      i += 1;
    } else if (arg === '--threshold' && next) {
      options.threshold = Number(next) || options.threshold;
      i += 1;
    } else if (arg === '--inspect-timeout-ms' && next) {
      options.inspectTimeoutMs = Math.max(1, Number(next) || options.inspectTimeoutMs);
      i += 1;
    } else if (arg === '--export-timeout-ms' && next) {
      options.exportTimeoutMs = Math.max(1, Number(next) || options.exportTimeoutMs);
      i += 1;
    } else if (arg === '--skip-inspect') {
      options.skipInspect = true;
    }
  }
  return options;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function base64ToBuffer(base64) {
  return Buffer.from(base64, 'base64');
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function normalizeMarginPt(marginPt) {
  if (Array.isArray(marginPt)) {
    return [marginPt[0] ?? 36, marginPt[1] ?? 36, marginPt[2] ?? 36, marginPt[3] ?? 36];
  }
  const value = typeof marginPt === 'number' ? marginPt : 36;
  return [value, value, value, value];
}

function resolvePageSizePt(options) {
  if (typeof options.pageWidthPt === 'number' && typeof options.pageHeightPt === 'number') {
    return [options.pageWidthPt, options.pageHeightPt];
  }
  const format = Array.isArray(options.format) ? options.format : String(options.format || 'a4').toLowerCase();
  if (Array.isArray(format) && format.length === 2) return format;
  return PAGE_SIZES[format] || PAGE_SIZES.a4;
}

function computeLayoutScale(rootWidthPx, pageWidthPt, marginLeftPt, marginRightPt) {
  if (!(rootWidthPx > 0)) return 1;
  const contentWidthPx = Math.max(1, (pageWidthPt - marginLeftPt - marginRightPt) / PX_TO_PT);
  return Math.min(1, contentWidthPx / rootWidthPx);
}

function computeLayoutMetrics(meta) {
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

function roundSize(value) {
  return Math.max(1, Math.round(value));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function startStaticServer(baseDir, port) {
  const server = createServer((req, res) => {
    const requestPath = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).pathname;
    const relativePath = requestPath === '/' ? '/examples/index.html' : requestPath;
    const localPath = normalize(resolve(baseDir, `.${relativePath}`));
    if (!localPath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(localPath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const stats = statSync(localPath);
    const filePath = stats.isDirectory() ? join(localPath, 'index.html') : localPath;
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(port, '127.0.0.1', () => {
      resolveServer({
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext('2d'),
    };
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

async function renderPdfPages(pdfBuffer, scale, outDir) {
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
    await page.render({
      canvasContext: context,
      canvasFactory,
      viewport,
    }).promise;
    const pngBuffer = canvas.toBuffer('image/png');
    const filePath = resolve(outDir, `pdf-page-${pageNumber}.png`);
    writeFileSync(filePath, pngBuffer);
    pageBuffers.push({ buffer: pngBuffer, filePath, pageNumber });
  }
  await loadingTask.destroy();
  return {
    numPages: pdf.numPages,
    pages: pageBuffers,
  };
}

async function normalizePdfContentImage(pdfPageBuffer, metrics) {
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

async function createExpectedPageImage(htmlScreenshotBuffer, meta, metrics, pageIndex) {
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
  const htmlScaleX = image.width / meta.rootWidthPx;
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

function diffImages(expectedBuffer, actualBuffer, threshold) {
  const expectedPng = PNG.sync.read(expectedBuffer);
  const actualPng = PNG.sync.read(actualBuffer);
  const width = Math.min(expectedPng.width, actualPng.width);
  const height = Math.min(expectedPng.height, actualPng.height);
  const expected = new PNG({ width, height });
  const actual = new PNG({ width, height });
  PNG.bitblt(expectedPng, expected, 0, 0, width, height, 0, 0);
  PNG.bitblt(actualPng, actual, 0, 0, width, height, 0, 0);
  const diff = new PNG({ width, height });
  const mismatchPixels = pixelmatch(
    expected.data,
    actual.data,
    diff.data,
    width,
    height,
    {
      includeAA: false,
      threshold,
    },
  );
  return {
    diffBuffer: PNG.sync.write(diff),
    height,
    mismatchPixels,
    mismatchRatio: width * height > 0 ? mismatchPixels / (width * height) : 0,
    width,
  };
}

function withTimeout(promise, timeoutMs, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

async function hideOverlaysForLocatorScreenshot(page, selector) {
  return page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof Element)) {
      return { hiddenCount: 0 };
    }
    const protectedNodes = new Set();
    let cursor = target;
    while (cursor) {
      protectedNodes.add(cursor);
      cursor = cursor.parentElement;
    }
    protectedNodes.add(target);
    for (const node of target.querySelectorAll('*')) {
      protectedNodes.add(node);
    }

    const hidden = [];
    const allElements = Array.from(document.body.querySelectorAll('*'));
    for (const el of allElements) {
      if (!(el instanceof HTMLElement)) continue;
      if (protectedNodes.has(el)) continue;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      hidden.push({
        el,
        pointerEvents: el.style.pointerEvents,
        visibility: el.style.visibility,
      });
      el.style.visibility = 'hidden';
      el.style.pointerEvents = 'none';
    }

    return { hiddenCount: hidden.length };
  }, selector);
}

async function waitForPaintAfterScroll(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 50);
      });
    });
  }));
}

async function captureLocatorScreenshot(page, selector) {
  const locator = page.locator(selector);
  await locator.scrollIntoViewIfNeeded();
  await waitForPaintAfterScroll(page);

  const targetRect = await page.evaluate((targetSelector) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof Element)) {
      throw new Error(`Target selector not found for screenshot: ${targetSelector}`);
    }

    function findScrollableAncestor(node) {
      let cursor = node.parentElement;
      while (cursor) {
        const style = getComputedStyle(cursor);
        const overflowY = style.overflowY;
        if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
          && cursor.scrollHeight > cursor.clientHeight + 1) {
          return cursor;
        }
        cursor = cursor.parentElement;
      }
      return null;
    }

    const rect = target.getBoundingClientRect();
    const scroller = findScrollableAncestor(target);
    return {
      height: rect.height,
      left: rect.left + window.scrollX,
      scrollContainerHeight: scroller?.clientHeight || 0,
      top: rect.top + window.scrollY,
      width: rect.width,
    };
  }, selector);

  const clipY = Math.max(0, targetRect.top);
  const clipWidth = roundSize(targetRect.width);
  const clipHeight = roundSize(targetRect.height);
  const canvas = createCanvas(clipWidth, clipHeight);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, clipWidth, clipHeight);

  const viewport = page.viewportSize() || { height: 1200, width: 1440 };
  const desiredViewportTop = 32;
  const maxSliceHeight = Math.max(
    256,
    (targetRect.scrollContainerHeight || viewport.height) - desiredViewportTop * 2,
  );

  for (let offsetY = 0; offsetY < clipHeight; offsetY += maxSliceHeight) {
    const sliceHeight = Math.min(maxSliceHeight, clipHeight - offsetY);
    await page.evaluate(({ desiredOffsetTop, offset, targetSelector }) => {
      const target = document.querySelector(targetSelector);
      if (!(target instanceof Element)) {
        throw new Error(`Target selector not found for screenshot: ${targetSelector}`);
      }

      function findScrollableAncestor(node) {
        let cursor = node.parentElement;
        while (cursor) {
          const style = getComputedStyle(cursor);
          const overflowY = style.overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
            && cursor.scrollHeight > cursor.clientHeight + 1) {
            return cursor;
          }
          cursor = cursor.parentElement;
        }
        return null;
      }

      const scroller = findScrollableAncestor(target);
      if (scroller) {
        const targetBox = target.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const targetTopInScroller = targetBox.top - scrollerBox.top + scroller.scrollTop;
        scroller.scrollTop = Math.max(0, targetTopInScroller + offset - desiredOffsetTop);
        return;
      }

      const targetTop = target.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, targetTop + offset - desiredOffsetTop));
    }, { desiredOffsetTop: desiredViewportTop, offset: offsetY, targetSelector: selector });
    await waitForPaintAfterScroll(page);

    const viewportRect = await page.evaluate(({ offset, targetSelector }) => {
      const target = document.querySelector(targetSelector);
      if (!(target instanceof Element)) {
        throw new Error(`Target selector not found for screenshot: ${targetSelector}`);
      }

      function findScrollableAncestor(node) {
        let cursor = node.parentElement;
        while (cursor) {
          const style = getComputedStyle(cursor);
          const overflowY = style.overflowY;
          if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
            && cursor.scrollHeight > cursor.clientHeight + 1) {
            return cursor;
          }
          cursor = cursor.parentElement;
        }
        return null;
      }

      const rect = target.getBoundingClientRect();
      const scroller = findScrollableAncestor(target);
      const visibleBottom = scroller
        ? Math.min(scroller.getBoundingClientRect().bottom, window.innerHeight)
        : window.innerHeight;
      const visibleRight = scroller
        ? Math.min(scroller.getBoundingClientRect().right, window.innerWidth)
        : window.innerWidth;
      return {
        clipY: rect.top + offset,
        maxHeight: visibleBottom - (rect.top + offset),
        maxWidth: visibleRight - rect.left,
        left: rect.left,
      };
    }, { offset: offsetY, targetSelector: selector });

    const sliceClipX = Math.max(0, Math.round(viewportRect.left));
    const sliceClipY = Math.max(0, Math.round(viewportRect.clipY));
    const availableWidth = Math.max(1, Math.min(viewport.width - sliceClipX, Math.round(viewportRect.maxWidth)));
    const availableHeight = Math.max(1, Math.min(viewport.height - sliceClipY, Math.round(viewportRect.maxHeight)));
    const sliceClipWidth = Math.max(1, Math.min(clipWidth, availableWidth));
    const sliceClipHeight = Math.max(1, Math.min(sliceHeight, availableHeight));
    const sliceBuffer = await page.screenshot({
      animations: 'disabled',
      clip: {
        height: sliceClipHeight,
        width: sliceClipWidth,
        x: sliceClipX,
        y: sliceClipY,
      },
    });
    const sliceImage = await loadImage(sliceBuffer);
    context.drawImage(sliceImage, 0, offsetY, sliceClipWidth, sliceClipHeight);
  }

  return canvas.toBuffer('image/png');
}

function cloneFontConfig(fontConfig) {
  if (!fontConfig) return fontConfig;
  if (Array.isArray(fontConfig)) {
    return fontConfig.map((item) => ({ ...item }));
  }
  return { ...fontConfig };
}

async function ensureAutomationBridge(page, preferredSelector, distBundleSource, defaultFontConfig) {
  // Always use the local dist bundle for debugging so remote demo pages do not
  // silently diff against a deployed build with a different implementation.
  await page.addScriptTag({ content: distBundleSource });
  await page.evaluate(() => {
    window.__DOMPDF_AUTOMATION__ = undefined;
  });
  const hasBridge = await page.evaluate(() => typeof window.__DOMPDF_AUTOMATION__ === 'object');
  if (hasBridge) {
    await page.evaluate(({ selector, strictSelector, injectedFontConfig }) => {
      const bridge = window.__DOMPDF_AUTOMATION__;
      if (!bridge) return;

      function mergeDebugExportOverride(override) {
        const next = override ? Object.assign({}, override) : {};
        next.pagination = false;
        if (injectedFontConfig && !next.fontConfig) {
          next.fontConfig = Array.isArray(injectedFontConfig)
            ? injectedFontConfig.map((item) => ({
                fontBase64: item.fontBase64,
                fontFamily: item.fontFamily,
                fontStyle: item.fontStyle,
                fontWeight: item.fontWeight,
              }))
            : {
                fontBase64: injectedFontConfig.fontBase64,
                fontFamily: injectedFontConfig.fontFamily,
                fontStyle: injectedFontConfig.fontStyle,
                fontWeight: injectedFontConfig.fontWeight,
              };
        }
        return next;
      }

      if (!bridge.__dompdfPatchedForDebugExport) {
        if (typeof bridge.getMeta === 'function') {
          const rawGetMeta = bridge.getMeta.bind(bridge);
          bridge.getMeta = function patchedGetMeta(override) {
            return rawGetMeta(mergeDebugExportOverride(override));
          };
        }
        if (typeof bridge.inspect === 'function') {
          const rawInspect = bridge.inspect.bind(bridge);
          bridge.inspect = function patchedInspect(override) {
            return rawInspect(mergeDebugExportOverride(override));
          };
        }
        if (typeof bridge.exportPdf === 'function') {
          const rawExportPdf = bridge.exportPdf.bind(bridge);
          bridge.exportPdf = function patchedExportPdf(override) {
            return rawExportPdf(mergeDebugExportOverride(override));
          };
        }
        bridge.__dompdfPatchedForDebugExport = true;
      }

      if (typeof bridge.prepare === 'function') return;

      function isVisible(node) {
        if (!(node instanceof Element)) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }

      function resolveTargetForCleanup() {
        const preferred = [];
        if (selector) {
          preferred.push(selector);
        } else if (typeof bridge.getMeta === 'function') {
          const meta = bridge.getMeta();
          if (meta?.selector) preferred.push(meta.selector);
        }
        preferred.push('#document', 'article', 'main', 'body');
        for (const candidate of preferred) {
          const found = document.querySelector(candidate);
          if (found && isVisible(found)) return { element: found, selector: candidate };
        }
        if (strictSelector && selector) {
          throw new Error(`Target selector not found or not visible: ${selector}`);
        }
        throw new Error(`No visible target found for selectors: ${preferred.join(', ')}`);
      }

      bridge.prepare = function prepare(config) {
        const { element } = resolveTargetForCleanup();
        const selectors = Array.isArray(config?.removeSelectors) ? config.removeSelectors.filter(Boolean) : [];
        const removed = [];
        const skipped = [];
        for (const selectorItem of selectors) {
          let matched;
          try {
            matched = Array.from(element.querySelectorAll(selectorItem));
          } catch (error) {
            skipped.push({ selector: selectorItem, reason: `invalid-selector: ${error.message}` });
            continue;
          }
          let removedCount = 0;
          for (const node of matched) {
            if (node === element) {
              skipped.push({ selector: selectorItem, reason: 'matched-target-root' });
              continue;
            }
            node.remove();
            removedCount += 1;
          }
          removed.push({ selector: selectorItem, count: removedCount });
        }
        return {
          cleanup: { removed, skipped },
          meta: typeof bridge.getMeta === 'function' ? bridge.getMeta() : null,
        };
      };
    }, { selector: preferredSelector, strictSelector: Boolean(preferredSelector), injectedFontConfig: defaultFontConfig });
    return;
  }

  const hasApi = await page.evaluate(() => typeof window.dompdf === 'function');
  if (!hasApi) {
    await page.addScriptTag({ content: distBundleSource });
  }

  await page.evaluate(({ selector, strictSelector, injectedFontConfig }) => {
    const api = window.dompdf;
    if (!api) {
      throw new Error('window.dompdf not found after script injection');
    }

    const defaultOptions = {
      backgroundColor: '#ffffff',
      fontConfig: injectedFontConfig || undefined,
      format: 'a4',
      marginPt: 0,
      // Debug mode prefers a single tall page so PDF/HTML differences are easier to inspect.
      pagination: false,
      useCORS: true,
    };
    const fallbackSelectors = [];
    if (selector) {
      fallbackSelectors.push(selector);
    } else {
      fallbackSelectors.push('#document', 'article', 'main', 'body');
    }

    function mergeExportOptions(base, override) {
      if (!override) return base;
      const merged = Object.assign({}, base, override);
      const basePageConfig = base.pageConfig || {};
      const overridePageConfig = override.pageConfig || {};
      if (base.pageConfig || override.pageConfig) {
        merged.pageConfig = Object.assign({}, basePageConfig, overridePageConfig);
        if (basePageConfig.header || overridePageConfig.header) {
          merged.pageConfig.header = Object.assign({}, basePageConfig.header || {}, overridePageConfig.header || {});
        }
        if (basePageConfig.footer || overridePageConfig.footer) {
          merged.pageConfig.footer = Object.assign({}, basePageConfig.footer || {}, overridePageConfig.footer || {});
        }
      }
      return merged;
    }

    function encodeBase64(uint8) {
      let binary = '';
      const chunkSize = 32768;
      for (let i = 0; i < uint8.length; i += chunkSize) {
        const chunk = uint8.subarray(i, Math.min(i + chunkSize, uint8.length));
        binary += String.fromCharCode.apply(null, chunk);
      }
      return btoa(binary);
    }

    function isVisible(node) {
      if (!(node instanceof Element)) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function resolveTarget() {
      for (const candidate of fallbackSelectors) {
        const found = document.querySelector(candidate);
        if (found && isVisible(found)) {
          return { element: found, selector: candidate };
        }
      }
      if (strictSelector && selector) {
        throw new Error(`Target selector not found or not visible: ${selector}`);
      }
      if (document.body && isVisible(document.body)) {
        return { element: document.body, selector: 'body' };
      }
      throw new Error(`No visible target found for selectors: ${fallbackSelectors.join(', ')}`);
    }

    function summarizeOptions(options) {
      const pageConfig = options.pageConfig && typeof options.pageConfig === 'object' ? options.pageConfig : null;
      return {
        backgroundColor: options.backgroundColor,
        format: options.format,
        marginPt: options.marginPt,
        pagination: !!options.pagination,
        useCORS: !!options.useCORS,
        pageConfig: pageConfig
          ? {
              header: pageConfig.header
                ? {
                    content: pageConfig.header.content,
                    contentFontSize: pageConfig.header.contentFontSize,
                    height: pageConfig.header.height,
                  }
                : null,
              footer: pageConfig.footer
                ? {
                    content: pageConfig.footer.content,
                    contentFontSize: pageConfig.footer.contentFontSize,
                    height: pageConfig.footer.height,
                  }
                : null,
            }
          : null,
      };
    }

    function applyCleanup(removeSelectors) {
      const { element } = resolveTarget();
      const selectors = Array.isArray(removeSelectors) ? removeSelectors.filter(Boolean) : [];
      const removed = [];
      const skipped = [];
      for (const selectorItem of selectors) {
        let matched;
        try {
          matched = Array.from(element.querySelectorAll(selectorItem));
        } catch (error) {
          skipped.push({ selector: selectorItem, reason: `invalid-selector: ${error.message}` });
          continue;
        }
        let removedCount = 0;
        for (const node of matched) {
          if (node === element) {
            skipped.push({ selector: selectorItem, reason: 'matched-target-root' });
            continue;
          }
          node.remove();
          removedCount += 1;
        }
        removed.push({ selector: selectorItem, count: removedCount });
      }
      return { removed, skipped };
    }

    function automationMeta(element, resolvedSelector, options) {
      const rect = element.getBoundingClientRect();
      let pageBreaks = [];
      try {
        pageBreaks = api.computePageBreaks(element, options);
      } catch (error) {
        pageBreaks = [];
      }
      return {
        devicePixelRatio: window.devicePixelRatio || 1,
        options: summarizeOptions(options),
        pageBreaks,
        rootHeightPx: rect.height,
        rootWidthPx: rect.width,
        selector: resolvedSelector,
      };
    }

    function waitForFonts() {
      if (!document.fonts || !document.fonts.ready) {
        return Promise.resolve({ skipped: true, timedOut: false });
      }
      return Promise.race([
        document.fonts.ready
          .then(() => ({ skipped: false, timedOut: false }))
          .catch(() => ({ skipped: false, timedOut: false })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ skipped: false, timedOut: true }), 6000);
        }),
      ]);
    }

    function waitForImages(element) {
      const images = Array.from(element.querySelectorAll('img'));
      if (images.length === 0) return Promise.resolve({ timedOut: false, total: 0, waited: 0 });
      const pending = images.filter((img) => !img.complete);
      if (pending.length === 0) return Promise.resolve({ timedOut: false, total: images.length, waited: 0 });
      const sample = pending.slice(0, 48);
      return Promise.race([
        Promise.all(sample.map((img) => new Promise((resolve) => {
          const cleanup = () => {
            img.removeEventListener('load', onDone);
            img.removeEventListener('error', onDone);
          };
          const onDone = () => {
            cleanup();
            resolve();
          };
          img.addEventListener('load', onDone, { once: true });
          img.addEventListener('error', onDone, { once: true });
          setTimeout(onDone, 5000);
        }))).then(() => ({
          timedOut: false,
          total: images.length,
          waited: sample.length,
        })),
        new Promise((resolve) => {
          setTimeout(() => resolve({
            timedOut: true,
            total: images.length,
            waited: sample.length,
          }), 7000);
        }),
      ]);
    }

    function waitForLayoutSettled() {
      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 250);
          });
        });
      });
    }

    function ready() {
      const { element } = resolveTarget();
      return Promise.all([waitForFonts(), waitForImages(element), waitForLayoutSettled()]).then(([fontState, imageState]) => {
        const warnings = [];
        if (fontState.timedOut) warnings.push('fonts-timeout');
        if (imageState.timedOut) warnings.push('images-timeout');
        return {
          hasFontAPI: !!document.fonts,
          imageCount: imageState.total,
          imageWaitSample: imageState.waited,
          status: warnings.length > 0 ? 'ready-with-warnings' : 'ready',
          warnings,
        };
      });
    }

    window.__DOMPDF_AUTOMATION__ = {
      prepare(config) {
        const cleanup = applyCleanup(config?.removeSelectors || []);
        return {
          cleanup,
          meta: this.getMeta(),
        };
      },
      ready() {
        return ready();
      },
      getMeta(override) {
        const options = mergeExportOptions(defaultOptions, override || {});
        const { element, selector: resolvedSelector } = resolveTarget();
        return automationMeta(element, resolvedSelector, options);
      },
      inspect(override) {
        const options = mergeExportOptions(defaultOptions, override || {});
        const { element } = resolveTarget();
        return ready().then(() => api.inspect(element, options));
      },
      exportPdf(override) {
        const options = mergeExportOptions(defaultOptions, override || {});
        const { element, selector: resolvedSelector } = resolveTarget();
        return ready().then(() => api(element, options).then((blob) => blob.arrayBuffer().then((buf) => ({
          meta: automationMeta(element, resolvedSelector, options),
          pdfBase64: encodeBase64(new Uint8Array(buf)),
        }))));
      },
    };
  }, { selector: preferredSelector, strictSelector: Boolean(preferredSelector), injectedFontConfig: defaultFontConfig });
}

async function normalizeTargetFonts(page, selector, defaultFontConfig) {
  if (!defaultFontConfig) return { family: null, loadedCount: 0 };
  const configs = Array.isArray(defaultFontConfig) ? defaultFontConfig : [defaultFontConfig];
  return page.evaluate(async ({ targetSelector, fontConfigs }) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) {
      return { family: null, loadedCount: 0 };
    }
    const family = fontConfigs[0]?.fontFamily || null;
    if (!family) {
      return { family: null, loadedCount: 0 };
    }

    const normalizedTagId = '__dompdf_font_normalize_style__';
    let loadedCount = 0;
    for (const cfg of fontConfigs) {
      if (!cfg?.fontBase64 || !cfg.fontFamily) continue;
      const source = `url(data:font/ttf;base64,${cfg.fontBase64})`;
      const descriptors = {
        style: cfg.fontStyle || 'normal',
        weight: String(cfg.fontWeight || 400),
      };
      const alreadyLoaded = document.fonts.values
        ? Array.from(document.fonts.values()).some((font) => (
          font.family.replace(/^["']|["']$/g, '') === cfg.fontFamily
          && font.style === descriptors.style
          && font.weight === descriptors.weight
        ))
        : false;
      if (!alreadyLoaded) {
        const face = new FontFace(cfg.fontFamily, source, descriptors);
        await face.load();
        document.fonts.add(face);
      }
      loadedCount += 1;
    }

    let styleTag = document.getElementById(normalizedTagId);
    if (!(styleTag instanceof HTMLStyleElement)) {
      styleTag = document.createElement('style');
      styleTag.id = normalizedTagId;
      document.head.appendChild(styleTag);
    }
    styleTag.textContent = `
${targetSelector},
${targetSelector} * {
  font-family: "${family}" !important;
  font-synthesis: none !important;
}
`;

    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    return { family, loadedCount };
  }, { targetSelector: selector, fontConfigs: configs });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(args.outDir);

  const distEntry = resolve(rootDir, 'dist', 'dompdf.js');
  if (!existsSync(distEntry)) {
    throw new Error('dist/dompdf.js 不存在，请先执行 npm run build。');
  }
  const distBundleSource = readFileSync(distEntry, 'utf8');
  const defaultFontConfig = existsSync(defaultChineseFontPath)
    ? [
        {
          fontBase64: bufferToBase64(readFileSync(defaultChineseFontPath)),
          fontFamily: injectedCjkFontFamily,
          fontStyle: 'normal',
          fontWeight: 400,
        },
        {
          fontBase64: bufferToBase64(readFileSync(defaultChineseFontPath)),
          fontFamily: injectedCjkFontFamily,
          fontStyle: 'normal',
          fontWeight: 700,
        },
      ]
    : null;

  let server = null;
  let baseUrl = args.url;
  if (!baseUrl) {
    server = await startStaticServer(rootDir, args.port);
    baseUrl = `${server.url}/examples/index.html`;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    bypassCSP: true,
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1200 },
  });
  const page = await context.newPage();

  try {
    console.log(`正在打开页面: ${baseUrl}`);
    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.addStyleTag({
      content: '* { animation: none !important; transition: none !important; caret-color: transparent !important; }',
    });
    console.log('正在注入/检查 dompdf 自动化桥...');
    const injectedFontConfig = cloneFontConfig(defaultFontConfig);
    await ensureAutomationBridge(page, args.cssSelector, distBundleSource, injectedFontConfig);
    const normalizedFont = await normalizeTargetFonts(page, args.cssSelector, cloneFontConfig(defaultFontConfig));
    if (normalizedFont.family) {
      console.log(`已统一目标字体族: ${normalizedFont.family} (loaded=${normalizedFont.loadedCount})`);
    }
    await page.waitForFunction(() => Boolean(window.__DOMPDF_AUTOMATION__), undefined, { timeout: 10000 });
    if (args.removeSelectors.length > 0) {
      console.log(`正在清理目标节点内容... (${args.removeSelectors.join(', ')})`);
      const prepareInfo = await page.evaluate((removeSelectors) => window.__DOMPDF_AUTOMATION__.prepare({ removeSelectors }), args.removeSelectors);
      const removedSummary = prepareInfo.cleanup.removed
        .map((item) => `${item.selector}:${item.count}`)
        .join(', ');
      const skippedSummary = prepareInfo.cleanup.skipped
        .map((item) => `${item.selector}:${item.reason}`)
        .join(', ');
      console.log(`清理完成: ${removedSummary || 'no-match'}${skippedSummary ? `; skipped=${skippedSummary}` : ''}`);
    }
    console.log('正在等待页面资源稳定...');
    const readyInfo = await page.evaluate(() => window.__DOMPDF_AUTOMATION__.ready());
    console.log(`页面资源状态: ${readyInfo.status} (images=${readyInfo.imageCount}, sampled=${readyInfo.imageWaitSample || 0}${readyInfo.warnings?.length ? `, warnings=${readyInfo.warnings.join(',')}` : ''})`);
    let inspectSummary = 'inspect skipped';
    if (args.skipInspect) {
      console.log('跳过 inspect 阶段。');
    } else {
      console.log(`正在执行 inspect... (timeout=${args.inspectTimeoutMs}ms)`);
      try {
        inspectSummary = await withTimeout(
          page.evaluate(() => window.__DOMPDF_AUTOMATION__.inspect()),
          args.inspectTimeoutMs,
          'inspect',
        );
      } catch (error) {
        inspectSummary = `inspect failed: ${error.message}`;
        console.warn(`[pdf-diff-mvp] ${inspectSummary}`);
      }
    }
    writeFileSync(resolve(args.outDir, 'inspect.txt'), inspectSummary, 'utf8');

    console.log(`正在生成 PDF... (timeout=${args.exportTimeoutMs}ms)`);
    const exportResult = await withTimeout(
      page.evaluate(() => window.__DOMPDF_AUTOMATION__.exportPdf()),
      args.exportTimeoutMs,
      'exportPdf',
    );
    const meta = exportResult.meta;
    meta.selector = meta.selector || args.cssSelector;
    const metrics = computeLayoutMetrics(meta);
    const selector = meta.selector || args.cssSelector;
    const overlayInfo = await hideOverlaysForLocatorScreenshot(page, selector);
    if (overlayInfo.hiddenCount > 0) {
      console.log(`截图前已隐藏目标外的 fixed/sticky 浮层: ${overlayInfo.hiddenCount}`);
    }
    const htmlScreenshotBuffer = await captureLocatorScreenshot(page, selector);
    const htmlScreenshotPath = resolve(args.outDir, 'html-source.png');
    writeFileSync(htmlScreenshotPath, htmlScreenshotBuffer);

    const pdfBuffer = base64ToBuffer(exportResult.pdfBase64);
    const pdfPath = resolve(args.outDir, 'output.pdf');
    writeFileSync(pdfPath, pdfBuffer);

    console.log('正在渲染 PDF 页面并做差异比对...');
    const rendered = await renderPdfPages(pdfBuffer, PT_TO_PX, args.outDir);
    const totalPages = args.pageLimit > 0 ? Math.min(args.pageLimit, rendered.numPages) : rendered.numPages;
    const pages = [];

    for (let i = 0; i < totalPages; i += 1) {
      const expectedBuffer = await createExpectedPageImage(htmlScreenshotBuffer, meta, metrics, i);
      const actualBuffer = await normalizePdfContentImage(rendered.pages[i].buffer, metrics);
      const expectedPath = resolve(args.outDir, `expected-page-${i + 1}.png`);
      const actualPath = resolve(args.outDir, `actual-page-${i + 1}.png`);
      const diffPath = resolve(args.outDir, `diff-page-${i + 1}.png`);
      writeFileSync(expectedPath, expectedBuffer);
      writeFileSync(actualPath, actualBuffer);
      const diffResult = diffImages(expectedBuffer, actualBuffer, args.threshold);
      writeFileSync(diffPath, diffResult.diffBuffer);
      pages.push({
        actualImage: actualPath,
        diffImage: diffPath,
        expectedImage: expectedPath,
        mismatchPixels: diffResult.mismatchPixels,
        mismatchRatio: diffResult.mismatchRatio,
        pageNumber: i + 1,
        size: {
          height: diffResult.height,
          width: diffResult.width,
        },
      });
    }

    const aggregateMismatchRatio = pages.length > 0
      ? pages.reduce((sum, item) => sum + item.mismatchRatio, 0) / pages.length
      : 0;
    const maxMismatchRatio = pages.reduce((max, item) => Math.max(max, item.mismatchRatio), 0);
    const report = {
      generatedAt: new Date().toISOString(),
      input: {
        selector,
        url: baseUrl,
      },
      layout: metrics,
      output: {
        htmlScreenshot: htmlScreenshotPath,
        inspectText: resolve(args.outDir, 'inspect.txt'),
        pdfFile: pdfPath,
        rootDir: args.outDir,
      },
      pageCount: rendered.numPages,
      pages,
      readiness: readyInfo,
      summary: {
        aggregateMismatchRatio,
        comparedPages: totalPages,
        maxMismatchRatio,
        status: maxMismatchRatio <= 0.015 ? 'pass' : 'needs-review',
      },
    };
    const reportPath = resolve(args.outDir, 'report.json');
    writeJson(reportPath, report);

    console.log(`URL: ${baseUrl}`);
    console.log(`输出目录: ${args.outDir}`);
    console.log(`总页数: ${rendered.numPages}`);
    console.log(`对比页数: ${totalPages}`);
    console.log(`平均差异: ${(aggregateMismatchRatio * 100).toFixed(2)}%`);
    console.log(`最大差异: ${(maxMismatchRatio * 100).toFixed(2)}%`);
    console.log(`报告文件: ${reportPath}`);
  } finally {
    await context.close();
    await browser.close();
    if (server) await server.close();
  }
}

main().catch((error) => {
  console.error('[pdf-diff-mvp] 失败:', error);
  process.exit(1);
});
