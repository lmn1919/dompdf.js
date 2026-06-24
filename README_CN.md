# dompdf.js

[English](./README.md) | [中文](./README_CN.md)

纯前端 DOM 转 PDF 引擎（基于 WASM，不依赖 jsPDF）。该库允许您直接在用户浏览器中将网页或 DOM 元素生成为可编辑、非图片式、可打印的矢量 PDF。支持分页，可以生成数千页的 PDF 文件。

**在线体验：** [在线演示](https://dompdfjs.lisky.com.cn)

## 🚀 版本对比：新版 vs 旧版

### 新版 (v0.1.0+) - 当前版本
**技术栈：** Rust + WebAssembly + TypeScript + Worker
- **核心引擎：** 纯 Rust WASM 模块生成 PDF
- **架构：** 主线程收集 DOM 快照 → Worker 处理 → WASM 渲染 PDF
- **输出：** 真正的矢量 PDF（非图片式）
- **性能：** 渲染更快，文件更小
- **功能：** 高级排版、正确的文本选择、Unicode 支持

### 旧版 (传统版本)
**技术栈：** html2canvas + jsPDF + JavaScript
- **核心引擎：** 修改的 html2canvas canvas-renderer + jsPDF
- **架构：** DOM → Canvas 图片 → 嵌入图片的 PDF
- **输出：** 图片式 PDF（质量较低，文件较大）
- **性能：** 由于 canvas 渲染而较慢
- **功能：** 有限的文本支持，基础功能

### 新版主要改进
| 功能 | 旧版 | 新版 | 优势 |
|------|------|------|------|
| **PDF 质量** | 图片式（栅格） | 矢量式 | 文字更清晰，文件更小，内容可编辑 |
| **性能** | Canvas 渲染瓶颈 | WASM 优化 | 渲染速度提升 2-5 倍 |
| **文件大小** | 较大（嵌入图片） | 紧凑（矢量图形） | PDF 文件缩小 60-80% |
| **文本支持** | 基础英文字体 | 完整 Unicode + 自定义字体 | 正确的国际文本渲染 |
| **架构** | 单体 JavaScript | 模块化（Worker + WASM） | 更好的并行性，非阻塞 UI |
| **内存使用** | 高（canvas 缓冲区） | 优化（二进制快照） | 内存占用更低 |

## 📄 PDF 生成示例
![PDF 生成示例](./examples/test.jpg)

## 🛠️ 工作原理

该脚本采用现代流水线架构：

1. **DOM 快照收集**（主线程）：遍历 DOM 树，计算样式，捕获元素几何信息
2. **Worker 处理**：将快照传输到 Web Worker 进行后台处理
3. **WASM 渲染**：Rust 编译的 WebAssembly 模块生成 PDF 字节
4. **PDF 交付**：返回 PDF 作为 Blob 供下载或显示

### 优势
1. **纯客户端**：无需服务器端渲染
2. **矢量 PDF**：生成真正的 PDF 文件，而非图片式
3. **高质量**：可编辑文本，正确排版，可缩放图形
4. **文件小巧**：矢量图形紧凑
5. **无限制页数**：无 canvas 高度限制
6. **非阻塞**：基于 Worker 的架构保持 UI 响应

### 限制
1. **基于 DOM**：可能与浏览器渲染不完全像素一致
2. **CSS 支持**：某些高级 CSS 属性可能不完全支持
3. **复杂布局**：非常复杂的嵌套布局可能有渲染差异

## ✨ 功能特性

| 功能 | 状态 | 说明 |
|------|------|------|
| **分页** | ✅ | 支持 PDF 分页渲染，可生成数千页的 PDF 文件 |
| **文本渲染** | ✅ | 支持 Unicode 文本、字体家族、大小、样式、颜色、行高和文本对齐 |
| **图片渲染** | ✅ | 支持网络图片、base64 图片、SVG 图片，具有适当的缩放 |
| **边框** | ✅ | 支持边框宽度、颜色、样式和圆角 |
| **背景** | ✅ | 支持背景颜色、图片和渐变 |
| **Canvas** | ✅ | 支持渲染 HTML canvas 元素 |
| **SVG** | ✅ | 支持渲染 SVG 元素 |
| **渐变** | ✅ | 支持线性和径向渐变 |
| **自定义字体** | ✅ | 支持嵌入自定义 TTF/OTF 字体 |
| **PDF 加密** | ✅ | 支持密码保护和权限控制 |
| **页眉页脚** | ✅ | 可配置的页眉页脚，支持动态内容 |
| **精确分页控制** | ✅ | `divisionDisable` 和 `pageBreak` 属性用于布局控制 |
| **透明背景** | ✅ | 可生成透明背景的 PDF |
| **PDF 压缩** | ✅ | 可选的 PDF 压缩，减小文件大小 |

## 📦 安装

### NPM
```bash
npm install dompdf.js --save
```

### CDN
```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

### 基础用法
```js
import dompdf from 'dompdf.js';

dompdf(document.querySelector('#capture'), options)
    .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'example.pdf';
        document.body.appendChild(a);
        a.click();
    })
    .catch((err) => {
        console.error(err);
    });
```

## 📄 PDF 分页渲染

默认情况下，dompdf 会将整个文档渲染到单页中。通过设置 `pagination: true` 启用分页。

**重要：** 将 DOM 节点宽度设置为匹配页面宽度（像素）。对于 A4（210mm × 297mm），设置宽度为 794px。参见[页面尺寸参考](./page_sizes.md)。

```js
import dompdf from 'dompdf.js';

dompdf(document.querySelector('#capture'), {
    pagination: true,
    format: 'a4',
    pageConfig: {
        header: {
            content: '文档页眉',
            height: 50,
            contentColor: '#333333',
            contentFontSize: 12,
            contentPosition: 'center',
            padding: [0, 0, 0, 0]
        },
        footer: {
            content: '第${currentPage}页/共${totalPages}页',
            height: 50,
            contentColor: '#333333',
            contentFontSize: 12,
            contentPosition: 'center',
            padding: [0, 0, 0, 0]
        }
    }
}).then((blob) => {
    // 下载 PDF
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'document.pdf';
    a.click();
});
```

### 精确分页控制

#### `divisionDisable` 属性
防止容器跨页拆分：
```html
<div divisionDisable>
    如果此容器无法完全放入当前页，它将整体移至下一页。
</div>
```

#### `pageBreak` 属性
强制元素在新页面开始：
```html
<div pageBreak>
    此内容从下一页开始。
</div>
```

## ⚙️ 选项参数

| 参数名 | 必传 | 默认值 | 类型 | 说明 |
|--------|------|--------|------|------|
| `useCORS` | 否 | `false` | `boolean` | 允许跨域资源（需服务端 CORS 配置） |
| `backgroundColor` | 否 | 自动解析/白色 | `string \| null` | 覆盖页面背景色；传 `null` 生成透明背景 |
| `fontConfig` | 否 | - | `object \| Array` | 自定义字体配置（见下文） |
| `encryption` | 否 | 空配置 | `object` | PDF 加密：`userPassword`、`ownerPassword`、`userPermissions` |
| `precision` | 否 | `16` | `number` | 元素位置精度（越高越准确但文件越大） |
| `compress` | 否 | `false` | `boolean` | 启用 PDF 压缩 |
| `putOnlyUsedFonts` | 否 | `false` | `boolean` | 仅嵌入实际使用的字体字形 |
| `pagination` | 否 | `false` | `boolean` | 启用分页渲染 |
| `format` | 否 | `'a4'` | `string` | 页面规格：`a0-a10`、`b0-b10`、`c0-c10`、`letter`、`legal` 等 |
| `pageConfig` | 否 | 见下文 | `object \| Function` | 页眉页脚配置 |
| `onJspdfReady` | 否 | - | `Function(jspdf: jsPDF)` | jsPDF 实例就绪时的回调 |
| `onJspdfFinish` | 否 | - | `Function(jspdf: jsPDF)` | PDF 生成完成时的回调 |

### `pageConfig` 字段

| 参数名 | 默认值 | 类型 | 说明 |
|--------|--------|------|------|
| `header` | 见下文 | `object` | 页眉设置 |
| `footer` | 见下文 | `object` | 页脚设置 |

### 按页控制页眉页脚

`pageConfig` 可以是一个函数，用于按页控制：

```js
pageConfig: (pageNum, totalPages) => {
    // 封面页不显示页眉页脚
    if (pageNum === 1) return null;
    // 最后一页不显示页眉页脚
    if (pageNum === totalPages) return null;
    // 其他页面正常显示页眉页脚
    return {
        header: {
            content: '文档标题',
            height: 50,
            contentColor: '#333333',
            contentFontSize: 12,
            contentPosition: 'center'
        },
        footer: {
            content: '第${currentPage}页/共${totalPages}页',
            height: 50,
            contentColor: '#333333',
            contentFontSize: 12,
            contentPosition: 'center'
        }
    };
}
```

### `pageConfigOptions` 字段

| 参数名 | 默认值 | 类型 | 说明 |
|--------|--------|------|------|
| `content` | 页眉：空<br>页脚：`${currentPage}/${totalPages}` | `string \| Function` | 文本内容，支持 `${currentPage}` 和 `${totalPages}` 占位符 |
| `height` | `50` | `number` | 区域高度（像素） |
| `contentPosition` | `'center'` | `string \| [number, number]` | 文本位置：`center`、`centerLeft`、`centerRight` 等或 `[x, y]` 坐标 |
| `contentColor` | `'#333333'` | `string` | 文本颜色 |
| `contentFontSize` | `16` | `number` | 文本字体大小（像素） |
| `padding` | `[0, 24, 0, 24]` | `[number, number, number, number]` | 上/右/下/左内边距（像素） |

### 字体配置 (`fontConfig`)

| 字段 | 必传 | 默认值 | 类型 | 说明 |
|------|------|--------|------|------|
| `fontFamily` | 是 | `''` | `string` | 字体家族名称（必须与嵌入字体匹配） |
| `fontBase64` | 是 | `''` | `string` | TTF 字体的 Base64 字符串 |
| `fontUrl` | 否 | `''` | `string` | 从 URL 加载字体 |
| `fontStyle` | 是 | `''` | `string` | `normal` 或 `italic` |
| `fontWeight` | 是 | `''` | `number` | `400`（正常）或 `700`（粗体） |
| `iconFont` | 否 | `false` | `boolean` | 设置为 `true` 表示图标字体 |
| `fontBytes` | 否 | - | `Uint8Array` | 预解码的 TTF 字节（替代 fontBase64） |

## 🔣 字体支持与国际文本

由于 PDF 原生仅支持基本拉丁字符，其他语言需要自定义字体。

### 推荐中文字体
使用[思源黑体 SC](https://github.com/lmn1919/dompdf.js/blob/main/examples/SourceHanSansSC-Normal-Min-normal.js) 支持中文文本。

### 字体转换
使用[字体转换器](https://github.com/lmn1919/dompdf.js/tree/main/fontconverter) 将 TTF 字体转换为 Base64。

**注意：** 嵌入字体会增加 PDF 文件大小。使用字体子集化工具如 `Fontmin` 来减小大小。

### 字体配置示例
```js
import dompdf from 'dompdf.js';
import SourceHanSansSC from './SourceHanSansSC-Normal-Min-normal.js';

dompdf(document.querySelector('#capture'), {
    fontConfig: {
        fontFamily: 'SourceHanSansSC-Regular',
        fontBase64: SourceHanSansSC,
        fontStyle: 'normal',
        fontWeight: 400
    }
}).then(blob => {
    // 下载 PDF
});
```

## 🚀 高级用法

### 多字体支持
```js
fontConfig: [
    {
        fontFamily: 'SourceHanSansSC-Regular',
        fontBase64: SourceHanSansSC,
        fontStyle: 'normal',
        fontWeight: 400
    },
    {
        fontFamily: 'SourceHanSansSC-Bold',
        fontBase64: SourceHanSansSCBold,
        fontStyle: 'normal',
        fontWeight: 700
    }
]
```

### PDF 加密
```js
encryption: {
    userPassword: 'user123',
    ownerPassword: 'owner123',
    userPermissions: ['print', 'copy'] // 可选：'print'、'modify'、'copy'、'annot-forms'
}
```

### 透明背景
```js
backgroundColor: null // 生成透明背景的 PDF
```

## 🔧 从源码构建

### 前提条件
- Node.js 18+
- Rust 工具链（用于 WASM 编译）
- Cargo（Rust 包管理器）

### 构建命令
```bash
# 安装依赖
npm install

# 构建 WASM 模块
npm run build:wasm

# 将 WASM 内联到 JavaScript
npm run inline:wasm

# 构建库
npm run build

# 开发模式（监听变化）
npm run dev

# 运行示例
npm run serve
```

## 📁 项目结构

```
dompdf.js/
├── src/                    # TypeScript 源代码
│   ├── index.ts           # 主入口点
│   ├── snapshot.ts        # DOM 快照收集器
│   ├── format.ts          # 二进制格式编码器
│   ├── wasm-glue.ts       # WASM 集成
│   └── worker.ts          # Web Worker 实现
├── wasm/                  # Rust WASM 模块
│   ├── src/
│   │   ├── lib.rs        # WASM 入口点
│   │   ├── pdf.rs        # PDF 生成
│   │   ├── font.rs       # 字体处理
│   │   └── snapshot.rs   # 快照解析
│   └── Cargo.toml        # Rust 依赖
├── examples/              # 演示和测试文件
├── dist/                  # 构建输出
└── scripts/              # 构建和工具脚本
```

## 🤝 贡献指南

欢迎贡献！请随时提交 Pull Request。

1. Fork 本仓库
2. 创建您的特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交您的更改 (`git commit -m '添加一些惊人的特性'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 打开一个 Pull Request

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

## 🙏 致谢

- 灵感来源于原始的 dompdf.js 项目
- 使用 Rust 和 WebAssembly 构建以获得性能
- 感谢所有贡献者和用户

## 📞 支持

- **问题反馈：** [GitHub Issues](https://github.com/lmn1919/dompdf.js/issues)
- **文档：** [阅读文档](./docs/)
- **演示：** [在线演示](https://dompdfjs.lisky.com.cn)

---

**注意：** 这是对原始 dompdf.js 的完全重写，具有现代架构和改进的性能。有关从旧版本迁移的信息，请参阅上面的版本对比部分。