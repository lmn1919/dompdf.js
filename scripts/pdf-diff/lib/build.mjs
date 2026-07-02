import { spawnSync } from 'node:child_process';
import { rootDir } from './server.mjs';

// Shared `npm run build` helper for fix-loop and the agent interfaces (CLI/MCP).
//
// - shell: true — on Windows npm is a .cmd shim that Node refuses to spawn
//   directly without a shell (EINVAL since the CVE-2024-27980 hardening).
// - Build output goes to stderr (fd 2) so machine-readable stdout (JSON CLI
//   single-object output, MCP JSON-RPC stream) stays clean.
export function runBuild() {
  console.error('[pdf-diff] 执行 npm run build ...');
  // Fixed command string (no user input) — a single string avoids the DEP0190
  // warning that shell:true + args array emits on newer Node.
  const result = spawnSync('npm run build', {
    cwd: rootDir,
    stdio: ['ignore', 2, 2],
    shell: true,
  });
  if (result.error) {
    throw new Error(`npm run build 启动失败: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm run build 失败 (exit ${result.status})`);
  }
}
