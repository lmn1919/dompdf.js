import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 库模式：把 dom2pdf 打包成 ESM + UMD + IIFE（单文件，WASM 内联为 base64）。
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Dom2pdf', // UMD / IIFE 全局变量名
      formats: ['es', 'umd'],
      fileName: (format) => `dom2pdf.${format}.js`,
    },
    outDir: 'dist',
    emptyOutDir: true,
    // 库模式下默认禁用 CSS 代码分割；我们也没有 CSS，保留默认即可。
    cssCodeSplit: false,
    rollupOptions: {
      // 不外部化任何依赖：WASM 已通过 base64 内联，worker 通过 inline blob 内联，
      // 整个库是一个自包含的 JS 文件。
      output: {
        // 单文件输出，inlineDynamicImports 避免 worker 动态导入产生额外 chunk。
        inlineDynamicImports: true,
      },
    },
    // WASM base64 字符串会很长，放宽 chunk 大小警告阈值。
    chunkSizeWarningLimit: 1500,
    target: 'es2020',
    minify: 'esbuild',
  },
  // worker 构建选项：内联 worker。
  worker: {
    format: 'es',
    plugins: () => [],
  },
  resolve: {
    alias: {
      // 让 src 内部模块互引使用相对路径即可，无需别名。
    },
  },
});
