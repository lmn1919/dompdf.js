import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, writeJson } from './lib/fs-util.mjs';
import { rootDir } from './lib/server.mjs';
import { launchBrowser, buildDefaultFontConfig } from './lib/browser.mjs';
import { runEntry, ensureServerForUrl } from './run.mjs';
import { buildAggregateReport } from './lib/report.mjs';
import { parseCorpusArgs, buildCorpus } from './corpus.mjs';

export async function runAll(options) {
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
  if (server) {
    for (const e of corpus) {
      if (!e.url || /^http:\/\/127\.0\.0\.1/.test(e.url) || /^http:\/\/localhost/.test(e.url)) {
        e.url = baseUrl;
      }
    }
  }

  const { browser, context } = await launchBrowser();
  const entries = [];
  try {
    for (const entry of corpus) {
      const entryOut = resolve(outRoot, entry.name);
      const result = await runEntry({
        entry,
        outDir: entryOut,
        context,
        distBundleSource,
        defaultFontConfig,
        options,
      });
      entries.push({ name: entry.name, outDir: entryOut, report: result.report });
    }
  } finally {
    await context.close();
    await browser.close();
    await close();
  }

  const aggregate = buildAggregateReport({ entries, generatedAt: new Date().toISOString() });
  const aggregatePath = resolve(outRoot, 'aggregate-report.json');
  writeJson(aggregatePath, aggregate);

  console.log(`\n=== 汇总 (corpus=${aggregate.entryCount}, pass=${aggregate.passCount}, needs-review=${aggregate.needsReviewCount}) ===`);
  for (const e of aggregate.entries) {
    console.log(`  ${e.name}: ${e.status} mismatch=${(e.aggregateMismatchRatio * 100).toFixed(2)}% discrepancies=${e.discrepancyCount}`);
  }
  console.log(`类别计数:`);
  for (const c of aggregate.categoryTotals) {
    console.log(`  ${c.category}: ${c.count}`);
  }
  console.log(`汇总报告: ${aggregatePath}`);
  console.log(`本轮输出根目录: ${outRoot}`);
  return { aggregate, outRoot };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseCorpusArgs(process.argv.slice(2));
  runAll(options).catch((error) => {
    console.error('[pdf-diff run-all] 失败:', error);
    process.exit(1);
  });
}
