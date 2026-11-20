// Records scripts/readme-gif/scene.html into assets/demo.gif.
//
//   npm run build            # scene loads dist/dompdf.js
//   node scripts/readme-gif/record.mjs [--fps 15] [--preview]
//
// The scene runs one real dompdf.js export, renders the resulting PDF with
// pdf.js, then the timeline is replayed deterministically frame by frame.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import gifenc from 'gifenc';

const { GIFEncoder, quantize, applyPalette } = gifenc;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const fps = Number(args[args.indexOf('--fps') + 1]) || 15;
const preview = args.includes('--preview');
const out = path.join(root, 'assets', 'demo.gif');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1040, height: 600 }, deviceScaleFactor: 1 });
page.on('console', (m) => m.type() === 'error' && console.error('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`http://localhost:${port}/scripts/readme-gif/scene.html`);
await page.waitForFunction(() => window.scene && window.dompdf);
await page.evaluate(() => document.fonts.ready);
const info = await page.evaluate(() => window.scene.prepare());
console.log('export:', info);
const total = await page.evaluate(() => window.scene.T.total);

if (preview) {
  const dir = path.join(root, 'tmp', 'readme-gif');
  fs.mkdirSync(dir, { recursive: true });
  for (const t of [1, 2.3, 3.2, 4.8, 6.9, 9.5]) {
    await page.evaluate((t) => window.scene.seek(t), t);
    await page.screenshot({ path: path.join(dir, `t${t}.png`) });
  }
  console.log('preview frames ->', dir);
} else {
  const n = Math.round(total * fps);
  const frames = [];
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.scene.seek(t), i / fps);
    const png = PNG.sync.read(await page.screenshot({ type: 'png' }));
    frames.push(png.data);
  }
  const { width, height } = { width: 1040, height: 600 };

  // One shared palette for all frames avoids colour shimmer between frames.
  const step = Math.max(1, Math.floor(frames.length / 12));
  const sample = Buffer.concat(frames.filter((_, i) => i % step === 0).map((f) => Buffer.from(f)));
  const palette = quantize(sample, 255, { format: 'rgb565' });
  const T = palette.length; // extra slot = "unchanged since last frame"
  palette.push([255, 0, 255]);

  const gif = GIFEncoder();
  const delay = 1000 / fps;
  let prev = null, hold = 0, pending = null, first = true;
  const flush = () => {
    if (!pending) return;
    const opts = { palette, delay: Math.round(delay * hold), dispose: 1 };
    if (!first) Object.assign(opts, { transparent: true, transparentIndex: T });
    gif.writeFrame(pending, width, height, opts);
    first = false;
  };
  for (const f of frames) {
    const idx = applyPalette(f, palette.slice(0, T), 'rgb565');
    if (prev && Buffer.compare(Buffer.from(idx), Buffer.from(prev)) === 0) { hold++; continue; }
    flush();
    // only changed pixels are stored; the rest stay transparent and compress to ~nothing
    const delta = prev ? idx.map((v, i) => (v === prev[i] ? T : v)) : idx;
    pending = delta; prev = idx; hold = 1;
  }
  hold += Math.round(fps * 1.2); // linger on the last frame before looping
  flush();
  gif.finish();
  fs.writeFileSync(out, gif.bytes());
  console.log(`${frames.length} frames -> ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
}

await browser.close();
server.close();
