/**
 * 判断图片路径是否为指定类型的图片
 * @param {string} path 图片路径/URL（如 "../tests/assets/image.svg"、"https://xxx.com/photo.webp"）
 * @param {("svg" | "webp" | "png" | "jpg" | "gif" | "unknown")} type 要判断的图片类型
 * @returns {boolean} 是否为指定类型的图片
 */
export function getImageTypeByPath(path: string, type: "svg" | "webp" | "png" | "jpg" | "gif" | "unknown"): boolean {
  if (!path || !type) return false;
  const purePath = path.split('?')[0].split('#')[0];
  const ext = purePath.split('.').pop()?.toLowerCase() || '';
  if (type === 'jpg') {
    return ext === 'jpg' || ext === 'jpeg';
  }
  return ext === type;
}