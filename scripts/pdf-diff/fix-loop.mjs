import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, writeJson } from './lib/fs-util.mjs';
import { rootDir } from './lib/server.mjs';
import { runBuild } from './lib/build.mjs';
import { runAll } from './run-all.mjs';
import { parseCorpusArgs } from './corpus.mjs';

// Tier 4 — semi-automatic fix loop.
//
// One-shot:  build report (optionally --rebuild first) → emit fix-suggestions.{md,json}.
// --watch:   poll wasm/src + src for changes; on change rebuild → rerun → compare
//            to the previous iteration (per-category counts + per-entry mismatch),
//            printing accept/regress/no-change. Never edits source.

export const RUNS_DIR = resolve(rootDir, 'tmp', 'pdf-diff-runs');
const LAST_RUN = resolve(RUNS_DIR, 'last.json');

export function snapshotAggregate(aggregate) {
  const entries = {};
  for (const e of aggregate.entries || []) {
    entries[e.name] = {
      mismatch: e.aggregateMismatchRatio,
      discrepancies: e.discrepancyCount,
    };
  }
  const categories = {};
  for (const c of aggregate.categoryTotals || []) categories[c.category] = c.count;
  return { generatedAt: aggregate.generatedAt, entries, categories };
}

function readEntryReports(outRoot) {
  const reports = [];
  if (!existsSync(outRoot)) return reports;
  for (const name of readdirSync(outRoot)) {
    const p = resolve(outRoot, name, 'report.json');
    if (existsSync(p)) {
      reports.push({ name, report: JSON.parse(readFileSync(p, 'utf8')) });
    }
  }
  return reports;
}

export function emitSuggestions(outRoot, aggregate) {
  const entryReports = readEntryReports(outRoot);
  const merged = {};
  for (const { name, report } of entryReports) {
    for (const cat of report.tier3?.categories || []) {
      if (!merged[cat.category]) {
        merged[cat.category] = {
          category: cat.category,
          severity: cat.severity,
          count: 0,
          affectedEntries: [],
          suspected: cat.suspected,
          hint: cat.hint,
          samples: [],
          evidence: [],
        };
      }
      const m = merged[cat.category];
      m.count += cat.count;
      m.affectedEntries.push(name);
      const sevRank = { high: 0, medium: 1, low: 2 };
      if (sevRank[cat.severity] < sevRank[m.severity]) m.severity = cat.severity;
      for (const s of cat.samples || []) {
        if (m.samples.length < 5) m.samples.push({ entry: name, ...s });
      }
      if (cat.evidence) m.evidence.push({ entry: name, ...cat.evidence });
    }
  }

  const suggestions = Object.values(merged)
    .filter((s) => s.count > 0 || s.severity === 'high' || s.severity === 'medium')
    .sort((a, b) => {
      const sevRank = { high: 0, medium: 1, low: 2 };
      return (sevRank[a.severity] - sevRank[b.severity]) || (b.count - a.count);
    })
    .map((s) => ({
      ...s,
      suggestedFix: s.hint,
      verifyMethod: '修改后执行 npm run build，再跑 pdf-diff:all；该类别 count 应下降，baseline --check 应 PASS。',
    }));

  writeJson(resolve(RUNS_DIR, 'fix-suggestions.json'), { generatedAt: aggregate.generatedAt, suggestions });
  writeFileSync(resolve(RUNS_DIR, 'fix-suggestions.md'), renderSuggestionsMd(suggestions, aggregate));
  return suggestions;
}

function renderSuggestionsMd(suggestions, aggregate) {
  const lines = [];
  lines.push('# Tier 4 自动修复建议（半自动）');
  lines.push('');
  lines.push(`生成时间: ${aggregate.generatedAt}`);
  lines.push(`语料: ${aggregate.entryCount} 条 (pass=${aggregate.passCount}, needs-review=${aggregate.needsReviewCount})`);
  lines.push('');
  lines.push('> 本文件由 fix-loop 生成，仅定位根因与建议改法，不修改源码。请人工确认后再改。');
  lines.push('');
  if (suggestions.length === 0) {
    lines.push('未检测到可定位的差异类别。若仍有像素差异，参考 Tier 1 报告人工排查。');
  }
  suggestions.forEach((s, idx) => {
    lines.push(`## ${idx + 1}. ${s.category}  (severity: ${s.severity}, count: ${s.count})`);
    lines.push('');
    lines.push(`- **疑似核心方法**: \`${s.suspected.file}::${s.suspected.fn}\``);
    if (s.suspected.also) lines.push(`- **相关**: ${s.suspected.also}`);
    lines.push(`- **影响语料**: ${[...new Set(s.affectedEntries)].join(', ')}`);
    lines.push(`- **建议改法**: ${s.suggestedFix}`);
    lines.push(`- **验证方法**: ${s.verifyMethod}`);
    if (s.samples.length > 0) {
      lines.push('- **证据样本**:');
      for (const sm of s.samples.slice(0, 3)) {
        lines.push(`  - [${sm.entry}] ${formatSample(sm)}`);
      }
    }
    lines.push('');
  });
  return lines.join('\n');
}

// Samples come in two shapes: text discrepancies (oracle/actual boxes + Δx/Δy) and
// non-text visual discrepancies (box + expected/actual strings + kind). Format each
// by its shape so the visual ones don't try to read a missing `oracle`.
function formatSample(sm) {
  if (sm.oracle) {
    return `"${truncate(sm.text, 40)}" oracle(${sm.oracle.x},${sm.oracle.y},fs=${sm.oracle.fontSize}) actual(${sm.actual.x},${sm.actual.y},fs=${sm.actual.fontSize}) Δ(dx=${sm.delta.dx},dy=${sm.delta.dy},dfs=${sm.delta.dFontSize})`;
  }
  const box = sm.box ? `box(${sm.box.x},${sm.box.y},${sm.box.w}×${sm.box.h})` : '';
  const side = sm.side ? ` ${sm.side}` : '';
  const delta = sm.delta ? ` ${JSON.stringify(sm.delta)}` : '';
  return `${sm.tag || ''}${side} ${box} ${sm.kind}: ${sm.expected} → ${sm.actual}${delta}`.trim();
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function compareRuns(prev, curr) {
  if (!prev) {
    console.log('[fix-loop] 首次运行，无对比基线。');
    return;
  }
  console.log('\n=== 迭代对比 ===');
  const allCats = new Set([...Object.keys(prev.categories), ...Object.keys(curr.categories)]);
  let anyRegress = false;
  for (const cat of allCats) {
    const p = prev.categories[cat] || 0;
    const c = curr.categories[cat] || 0;
    if (c === p) {
      console.log(`  [${cat}] ${p} → ${c}  (no-change)`);
    } else if (c < p) {
      console.log(`  [${cat}] ${p} → ${c}  ✅ accept (改善 ${p - c})`);
    } else {
      anyRegress = true;
      console.log(`  [${cat}] ${p} → ${c}  ⚠️ regress (恶化 ${c - p})`);
    }
  }
  const allNames = new Set([...Object.keys(prev.entries), ...Object.keys(curr.entries)]);
  for (const name of allNames) {
    const p = prev.entries[name];
    const c = curr.entries[name];
    if (!p || !c) continue;
    const dm = (c.mismatch || 0) - (p.mismatch || 0);
    const dd = (c.discrepancies || 0) - (p.discrepancies || 0);
    if (Math.abs(dm) < 0.0005 && dd === 0) continue;
    const label = dm > 0.0005 || dd > 0 ? '⚠️ regress' : '✅ accept';
    console.log(`  entry ${name}: mismatch Δ${dm.toFixed(4)} discrepancies Δ${dd}  ${label}`);
    if (dm > 0.0005 || dd > 0) anyRegress = true;
  }
  console.log(anyRegress ? '本轮结论: 存在回归，建议回退。' : '本轮结论: 无回归。');
}

function collectSourceMtimes() {
  const dirs = [resolve(rootDir, 'wasm', 'src'), resolve(rootDir, 'src')];
  const mtimes = {};
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.isFile()) mtimes[p] = st.mtimeMs;
      } catch { /* ignore */ }
    }
  }
  return mtimes;
}

function mtimesChanged(prev, curr) {
  const keys = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  for (const k of keys) {
    if (prev[k] !== curr[k]) return true;
  }
  return false;
}

async function iterate(options, { rebuild }) {
  if (rebuild) runBuild();
  const { aggregate, outRoot } = await runAll(options);
  emitSuggestions(outRoot, aggregate);
  const curr = snapshotAggregate(aggregate);
  let prev = null;
  if (existsSync(LAST_RUN)) {
    try { prev = JSON.parse(readFileSync(LAST_RUN, 'utf8')); } catch { prev = null; }
  }
  compareRuns(prev, curr);
  writeJson(LAST_RUN, curr);
  console.log(`[fix-loop] 建议文件: ${resolve(RUNS_DIR, 'fix-suggestions.md')}`);
  return curr;
}

async function watchLoop(options) {
  ensureDir(RUNS_DIR);
  console.log('[fix-loop] --watch 模式：首次运行 ...');
  await iterate(options, { rebuild: false });
  let lastMtimes = collectSourceMtimes();
  console.log('[fix-loop] 监听 wasm/src 与 src 变化（每 4s 轮询）... 按 Ctrl+C 退出。');
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(4000);
    const now = collectSourceMtimes();
    if (mtimesChanged(lastMtimes, now)) {
      lastMtimes = now;
      console.log('\n[fix-loop] 检测到源码变化，重建并重跑 ...');
      try {
        await iterate(options, { rebuild: true });
      } catch (error) {
        console.error('[fix-loop] 迭代失败:', error.message);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseCorpusArgs(argv);
  const watch = argv.includes('--watch');
  const rebuild = argv.includes('--rebuild');
  ensureDir(RUNS_DIR);
  if (watch) {
    await watchLoop(options);
  } else {
    await iterate(options, { rebuild });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[pdf-diff fix-loop] 失败:', error);
    process.exit(1);
  });
}
