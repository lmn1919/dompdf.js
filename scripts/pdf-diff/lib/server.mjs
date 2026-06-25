import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(__dirname, '..', '..', '..');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function startStaticServer(baseDir, port) {
  const server = createServer((req, res) => {
    const requestPath = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).pathname;
    const relativePath = requestPath === '/' ? '/examples/index.html' : requestPath;
    const localPath = normalize(resolve(baseDir, `.${relativePath}`));
    if (!localPath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    if (!existsSync(localPath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const stats = statSync(localPath);
    const filePath = stats.isDirectory() ? join(localPath, 'index.html') : localPath;
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    createReadStream(filePath).pipe(res);
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(port, '127.0.0.1', () => {
      resolveServer({
        close: () => new Promise((resolveClose) => server.close(resolveClose)),
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}
