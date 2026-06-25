// Shared core for the agent interfaces (JSON CLI + MCP server). Both expose the
// same small, machine-readable surface over Tier 0–4 so an AI coding tool can
// drive the pdf-diff system programmatically.
//
// Every function returns a plain object (never prints). Errors throw — callers
// (CLI / MCP) decide how to serialize them.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAll } from '../run-all.mjs';
import { parseCorpusArgs, buildCorpus } from '../corpus.mjs';
import { emitSuggestions, snapshotAggregate, RUNS_DIR } from '../fix-loop.mjs';
import { rootDir } from './server.mjs';

// Describe the agent's tool surface — AI tools can call `capabilities` to
// self-discover. Mirrors the MCP tools/list response.
export function capabilities() {
  return {
    name: 'pdf-diff-agent',
    version: '0.1.0',
    description: 'Tier 0–4 PDF 对比与自动修复定位（dompdf.js）。给定 URL+选择器，生成参照 PDF、结构化文本对比、根因分类、修复建议。',
    tools: [
      {
        name: 'pdf_diff_run',
        description: '对单个语料 (url+selector) 跑 Tier 0–3，返回 report（含 pixel mismatch、文本 discrepancies、根因 categories）。',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '页面 URL（留空用本地 examples 页）' },
            selector: { type: 'string', description: 'CSS 选择器（默认 #document）' },
            removeSelectors: { type: 'array', items: { type: 'string' } },
            skipInspect: { type: 'boolean', default: false },
            threshold: { type: 'number', default: 0.1 },
            pageLimit: { type: 'number', default: 0 },
          },
        },
        returns: 'report 对象（summary + tier1 + tier2 + tier3 + output 路径）',
      },
      {
        name: 'pdf_diff_all',
        description: '对整个语料库跑 Tier 0–3，返回 aggregate-report（每条 mismatch/discrepancy + 跨语料类别计数）。',
        inputSchema: { type: 'object', properties: { url: { type: 'string' }, selector: { type: 'string' } } },
        returns: 'aggregate 对象 + outRoot',
      },
      {
        name: 'pdf_diff_suggest',
        description: 'Tier 4：跑全流程并生成修复建议（根因类别 + 疑似 Rust/WASM 核心方法 + 证据样本 + 改法）。半自动，不改源码。',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            selector: { type: 'string' },
            rebuild: { type: 'boolean', default: false, description: '先 npm run build 再跑' },
          },
        },
        returns: '{ suggestions[], aggregate, files: {md, json, lastRun} }',
      },
      {
        name: 'pdf_diff_categories',
        description: '从已有 report.json 读取并返回分类后的根因类别（不重跑浏览器）。',
        inputSchema: {
          type: 'object',
          properties: { reportPath: { type: 'string', description: 'report.json 路径' } },
          required: ['reportPath'],
        },
        returns: 'categories[]',
      },
      {
        name: 'pdf_diff_capabilities',
        description: '返回本 agent 的工具清单与参数 schema（自描述）。',
        inputSchema: { type: 'object' },
        returns: 'capabilities 对象',
      },
    ],
  };
}

// runAll/runEntry print human progress via console.log (stdout). For machine
// callers (JSON CLI stdout, MCP JSON-RPC stream) that noise must not reach
// stdout — redirect console.log to stderr for the duration of a tool call.
async function withStderrLogsAsync(fn) {
  const origLog = console.log;
  console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  try {
    return await fn();
  } finally {
    console.log = origLog;
  }
}

function mergeOptions(input = {}) {
  // Accept either CLI-style flat args or structured MCP args.
  const opts = parseCorpusArgs([]);
  if (input.url) opts.url = input.url;
  if (input.selector) opts.selector = input.selector;
  if (Array.isArray(input.removeSelectors)) opts.removeSelectors = input.removeSelectors;
  if (typeof input.skipInspect === 'boolean') opts.skipInspect = input.skipInspect;
  if (typeof input.threshold === 'number') opts.threshold = input.threshold;
  if (typeof input.pageLimit === 'number') opts.pageLimit = input.pageLimit;
  if (typeof input.exportTimeoutMs === 'number') opts.exportTimeoutMs = input.exportTimeoutMs;
  if (typeof input.port === 'number') opts.port = input.port;
  return opts;
}

// --- tool implementations ---

export async function pdfDiffRun(input = {}) {
  const options = mergeOptions(input);
  return withStderrLogsAsync(async () => {
    const { aggregate, outRoot } = await runAll(options);
    const entry = aggregate.entries[0];
    const reportPath = resolve(outRoot, entry.name, 'report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    return {
      report,
      outRoot,
      summary: report.summary,
      categories: report.tier3.categories,
    };
  });
}

export async function pdfDiffAll(input = {}) {
  const options = mergeOptions(input);
  return withStderrLogsAsync(async () => {
    const { aggregate, outRoot } = await runAll(options);
    return { aggregate, outRoot };
  });
}

export async function pdfDiffSuggest(input = {}) {
  const options = mergeOptions(input);
  return withStderrLogsAsync(async () => {
    const { aggregate, outRoot } = await runAll(options);
    const suggestions = emitSuggestions(outRoot, aggregate);
    const lastRun = snapshotAggregate(aggregate);
    return {
      suggestions,
      aggregate: {
        entryCount: aggregate.entryCount,
        passCount: aggregate.passCount,
        needsReviewCount: aggregate.needsReviewCount,
        categoryTotals: aggregate.categoryTotals,
      },
      files: {
        suggestionsMd: resolve(RUNS_DIR, 'fix-suggestions.md'),
        suggestionsJson: resolve(RUNS_DIR, 'fix-suggestions.json'),
        lastRun: resolve(RUNS_DIR, 'last.json'),
      },
    };
  });
}

export function pdfDiffCategories(input = {}) {
  const reportPath = input.reportPath;
  if (!reportPath || !existsSync(reportPath)) {
    throw new Error(`reportPath 不存在: ${reportPath}`);
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  return {
    input: report.input,
    summary: report.summary,
    categories: report.tier3.categories,
    tier2Summary: report.tier2?.summary,
  };
}

// Dispatch a tool call by name. Used by both CLI and MCP.
export async function dispatchTool(name, args = {}) {
  switch (name) {
    case 'pdf_diff_run': return await pdfDiffRun(args);
    case 'pdf_diff_all': return await pdfDiffAll(args);
    case 'pdf_diff_suggest': return await pdfDiffSuggest(args);
    case 'pdf_diff_categories': return pdfDiffCategories(args);
    case 'pdf_diff_capabilities': return capabilities();
    default: throw new Error(`未知工具: ${name}`);
  }
}
