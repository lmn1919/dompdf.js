// Build the Rust crate to wasm32 and copy the artifact into packages/dom2pdf-wasm/pkg.
import { execSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const crate = path.join(root, 'packages/dom2pdf-wasm');

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
console.log('wasm copied to packages/dom2pdf-wasm/pkg/dom2pdf_wasm.wasm');
