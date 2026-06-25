import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootDir } from './lib/server.mjs';

// Regression gate. Save an aggregate as the baseline; later runs check against it.
// Any entry whose mismatch or discrepancy count regresses (beyond tolerance)
// causes non-zero exit — usable as a CI gate.

const DEFAULT_BASELINE = resolve(rootDir, 'scripts', 'pdf-diff', 'baseline.json');

function loadAggregate(path) {
  if (!existsSync(path)) throw new Error(`找不到报告: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function snapshot(aggregate) {
  const entries = {};
  for (const e of aggregate.entries || []) {
    entries[e.name] = {
      aggregateMismatchRatio: e.aggregateMismatchRatio,
      maxMismatchRatio: e.maxMismatchRatio,
      discrepancyCount: e.discrepancyCount,
    };
  }
  const categories = {};
  for (const c of aggregate.categoryTotals || []) {
    categories[c.category] = c.count;
  }
  return { generatedAt: aggregate.generatedAt, entries, categories };
}

export function saveBaseline(aggregatePath, baselinePath = DEFAULT_BASELINE) {
  const aggregate = loadAggregate(aggregatePath);
  const snap = snapshot(aggregate);
  writeFileSync(baselinePath, JSON.stringify(snap, null, 2));
  console.log(`基线已保存: ${baselinePath} (entries=${Object.keys(snap.entries).length}, categories=${Object.keys(snap.categories).length})`);
  return snap;
}

export function checkBaseline(aggregatePath, baselinePath = DEFAULT_BASELINE, tolerance = 0.005) {
  if (!existsSync(baselinePath)) {
    console.log(`未找到基线 ${baselinePath}，跳过检查（首次运行）。`);
    return { regressed: false, deltas: [] };
  }
  const aggregate = loadAggregate(aggregatePath);
  const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const current = snapshot(aggregate);
  const deltas = [];
  let regressed = false;

  const allNames = new Set([...Object.keys(base.entries), ...Object.keys(current.entries)]);
  for (const name of allNames) {
    const b = base.entries[name];
    const c = current.entries[name];
    if (!b) { deltas.push({ kind: 'entry-added', name }); continue; }
    if (!c) { deltas.push({ kind: 'entry-removed', name }); continue; }
    const dMismatch = (c.aggregateMismatchRatio || 0) - (b.aggregateMismatchRatio || 0);
    const dDiscrepancy = (c.discrepancyCount || 0) - (b.discrepancyCount || 0);
    if (dMismatch > tolerance || dDiscrepancy > 0) {
      regressed = true;
      deltas.push({ kind: 'entry-regress', name, dMismatch, dDiscrepancy, base: b, current: c });
    } else if (dMismatch < -tolerance || dDiscrepancy < 0) {
      deltas.push({ kind: 'entry-improved', name, dMismatch, dDiscrepancy });
    }
  }

  const allCats = new Set([...Object.keys(base.categories), ...Object.keys(current.categories)]);
  for (const cat of allCats) {
    const b = base.categories[cat] || 0;
    const c = current.categories[cat] || 0;
    if (c > b) {
      regressed = true;
      deltas.push({ kind: 'category-regress', category: cat, base: b, current: c });
    } else if (c < b) {
      deltas.push({ kind: 'category-improved', category: cat, base: b, current: c });
    }
  }

  for (const d of deltas) {
    const tag = d.kind.endsWith('regress') ? '⚠️ REGRESS' : d.kind.endsWith('improved') ? '✅ improved' : d.kind;
    if (d.kind === 'entry-regress') {
      console.log(`  ${tag} ${d.name}: Δmismatch=${d.dMismatch.toFixed(4)} Δdiscrepancy=${d.dDiscrepancy}`);
    } else if (d.kind === 'category-regress' || d.kind === 'category-improved') {
      console.log(`  ${tag} [${d.category}]: ${d.base} → ${d.current}`);
    } else {
      console.log(`  ${tag} ${d.name || d.category}`);
    }
  }
  console.log(regressed ? '回归检查: FAIL' : '回归检查: PASS');
  return { regressed, deltas };
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const reportArg = argv.find((a) => !a.startsWith('-') && a !== cmd);
  if (cmd === '--save') {
    saveBaseline(reportArg || findLatestAggregate());
  } else if (cmd === '--check') {
    const { regressed } = checkBaseline(reportArg || findLatestAggregate());
    if (regressed) process.exit(1);
  } else {
    console.log('用法: node baseline.mjs --save [aggregate-report.json] | --check [aggregate-report.json]');
  }
}

function findLatestAggregate() {
  // Walk tmp/pdf-diff/*/aggregate-report.json — caller should pass explicitly;
  // fall back to a sensible default if present.
  const fallback = resolve(rootDir, 'tmp', 'pdf-diff', 'aggregate-report.json');
  return fallback;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
