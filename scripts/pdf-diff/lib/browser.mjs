import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { bufferToBase64 } from './fs-util.mjs';
import { rootDir } from './server.mjs';

export const defaultChineseFontPath = resolve(rootDir, 'examples', 'SourceHanSansSC-Regular.ttf');
export const injectedCjkFontFamily = 'DompdfAutoCJK';

export function cloneFontConfig(fontConfig) {
  if (!fontConfig) return fontConfig;
  if (Array.isArray(fontConfig)) {
    return fontConfig.map((item) => ({ ...item }));
  }
  return { ...fontConfig };
}

export function buildDefaultFontConfig() {
  if (!existsSync(defaultChineseFontPath)) return null;
  const fontBase64 = bufferToBase64(readFileSync(defaultChineseFontPath));
  return [
    {
      fontBase64,
      fontFamily: injectedCjkFontFamily,
      fontStyle: 'normal',
      fontWeight: 400,
    },
    {
      fontBase64,
      fontFamily: injectedCjkFontFamily,
      fontStyle: 'normal',
      fontWeight: 700,
    },
  ];
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
