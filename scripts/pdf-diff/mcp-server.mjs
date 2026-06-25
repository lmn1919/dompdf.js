#!/usr/bin/env node
// Minimal MCP (Model Context Protocol) stdio server for the pdf-diff agent.
//
// Exposes the Tier 0–4 tools so AI coding tools (Claude Code, Cursor, etc.) can
// call them natively as MCP tools. Hand-rolled JSON-RPC 2.0 over stdio — no
// external SDK dependency.
//
// Wire it into Claude Code by adding to .mcp.json (project) or user settings:
//   {
//     "mcpServers": {
//       "pdf-diff": {
//         "command": "node",
//         "args": ["scripts/pdf-diff/mcp-server.mjs"]
//       }
//     }
//   }
//
// Then tools appear as: pdf_diff_run, pdf_diff_all, pdf_diff_suggest,
// pdf_diff_categories, pdf_diff_capabilities.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { dispatchTool, capabilities } from './lib/agent-core.mjs';
import { rootDir } from './lib/server.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'pdf-diff-agent', version: '0.1.0' };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function err(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

// Read newline-delimited JSON-RPC from stdin.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    handle(line).catch((e) => {
      // Best-effort: malformed messages have no id to reply to.
      console.error('[pdf-diff mcp] parse/handle error:', e.message);
    });
  }
});

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON lines
  }
  const { id, method, params } = msg;

  // Notifications (no id) — respond silently.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return;
    return;
  }

  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'ping':
      ok(id, {});
      return;
    case 'tools/list':
      ok(id, { tools: toMcpTools(capabilities().tools) });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await dispatchTool(name, args);
        ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (error) {
        ok(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: error.code || 'tool-error', message: error.message }, null, 2) }],
          isError: true,
        });
      }
      return;
    }
    default:
      err(id, -32601, `Method not found: ${method}`);
  }
}

// Convert our internal tool descriptors to MCP tool shape.
function toMcpTools(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

process.stdin.on('end', () => process.exit(0));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Server runs on stdin/stdout; nothing else to do.
}
