import { defineConfig } from 'vite';

export default defineConfig({
  worker: { format: 'es' },
  server: { port: 5173, open: true },
  optimizeDeps: { exclude: ['dom2pdf-wasm'] },
});
