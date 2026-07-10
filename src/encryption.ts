import { type PdfEncryptionOptions, normalizeEncryptionOptions } from './snapshot';

const CONFIG_VERSION = 1;
const FILE_ID_LENGTH = 16;

function createFileId(): Uint8Array {
  const fileId = new Uint8Array(FILE_ID_LENGTH);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(fileId);
    return fileId;
  }
  for (let i = 0; i < fileId.length; i++) {
    fileId[i] = Math.floor(Math.random() * 256) & 0xff;
  }
  return fileId;
}

function permissionMask(encryption: PdfEncryptionOptions): number {
  let mask = 0;
  for (const permission of encryption.userPermissions ?? []) {
    switch (permission) {
      case 'print':
        mask |= 1 << 0;
        break;
      case 'modify':
        mask |= 1 << 1;
        break;
      case 'copy':
        mask |= 1 << 2;
        break;
      case 'annot-forms':
        mask |= 1 << 3;
        break;
      default:
        break;
    }
  }
  return mask;
}

export function encodeEncryptionConfig(
  encryption?: PdfEncryptionOptions,
): Uint8Array | undefined {
  const normalized = normalizeEncryptionOptions(encryption);
  if (!normalized) return undefined;
  const encoder = new TextEncoder();
  const userBytes = encoder.encode(normalized.userPassword ?? '');
  const ownerBytes = encoder.encode(normalized.ownerPassword ?? '');
  const fileId = createFileId();
  const out = new Uint8Array(1 + 1 + 2 + 2 + FILE_ID_LENGTH + userBytes.length + ownerBytes.length);
  const view = new DataView(out.buffer);
  let offset = 0;
  view.setUint8(offset, CONFIG_VERSION);
  offset += 1;
  view.setUint8(offset, permissionMask(normalized));
  offset += 1;
  view.setUint16(offset, userBytes.length, true);
  offset += 2;
  view.setUint16(offset, ownerBytes.length, true);
  offset += 2;
  out.set(fileId, offset);
  offset += FILE_ID_LENGTH;
  out.set(userBytes, offset);
  offset += userBytes.length;
  out.set(ownerBytes, offset);
  return out;
}
