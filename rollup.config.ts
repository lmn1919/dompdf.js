import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import resolve from '@rollup/plugin-node-resolve';
import typescript from '@rollup/plugin-typescript';
import sourceMaps from 'rollup-plugin-sourcemaps';
const serve = require('rollup-plugin-serve')
const livereload = require('rollup-plugin-livereload')

const pkg = require('./package.json');

const banner = `/*!
 * ${pkg.title} ${pkg.version} <${pkg.homepage}>
 * Copyright (c) ${(new Date()).getFullYear()} ${pkg.author.name} <${pkg.author.url}>
 * Released under ${pkg.license} License
 */`;

export default {
    input: `src/index.ts`,
    output: [
        { file: pkg.main, name: 'dompdf', format: 'umd', banner, sourcemap: true, inlineDynamicImports: true},
        { file: pkg.module, format: 'esm', banner, sourcemap: true,inlineDynamicImports: true},
        
    ],
    external: [],
    watch: {
        include: 'src/**',
    },
    plugins: [
        // Allow node_modules resolution, so you can use 'external' to control
        // which external modules to include in the bundle
        // https://github.com/rollup/rollup-plugin-node-resolve#usage
        resolve(),
        // Allow json resolution
        json(),
        // Compile TypeScript files
        typescript({ sourceMap: true, inlineSources: true }),
        // Allow bundling cjs modules (unlike webpack, rollup doesn't understand cjs)
        commonjs({
            include: 'node_modules/**',
            
        }),
        // serve({
        //     port: 8090,
        //     open: true,
        //     // 依赖的文件夹
        //     contentBase: './build'
        //   }),

          livereload(),

        // Resolve source maps to the original source
        sourceMaps(),
    ],
}
