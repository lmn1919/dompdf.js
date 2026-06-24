// Build the Rust crate to wasm32 and copy the artifact into wasm/pkg.
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const crate = path.join(root, 'wasm');

execSync('cargo build --target wasm32-unknown-unknown --release', {
  stdio: 'inherit',
  cwd: crate,
});

const src = path.join(
  crate,
  'target/wasm32-unknown-unknown/release/dom2pdf_wasm.wasm',
);
const outDir = path.join(crate, 'pkg');
mkdirSync(outDir, { recursive: true });
copyFileSync(src, path.join(outDir, 'dom2pdf_wasm.wasm'));
console.log('wasm copied to wasm/pkg/dom2pdf_wasm.wasm');
