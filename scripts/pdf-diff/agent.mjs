#!/usr/bin/env node
// pdf-diff agent — JSON CLI over Tier 0–4, designed for AI coding tools.
//
// Usage:
//   node scripts/pdf-diff/agent.mjs capabilities
//   node scripts/pdf-diff/agent.mjs run --url <u> --selector <s>
//   node scripts/pdf-diff/agent.mjs all
//   node scripts/pdf-diff/agent.mjs suggest [--rebuild]
//   node scripts/pdf-diff/agent.mjs categories --report-path <path>
//
// All output is strict JSON on stdout (one object). On error: { error, message }
// and exit code 1. Human-readable progress goes to stderr so stdout stays clean
// for machine parsing. Suppress stderr with 2>/dev/null.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { dispatchTool, capabilities } from './lib/agent-core.mjs';

function out(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'capabilities';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    const next = rest[i + 1];
    if (a === '--url' && next) { args.url = next; i += 1; }
    else if (a === '--selector' && next) { args.selector = next; i += 1; }
    else if (a === '--remove' && next) { args.removeSelectors = next.split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (a === '--report-path' && next) { args.reportPath = resolve(next); i += 1; }
    else if (a === '--skip-inspect') { args.skipInspect = true; }
    else if (a === '--rebuild') { args.rebuild = true; }
    else if (a === '--threshold' && next) { args.threshold = Number(next); i += 1; }
    else if (a === '--page-limit' && next) { args.pageLimit = Number(next); i += 1; }
  }
  return { cmd, args };
}

const CMD_TO_TOOL = {
  run: 'pdf_diff_run',
  all: 'pdf_diff_all',
  suggest: 'pdf_diff_suggest',
  categories: 'pdf_diff_categories',
  capabilities: 'pdf_diff_capabilities',
};

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const tool = CMD_TO_TOOL[cmd];
  if (!tool) {
    out({ error: 'unknown-command', message: `未知子命令: ${cmd}。可用: ${Object.keys(CMD_TO_TOOL).join(', ')}` });
    process.exit(1);
  }

  // --rebuild 由 agent-core 在各工具内处理（run/all/suggest 均支持），
  // 这里不再自行构建，避免与工具实现重复执行两次 npm run build。
  try {
    const result = await dispatchTool(tool, args);
    out(result);
  } catch (error) {
    out({ error: error.code || 'tool-error', message: error.message });
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
