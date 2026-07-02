import { createCanvas, loadImage } from '@napi-rs/canvas';
import { roundSize } from './layout.mjs';
import { injectedCjkFontFamily } from './browser.mjs';

export { injectedCjkFontFamily };

async function waitForPaintAfterScroll(page) {
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 50);
      });
    });
  }));
}

export async function hideOverlaysForLocatorScreenshot(page, selector) {
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

export async function captureLocatorScreenshot(page, selector) {
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

// Inject the local dist bundle + automation bridge into the page.
//
// Demo pages (e.g. examples/index.html) ship their own __DOMPDF_AUTOMATION__
// bound to the page's copy of dompdf; reusing it would diff whatever build the
// page loaded instead of the locally injected bundle. So any page-provided
// bridge is deliberately discarded and rebuilt below on top of window.dompdf
// from the injected dist bundle.
export async function ensureAutomationBridge(page, preferredSelector, distBundleSource, defaultFontConfig) {
  await page.addScriptTag({ content: distBundleSource });
  await page.evaluate(() => {
    window.__DOMPDF_AUTOMATION__ = undefined;
  });

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
      pageConfig: {},
      pagination: true,
      useCORS: true,
    };
    const fallbackSelectors = [];
    if (selector) {
      fallbackSelectors.push(selector);
    } else {
      fallbackSelectors.push('#document', 'article', 'main', 'body');
    }

    function mergeFontConfigs(baseFontConfig, overrideFontConfig) {
      const baseList = baseFontConfig
        ? (Array.isArray(baseFontConfig) ? baseFontConfig : [baseFontConfig]).filter(Boolean)
        : [];
      const overrideList = overrideFontConfig
        ? (Array.isArray(overrideFontConfig) ? overrideFontConfig : [overrideFontConfig]).filter(Boolean)
        : [];
      if (baseList.length === 0) return overrideFontConfig;
      if (overrideList.length === 0) return baseFontConfig;
      const merged = [];
      const seen = new Set();
      const pushUnique = (cfg) => {
        const key = [
          cfg.fontFamily || '',
          cfg.fontWeight ?? '',
          cfg.fontStyle || '',
          cfg.fontUrl || '',
          cfg.fontBase64 ? 'base64' : '',
          cfg.fontBytes ? `bytes:${cfg.fontBytes.length || 0}` : '',
        ].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        merged.push(cfg);
      };
      for (const cfg of baseList) pushUnique(cfg);
      for (const cfg of overrideList) pushUnique(cfg);
      return merged;
    }

    function mergeExportOptions(base, override) {
      if (!override) return base;
      const merged = Object.assign({}, base, override);
      merged.fontConfig = mergeFontConfigs(base.fontConfig, override.fontConfig);
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
                ? { content: pageConfig.header.content, contentFontSize: pageConfig.header.contentFontSize, height: pageConfig.header.height }
                : null,
              footer: pageConfig.footer
                ? { content: pageConfig.footer.content, contentFontSize: pageConfig.footer.contentFontSize, height: pageConfig.footer.height }
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
        }))).then(() => ({ timedOut: false, total: images.length, waited: sample.length })),
        new Promise((resolve) => {
          setTimeout(() => resolve({ timedOut: true, total: images.length, waited: sample.length }), 7000);
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
        return { cleanup, meta: this.getMeta() };
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

export async function normalizeTargetFonts(page, selector, defaultFontConfig) {
  if (!defaultFontConfig) return { family: null, loadedCount: 0 };
  const configs = Array.isArray(defaultFontConfig) ? defaultFontConfig : [defaultFontConfig];
  return page.evaluate(async ({ targetSelector, fontConfigs }) => {
    const target = document.querySelector(targetSelector);
    if (!(target instanceof HTMLElement)) {
      return { family: null, loadedCount: 0 };
    }
    const families = Array.from(new Set(fontConfigs.map((cfg) => cfg?.fontFamily).filter(Boolean)));
    const family = families[0] || null;
    if (!family || families.length === 0) {
      return { family: null, loadedCount: 0 };
    }
    const familyCss = families.map((name) => `"${String(name).replace(/"/g, '\\"')}"`).join(', ');

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
  font-family: ${familyCss} !important;
  font-synthesis: none !important;
}
`;

    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    return { family: familyCss, loadedCount };
  }, { targetSelector: selector, fontConfigs: configs });
}
