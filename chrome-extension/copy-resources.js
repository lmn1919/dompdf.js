/**
 * 复制资源文件到 chrome-extension 目录
 * 运行方法：在 dompdf.js 根目录执行 node chrome-extension/copy-resources.js
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const extDir = __dirname;

// 确保目录存在
const dirs = ['lib', 'fonts'];
dirs.forEach(d => {
  const dir = path.join(extDir, d);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// 复制 dompdf.min.js
const src1 = path.join(root, 'dist', 'dompdf.min.js');
const dst1 = path.join(extDir, 'lib', 'dompdf.min.js');
fs.copyFileSync(src1, dst1);
console.log(`✓ 已复制 ${path.relative(root, src1)} → ${path.relative(root, dst1)}`);

// 复制字体
const src2 = path.join(root, 'examples', 'SourceHanSansSC-Regular.ttf');
const dst2 = path.join(extDir, 'fonts', 'SourceHanSansSC-Regular.ttf');
fs.copyFileSync(src2, dst2);
console.log(`✓ 已复制 ${path.relative(root, src2)} → ${path.relative(root, dst2)}`);

// 同时复制 dompdf.min.js.map 方便调试
const src3 = path.join(root, 'dist', 'dompdf.min.js.map');
const dst3 = path.join(extDir, 'lib', 'dompdf.min.js.map');
if (fs.existsSync(src3)) {
  fs.copyFileSync(src3, dst3);
  console.log(`✓ 已复制 ${path.relative(root, src3)} → ${path.relative(root, dst3)}`);
}

console.log('\n✅ 资源复制完成！');
