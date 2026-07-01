import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { bufferToBase64 } from './fs-util.mjs';
import { rootDir } from './server.mjs';

export const defaultChineseFontPath = resolve(rootDir, 'examples', 'SourceHanSansSC-Regular.ttf');
export const injectedCjkFontFamily = 'DompdfAutoCJK';
export const symbolFallbackFontPath = resolve(rootDir, 'assets', 'symbol-fallback.ttf');
export const injectedSymbolFontFamily = 'DompdfAutoSymbols';
export const systemSymbolFontPath = 'C:\\Windows\\Fonts\\seguisym.ttf';
export const injectedSystemSymbolFontFamily = 'DompdfAutoSysSymbols';
export const systemEmojiFontPath = 'C:\\Windows\\Fonts\\seguiemj.ttf';
export const injectedEmojiFontFamily = 'DompdfAutoEmoji';

export function cloneFontConfig(fontConfig) {
  if (!fontConfig) return fontConfig;
  if (Array.isArray(fontConfig)) {
    return fontConfig.map((item) => ({ ...item }));
  }
  return { ...fontConfig };
}

export function buildDefaultFontConfig() {
  if (!existsSync(defaultChineseFontPath)) return null;
  const configs = [];
  const pushFont = ({ fontPath, fontFamily, fontWeight = 400 }) => {
    if (!existsSync(fontPath)) return;
    configs.push({
      fontBase64: bufferToBase64(readFileSync(fontPath)),
      fontFamily,
      fontStyle: 'normal',
      fontWeight,
    });
  };
  pushFont({ fontPath: defaultChineseFontPath, fontFamily: injectedCjkFontFamily, fontWeight: 400 });
  pushFont({ fontPath: defaultChineseFontPath, fontFamily: injectedCjkFontFamily, fontWeight: 700 });
  if (existsSync(symbolFallbackFontPath)) {
    pushFont({ fontPath: symbolFallbackFontPath, fontFamily: injectedSymbolFontFamily });
  }
  pushFont({ fontPath: systemSymbolFontPath, fontFamily: injectedSystemSymbolFontFamily });
  pushFont({ fontPath: systemEmojiFontPath, fontFamily: injectedEmojiFontFamily });
  return configs;
}

export async function launchBrowser() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    bypassCSP: true,
    deviceScaleFactor: 1,
    viewport: { width: 1440, height: 1200 },
  });
  return { browser, context };
}

export { rootDir };
