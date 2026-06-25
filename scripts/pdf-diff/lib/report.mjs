import { resolve } from 'node:path';
import { writeJson } from './fs-util.mjs';

// Assemble a single-corpus report (Tier 0 artifacts + Tier 1 metrics +
// Tier 2 discrepancies + Tier 3 categories).
export function buildReport({
  entry,
  outDir,
  meta,
  metrics,
  readiness,
  normalizedFont,
  pixelDiff,
  textDiff,
  visualDiff,
  categories,
  pageCount,
}) {
  const visualCount = visualDiff?.summary?.discrepancyCount || 0;
  const status = (pixelDiff?.maxMismatchRatio || 0) <= 0.015
    && (textDiff?.summary?.discrepancyCount || 0) <= 10
    && visualCount <= 10
    ? 'pass'
    : 'needs-review';
  return {
    generatedAt: new Date().toISOString(),
    input: { name: entry.name, url: entry.url, selector: entry.selector, removeSelectors: entry.removeSelectors || [] },
    readiness,
    normalizedFont,
    layout: metrics,
    pageCount,
    tier1: {
      pixelDiff: {
        comparedPages: pixelDiff?.comparedPages || 0,
        aggregateMismatchRatio: pixelDiff?.aggregateMismatchRatio || 0,
        maxMismatchRatio: pixelDiff?.maxMismatchRatio || 0,
        pages: pixelDiff?.pages || [],
      },
    },
    tier2: textDiff,
    tier2b: visualDiff,
    tier3: { categories },
    summary: {
      status,
      aggregateMismatchRatio: pixelDiff?.aggregateMismatchRatio || 0,
      maxMismatchRatio: pixelDiff?.maxMismatchRatio || 0,
      discrepancyCount: textDiff?.summary?.discrepancyCount || 0,
      visualDiscrepancyCount: visualCount,
      topCategories: (categories || []).slice(0, 3).map((c) => ({
        category: c.category,
        severity: c.severity,
        count: c.count,
        suspected: c.suspected,
      })),
    },
    output: {
      rootDir: outDir,
      actualPdf: resolve(outDir, 'actual.pdf'),
      refPdf: resolve(outDir, 'ref.pdf'),
      htmlScreenshot: resolve(outDir, 'html-source.png'),
      oracle: resolve(outDir, 'oracle.json'),
      inspect: resolve(outDir, 'inspect.txt'),
      report: resolve(outDir, 'report.json'),
    },
  };
}

export function buildAggregateReport({ entries, generatedAt }) {
  const perEntry = entries.map((e) => ({
    name: e.name,
    status: e.report.summary.status,
    aggregateMismatchRatio: e.report.summary.aggregateMismatchRatio,
    maxMismatchRatio: e.report.summary.maxMismatchRatio,
    discrepancyCount: e.report.summary.discrepancyCount,
    visualDiscrepancyCount: e.report.summary.visualDiscrepancyCount || 0,
    topCategories: e.report.summary.topCategories,
    outDir: e.outDir,
  }));
  const passCount = perEntry.filter((e) => e.status === 'pass').length;
  return {
    generatedAt,
    entryCount: entries.length,
    passCount,
    needsReviewCount: entries.length - passCount,
    // Per-category discrepancy totals across the corpus — the numbers Tier 4
    // watches for accept/regress between iterations.
    categoryTotals: aggregateCategoryTotals(entries),
    entries: perEntry,
  };
}

function aggregateCategoryTotals(entries) {
  const totals = {};
  for (const e of entries) {
    for (const cat of e.report.tier3.categories || []) {
      if (!totals[cat.category]) {
        totals[cat.category] = { category: cat.category, count: 0, severities: {} };
      }
      totals[cat.category].count += cat.count;
      totals[cat.category].severities[cat.severity] = (totals[cat.category].severities[cat.severity] || 0) + 1;
    }
  }
  return Object.values(totals).sort((a, b) => b.count - a.count);
}

export function writeReport(outDir, report) {
  writeJson(resolve(outDir, 'report.json'), report);
}
