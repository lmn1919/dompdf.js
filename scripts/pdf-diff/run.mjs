import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, writeJson } from './lib/fs-util.mjs';
import { startStaticServer, rootDir } from './lib/server.mjs';
import { launchBrowser, buildDefaultFontConfig, cloneFontConfig } from './lib/browser.mjs';
import { collectOracle, writeOracleArtifacts } from './lib/oracle.mjs';
import { rasterizePdf, extractPdfTextItems } from './lib/rasterize.mjs';
import { pixelDiffPages } from './lib/pixeldiff.mjs';
import { computeLayoutMetrics, PT_TO_PX } from './lib/layout.mjs';
import { diffTexts } from './lib/textdiff.mjs';
import { classify } from './lib/classify.mjs';
import { buildReport, writeReport } from './lib/report.mjs';
import { parseCorpusArgs, buildCorpus } from './corpus.mjs';

export async function ensureServerForUrl(url, port) {
  // Local 127.0.0.1 URL (or empty) needs the static server; remote URLs do not.
  const isLocal = !url || /^http:\/\/127\.0\.0\.1/.test(url) || /^http:\/\/localhost/.test(url);
  if (!isLocal) return { server: null, baseUrl: url, close: async () => {} };
  const server = await startStaticServer(rootDir, port);
  const baseUrl = url || `${server.url}/examples/index.html`;
  return { server, baseUrl, close: () => server.close() };
}

// Run Tier 0–3 for one corpus entry. Browser/context must already be launched;
// server must already be running (or entry.url is remote).
export async function runEntry({
  entry,
  outDir,
  context,
  distBundleSource,
  defaultFontConfig,
  options,
}) {
  ensureDir(outDir);
  const page = await context.newPage();
  try {
    console.log(`[${entry.name}] 正在打开页面: ${entry.url}`);
    await page.goto(entry.url, { waitUntil: 'networkidle' });

    const oracle = await collectOracle({
      page,
      selector: entry.selector,
      distBundleSource,
      defaultFontConfig: cloneFontConfig(defaultFontConfig),
      removeSelectors: entry.removeSelectors || [],
      exportTimeoutMs: options.exportTimeoutMs,
      inspectTimeoutMs: options.inspectTimeoutMs,
      skipInspect: options.skipInspect,
    });
    writeOracleArtifacts(outDir, oracle);

    const { meta } = oracle;
    meta.selector = meta.selector || entry.selector;
    const metrics = computeLayoutMetrics(meta);

    // Tier 1 — pixel diff.
    const rendered = await rasterizePdf(oracle.actualPdfBuffer, PT_TO_PX, outDir);
    const pixelDiff = await pixelDiffPages({
      htmlScreenshotBuffer: oracle.htmlScreenshotBuffer,
      renderedPages: rendered,
      meta,
      metrics,
      threshold: options.threshold,
      outDir,
      pageLimit: options.pageLimit,
    });

    // Tier 2 — structured text diff.
    const pdfTextItems = await extractPdfTextItems(oracle.actualPdfBuffer);
    const textDiff = diffTexts(oracle.oracle, pdfTextItems, metrics);

    // Tier 3 — classify.
    const categories = classify({
      textDiff,
      pixelDiff,
      inspectText: oracle.inspectText,
      meta,
    });

    const report = buildReport({
      entry,
      outDir,
      meta,
      metrics,
      readiness: oracle.readiness,
      normalizedFont: oracle.normalizedFont,
      pixelDiff,
      textDiff,
      categories,
      pageCount: rendered.numPages,
    });
    writeReport(outDir, report);

    console.log(`[${entry.name}] 页数=${rendered.numPages} 平均差异=${(pixelDiff.aggregateMismatchRatio * 100).toFixed(2)}% 文本差异=${textDiff.summary.discrepancyCount} 类别=${categories.length}`);
    console.log(`[${entry.name}] 报告: ${resolve(outDir, 'report.json')}`);
    return { report, outDir, entry };
  } finally {
    await page.close();
  }
}

async function main() {
  const options = parseCorpusArgs(process.argv.slice(2));
  const outRoot = options.outDir || resolve(rootDir, 'tmp', 'pdf-diff', new Date().toISOString().replace(/[:.]/g, '-'));
  ensureDir(outRoot);

  const distEntry = resolve(rootDir, 'dist', 'dompdf.js');
  if (!existsSync(distEntry)) {
    throw new Error('dist/dompdf.js 不存在，请先执行 npm run build。');
  }
  const distBundleSource = readFileSync(distEntry, 'utf8');
  const defaultFontConfig = buildDefaultFontConfig();

  const corpus = buildCorpus(options);
  const { server, baseUrl, close } = await ensureServerForUrl(corpus[0].url, options.port);
  // Patch corpus urls that referenced the local server port to the resolved server URL.
  if (server) {
    for (const e of corpus) {
      if (!e.url || /^http:\/\/127\.0\.0\.1/.test(e.url) || /^http:\/\/localhost/.test(e.url)) {
        e.url = baseUrl;
      }
    }
  }

  const { browser, context } = await launchBrowser();
  try {
    for (let i = 0; i < corpus.length; i += 1) {
      const entry = corpus[i];
      const entryOut = resolve(outRoot, entry.name);
      await runEntry({
        entry,
        outDir: entryOut,
        context,
        distBundleSource,
        defaultFontConfig,
        options,
      });
    }
  } finally {
    await context.close();
    await browser.close();
    await close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[pdf-diff run] 失败:', error);
    process.exit(1);
  });
}
