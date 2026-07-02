import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function writeJson(filePath, value) {
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function base64ToBuffer(base64) {
  return Buffer.from(base64, 'base64');
}

export function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

export function withTimeout(promise, timeoutMs, label) {
  // Clear the timer once the race settles — a leftover timeout keeps the Node
  // event loop alive, stalling process exit for up to timeoutMs after success.
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function resolvePath(input) {
  return resolve(input);
}
