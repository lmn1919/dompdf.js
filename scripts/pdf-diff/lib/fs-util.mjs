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
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

export function resolvePath(input) {
  return resolve(input);
}
