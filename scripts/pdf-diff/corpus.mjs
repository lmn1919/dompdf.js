import { resolve } from 'node:path';
import { rootDir } from './lib/server.mjs';

// Corpus: list of { name, url, selector, removeSelectors? }.
// Seeded with the local examples page (#document). Add remote URLs here or pass
// --url/--selector on the CLI to run a single entry ad-hoc.
export function defaultCorpus({ port = 4173 } = {}) {
  return [
    {
      name: 'examples-document',
      url: `http://127.0.0.1:${port}/examples/index.html`,
      selector: '#document',
      removeSelectors: [],
    },
  ];
}

// Default output root: `<domain>-<YYYY-MM-DD_HH-MM-SS>` (e.g. juejin.cn-2026-06-25_14-30-05).
// Domain comes from the target URL's hostname; the local default corpus has no
// URL, so it falls back to `local`. The timestamp includes time-of-day, so each
// run gets its own folder instead of overwriting the day's earlier artifacts.
export function defaultOutRoot(options, baseDir = resolve(rootDir, 'tmp', 'pdf-diff')) {
  const date = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  let domain = 'local';
  if (options.url) {
    try { domain = new URL(options.url).hostname || 'local'; } catch { domain = 'local'; }
  }
  domain = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
  return resolve(baseDir, `${domain}-${date}`);
}

// `Number(next) || fallback` swallows legal zero values (e.g. --threshold 0 is
// a valid pixelmatch setting); only fall back when the input is not a number.
function numArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function parseCorpusArgs(argv) {
  const options = {
    url: '',
    selector: '',
    removeSelectors: [],
    outDir: '',
    port: 4173,
    threshold: 0.1,
    pageLimit: 0,
    skipInspect: false,
    exportTimeoutMs: 120000,
    inspectTimeoutMs: 20000,
    corpusName: '',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url' && next) { options.url = next; i += 1; }
    else if ((arg === '--css-selector' || arg === '--selector' || arg === '--target-selector') && next) { options.selector = next; i += 1; }
    else if ((arg === '--remove' || arg === '--remove-selectors') && next) {
      options.removeSelectors = next.split(',').map((p) => p.trim()).filter(Boolean); i += 1;
    }
    else if (arg === '--out-dir' && next) { options.outDir = resolve(next); i += 1; }
    else if (arg === '--port' && next) { options.port = numArg(next, options.port); i += 1; }
    else if (arg === '--page-limit' && next) { options.pageLimit = numArg(next, 0); i += 1; }
    else if (arg === '--threshold' && next) { options.threshold = numArg(next, options.threshold); i += 1; }
    else if (arg === '--name' && next) { options.corpusName = next; i += 1; }
    else if (arg === '--inspect-timeout-ms' && next) { options.inspectTimeoutMs = Math.max(1, numArg(next, options.inspectTimeoutMs)); i += 1; }
    else if (arg === '--export-timeout-ms' && next) { options.exportTimeoutMs = Math.max(1, numArg(next, options.exportTimeoutMs)); i += 1; }
    else if (arg === '--skip-inspect') { options.skipInspect = true; }
  }
  return options;
}

// Build the effective corpus entries from CLI args. If --url/--selector given,
// run a single ad-hoc entry; otherwise use the default corpus.
export function buildCorpus(options) {
  if (options.url || options.selector) {
    return [{
      name: options.corpusName || 'ad-hoc',
      url: options.url,
      selector: options.selector || '#document',
      removeSelectors: options.removeSelectors,
    }];
  }
  return defaultCorpus({ port: options.port });
}
