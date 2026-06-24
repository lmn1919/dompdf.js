import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { rollup } from 'rollup';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const banner = `/*!
 * ${pkg.name} ${pkg.version} <${pkg.homepage}>
 * Copyright (c) ${new Date().getFullYear()} ${pkg.author.name}
 * Released under ${pkg.license} License
 */`;

const sharedPlugins = (tsOptions = {}) => [
  resolve({ exportConditions: ['browser', 'module', 'import', 'default'] }),
  commonjs({ include: 'node_modules/**' }),
  typescript({ sourceMap: true, inlineSources: true, declaration: false, ...tsOptions }),
];

/**
 * Inline Web Worker plugin.
 *
 * Replaces Vite's `?worker&inline` semantics for rollup: when a module imports
 * `./worker?worker&inline`, the referenced file is bundled separately as an
 * IIFE, wrapped in a Blob URL, and a default-exported factory is returned so
 * `new Dom2pdfWorker()` works exactly as before.
 */
function inlineWorker() {
  return {
    name: 'inline-worker',
    resolveId(source, importer) {
      if (!source.includes('?worker&inline')) return null;
      if (!importer) return source;
      const workerFile = source.replace(/\?worker&inline.*$/, '');
      const resolved = path.resolve(path.dirname(importer), workerFile);
      const withExtension = path.extname(resolved) ? resolved : `${resolved}.ts`;
      return `${withExtension}?worker&inline`;
    },
    async load(id) {
      if (!id.includes('?worker&inline')) return null;
      const workerFile = id.replace(/\?worker&inline.*$/, '');
      const bundle = await rollup({
        input: workerFile,
        plugins: [
          resolve({ exportConditions: ['browser', 'module', 'import', 'default'] }),
          commonjs({ include: 'node_modules/**' }),
          typescript({ sourceMap: false, inlineSources: false, declaration: false }),
        ],
      });
      const { output } = await bundle.generate({ format: 'iife' });
      await bundle.close();
      const workerCode = output[0].code;
      const blob = JSON.stringify(workerCode);
      return {
        code: `var src = ${blob};
var blob = new Blob([src], { type: 'application/javascript' });
var url = URL.createObjectURL(blob);
function Dom2pdfWorker() { return new Worker(url); }
export default Dom2pdfWorker;`,
        moduleSideEffects: true,
      };
    },
  };
}

// UMD build: single-file, inline dynamic imports (UMD has no code-splitting)
const umdConfig = {
  input: 'src/index.ts',
  output: [
    {
      file: pkg.main,
      name: 'dompdf',
      format: 'umd',
      exports: 'named',
      banner,
      sourcemap: true,
      inlineDynamicImports: true,
    },
    {
      file: 'dist/dompdf.min.js',
      name: 'dompdf',
      format: 'umd',
      exports: 'named',
      banner,
      sourcemap: true,
      inlineDynamicImports: true,
      plugins: [
        terser({
          compress: { drop_console: true, passes: 2 },
          format: { comments: /^!/ },
        }),
      ],
    },
  ],
  plugins: [...sharedPlugins(), inlineWorker()],
};

// ESM build: code-splitting allowed
const esmConfig = {
  input: 'src/index.ts',
  output: {
    dir: 'dist/esm',
    format: 'esm',
    entryFileNames: 'dompdf.esm.js',
    banner,
    sourcemap: true,
  },
  plugins: [
    ...sharedPlugins({ outDir: 'dist/esm', declaration: false, declarationDir: undefined }),
    inlineWorker(),
  ],
};

export default [umdConfig, esmConfig];
