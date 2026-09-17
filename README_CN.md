# dompdf.js

[English](./README.md) | [中文](./README_CN.md)

`dompdf.js` 是一个纯前端 DOM 转 PDF 引擎，由 TypeScript、Web Worker、Rust 和 WebAssembly 驱动。它直接读取浏览器已经计算好的 DOM 布局，在浏览器内生成以矢量文本为主的 PDF，不依赖服务端、jsPDF 或截图式 PDF 流水线。

它适合需要可选中文本、长文档分页、中文和自定义字体、页眉页脚、水印、表单、压缩或加密的浏览器端导出场景。

在典型长文档测试中，`dompdf.js` 可在约 2 秒内生成 500 页 PDF；在内容结构和设备资源允许的情况下，单次导出规模可扩展到上万页。实际耗时和可生成页数会受到 DOM 复杂度、图片数量、字体体积、压缩配置、浏览器及设备性能影响。

**在线演示：** [dompdfjs.lisky.com.cn](https://dompdfjs.lisky.com.cn)  
**旧版 API 迁移说明：** [docs/migration-compat.zh-CN.md](./docs/migration-compat.zh-CN.md)

## 目录

- [主要功能](#主要功能)
- [安装](#安装)
- [快速开始](#快速开始)
- [API](#api)
- [导出选项](#导出选项)
- [分页与纸张](#分页与纸张)
- [页眉与页脚](#页眉与页脚)
- [水印](#水印)
- [字体与多语言](#字体与多语言)
- [表单导出](#表单导出)
- [PDF 加密](#pdf-加密)
- [PDF 文档属性](#pdf-文档属性)
- [图片与跨域资源](#图片与跨域资源)
- [进度反馈](#进度反馈)
- [兼容性与限制](#兼容性与限制)
- [本地开发](#本地开发)

## 主要功能

- 完全在浏览器端运行，不上传待导出的文档
- 输出可搜索、可复制的矢量文本，而不是整页截图
- 使用 Web Worker 和 WASM 执行 PDF 渲染，降低主线程阻塞
- 面向大规模文档优化，典型测试约 2 秒生成 500 页，极限规模可达上万页
- 支持单页长画布和标准纸张分页
- 支持 A/B/C 系列、Letter、Legal、Tabloid 等纸张，也可传入自定义尺寸
- 支持页眉、页脚、页码占位符和逐页配置
- 支持文字水印、图片水印、上下层叠放和逐页控制
- 支持 Unicode、TTF 字体、字体子集、粗体、斜体、图标字体和语言字体回退
- 支持图片、SVG、Canvas、背景、边框、圆角、阴影、透明度和渐变等常见视觉效果
- 支持超链接 PDF 注释
- 支持静态表单外观和 PDF AcroForm 交互字段
- 支持 DEFLATE 压缩、用户密码、所有者密码和 PDF 权限控制
- 提供 `Blob`、`Uint8Array`、直接下载和底层快照 API
- 提供 TypeScript 类型声明

> `dompdf.js` 使用浏览器计算后的几何位置来还原页面，因此 CSS 仍由浏览器负责布局。PDF 渲染器会尽量保留常见视觉效果，但它不是完整的浏览器排版引擎，复杂滤镜、动画、视频和部分高级 CSS 可能被栅格化或降级。

## 安装

### npm

```bash
npm install dompdf.js
```

运行环境需要现代浏览器以及 `Worker`、`WebAssembly`、`Blob` 等 Web API。包本身要求 Node.js 18+ 用于安装、构建和开发，但导出 API 依赖 DOM，不能直接在纯 Node.js 环境中调用。

### CDN

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
```

通过 `<script>` 引入后，API 会挂载到全局 `dompdf`。

## 快速开始

### 获取 PDF Blob

默认导出函数返回 `Promise<Blob>`：

```ts
import dompdf from 'dompdf.js';

const element = document.querySelector<HTMLElement>('#capture');
if (!element) throw new Error('没有找到 #capture');

const blob = await dompdf(element, {
  format: 'a4',
  pagination: true,
  backgroundColor: '#ffffff',
});

const url = URL.createObjectURL(blob);
window.open(url, '_blank');

// 预览窗口加载后再释放；不要在 window.open 后立即 revoke。
setTimeout(() => URL.revokeObjectURL(url), 30_000);
```

### 直接下载

```ts
import { downloadPDF } from 'dompdf.js';

const element = document.querySelector<HTMLElement>('#capture');
if (element) {
  await downloadPDF(element, {
    format: 'a4',
    pagination: true,
    compress: true,
  }, 'report.pdf');
}
```

### CDN 用法

```html
<button id="export">导出 PDF</button>
<section id="capture">需要导出的内容</section>

<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"></script>
<script>
  document.querySelector('#export').addEventListener('click', async () => {
    await dompdf.downloadPDF(
      document.querySelector('#capture'),
      { format: 'a4', pagination: true },
      'example.pdf',
    );
  });
</script>
```

## API

### `dompdf(root, options?)`

默认导出，也是最简入口。行为与 `exportPDF` 相同。

```ts
function dompdf(
  root: HTMLElement,
  options?: ExportOptions,
): Promise<Blob>;
```

### `exportPDF(root, options?)`

采集 DOM、生成 PDF，并返回 MIME 类型为 `application/pdf` 的 `Blob`。适合预览、上传或自行下载。

```ts
import { exportPDF } from 'dompdf.js';

const blob = await exportPDF(element, options);
```

### `renderToBytes(root, options?)`

返回 PDF 原始字节。适合交给文件系统 API、上传接口或其他二进制处理流程。

```ts
import { renderToBytes } from 'dompdf.js';

const bytes: Uint8Array = await renderToBytes(element, options);
```

### `downloadPDF(root, options?, filename?)`

生成 PDF 并触发浏览器下载。默认文件名为 `export.pdf`。

```ts
import { downloadPDF } from 'dompdf.js';

await downloadPDF(element, options, 'invoice.pdf');
```

### `inspect(root, options?)`

返回 WASM 侧的快照摘要，包含节点、图片、字体和页数等信息。它主要用于诊断，不会生成可下载的 PDF。

```ts
import { inspect } from 'dompdf.js';

console.log(await inspect(element, { pagination: true }));
```

### 高级快照 API

包还导出了以下底层函数：

- `collectSnapshot(root, options?) -> Promise<Uint8Array>`：采集并编码 DOM 快照
- `collectSnapshotData(root, options?)`：返回编码前的中间数据
- `encodeSnapshot(data, perPageHF, perPageWatermark?) -> Uint8Array`：编码中间数据
- `computePageBreaks(root, options?) -> number[]`：计算相对根元素顶部的分页 Y 坐标
- `pageConfigNeedsPerPageResolution`、`watermarkNeedsPerPageResolution`：判断配置是否需要逐页解析
- `resolvePerPageHF`、`resolveStaticPageConfigHF`：解析逐页页眉页脚
- `resolvePerPageWatermark`、`resolveStaticWatermarkPages`：解析逐页水印

这些接口面向调试、可视化分页和自定义流水线。快照二进制格式属于项目内部协议，普通业务代码应优先使用 `dompdf`、`exportPDF`、`renderToBytes` 或 `downloadPDF`。

默认导出对象也附带了常用方法，因此下面两种写法等价：

```ts
import dompdf, { renderToBytes } from 'dompdf.js';

const bytesA = await dompdf.renderToBytes(element);
const bytesB = await renderToBytes(element);
```

## 导出选项

以下选项具备实际行为：

| 选项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `format` | `string \| [number, number]` | `'a4'` | 纸张名称或 `[宽, 高]`，单位为 pt |
| `pageWidthPt` | `number` | 由 `format` 决定 | 直接覆盖页面宽度 |
| `pageHeightPt` | `number` | 由 `format` 决定 | 直接覆盖页面高度 |
| `marginPt` | `number \| [上, 右, 下, 左]` | `0` | PDF 页边距，单位为 pt |
| `pagination` | `boolean` | `false` | 是否按纸张高度分页 |
| `backgroundColor` | `string \| null` | `null` | 页面背景色；`null` 表示透明 |
| `precision` | `number` | `2` | PDF 坐标保留的小数位数 |
| `compress` | `boolean` | `false` | 使用 DEFLATE 压缩 PDF 流 |
| `jpegQuality` | `number` | `0.85` | 图片转 JPEG 时的质量 |
| `useCORS` | `boolean` | `false` | 跨域图片按匿名 CORS 方式加载 |
| `ignoreElements` | `(element) => boolean` | 无 | 返回 `true` 时跳过该元素及其内容 |
| `fontConfig` | `FontConfig \| FontConfig[]` | 无 | 注册自定义字体 |
| `langFontConfig` | `FontConfig[]` | 无 | 按 Unicode 范围配置字体回退 |
| `pageConfig` | 对象或逐页函数 | 见下文 | 页眉和页脚配置 |
| `watermark` | 对象或逐页函数 | 无 | 文字或图片水印 |
| `form` | `boolean \| FormOptions` | 静态模式 | 表单控件导出方式 |
| `encryption` | `PdfEncryptionOptions` | 无 | PDF 密码和权限配置 |
| `metadata` | `PdfMetadataOptions` | 无 | PDF 文档属性（Info 字典） |
| `onProgress` | `(progress) => void` | 无 | 导出进度回调 |

完整 TypeScript 类型以 [`src/snapshot.ts`](./src/snapshot.ts) 和发布包内的 `dist/types` 为准。

## 分页与纸张

### 单页与分页模式

- `pagination: false`：生成一张内容驱动高度的长页面，适合票据、截图替代和连续文档
- `pagination: true`：根据纸张、页边距、页眉和页脚的可用区域生成多页 PDF

```ts
await dompdf(element, {
  format: 'a4',
  pagination: true,
  marginPt: [36, 36, 36, 36],
});
```

为了获得稳定的分页结果，建议让待导出容器的 CSS 宽度接近目标纸张的内容宽度。A4 在 96 DPI 下为约 `794px × 1123px`；如果设置了页边距，还要从中减去对应宽度。

常见纸张尺寸见 [page_sizes.md](./page_sizes.md)。当前支持：

- `a0` 到 `a10`
- `b0` 到 `b10`
- `c0` 到 `c10`
- `letter`、`government-letter`
- `legal`、`junior-legal`、`government-legal`
- `tabloid`、`ledger`

自定义横向 A4 可以直接交换宽高：

```ts
await dompdf(element, {
  format: [842.25, 595.5],
  pagination: true,
});
```

也可以使用 `pageWidthPt` 和 `pageHeightPt` 覆盖 `format`。`orientation` 目前只是旧版兼容参数，不会自动交换纸张宽高。

### 强制分页与避免拆分

在元素上添加 `pageBreak` 属性，可要求分页器在该元素前换页：

```html
<section>第一页内容</section>
<section pageBreak>从新页面开始</section>
```

添加 `divisionDisable` 属性，可尽量避免整个元素跨页拆分：

```html
<article divisionDisable>
  这部分内容会尽量保持在同一页。
</article>
```

当元素本身高于一整页可用高度时，分页器仍可能拆分它，避免产生无法放置的内容。

## 页眉与页脚

### 固定配置

```ts
await dompdf(element, {
  pagination: true,
  pageConfig: {
    excludePages: [1],
    header: {
      content: '季度经营报告',
      height: 48,
      contentColor: '#334155',
      contentFontSize: 11,
      contentPosition: 'centerLeft',
      padding: [0, 24, 0, 24],
    },
    footer: {
      content: '第 ${currentPage} / ${totalPages} 页',
      height: 48,
      contentColor: '#64748b',
      contentFontSize: 10,
      contentPosition: 'center',
      padding: [0, 24, 0, 24],
    },
  },
});
```

`content` 支持以下占位符：

- `${currentPage}`：当前页码，从 1 开始
- `${totalPages}`：总页数

`contentPosition` 支持：

- `center`、`centerLeft`、`centerRight`
- `centerTop`、`centerBottom`
- `leftTop`、`leftBottom`
- `rightTop`、`rightBottom`
- `[x, y]` 自定义坐标

`padding` 顺序为 `[上, 右, 下, 左]`。`excludePage` 可以接收单个页码或页码数组，`excludePages` 接收页码数组。

启用分页但没有传入 `pageConfig` 时，当前版本会默认保留 `50px` 的空页眉区域，并在 `50px` 页脚中输出 `${currentPage}/${totalPages}`。如需完全自定义，请显式传入 `pageConfig`。

### Slots（Phase 1）

`header` / `footer` 现在支持 `slots`，可在同一页眉或页脚中放置多个文本块，并为每个 slot 单独指定字体、颜色、位置：

```ts
await dompdf(element, {
  pagination: true,
  pageConfig: {
    header: {
      height: 48,
      padding: [8, 24, 0, 24],
      slots: [
        {
          content: '季度经营报告',
          position: 'leftTop',
          color: '#334155',
          fontSize: 11,
          fontFamily: 'Source Han Sans SC',
          fontWeight: 700,
        },
        {
          content: '第 ${currentPage} / ${totalPages} 页',
          position: { x: '100%', y: 0, anchor: 'rightTop' },
          color: '#64748b',
          fontSize: 10,
        },
      ],
    },
  },
});
```

说明：

- `slots` 存在时，优先于旧版 `content / contentPosition`
- `position` 既支持语义位置，也支持坐标对象
- 坐标对象的原点是页眉/页脚内容区左上角，`x/y` 支持数字、`'50%'`、`'100%-24'`
- `anchor` 默认是 `leftTop`

`slot` 可用字段：

- `content`: 文本内容，支持 `${currentPage}` / `${totalPages}`
- `position`: 语义位置，或 `{ x, y, anchor }`
- `color`: 文本颜色
- `fontSize`: 字号（px）
- `fontFamily`: 字体名称，需配合 `fontConfig` 中已注册的字体使用
- `fontWeight`: 字重
- `italic`: 是否斜体

坐标定位示例：

```ts
slots: [
  {
    content: '左上标题',
    position: 'leftTop',
  },
  {
    content: '右上页码',
    position: { x: '100%', y: 0, anchor: 'rightTop' },
  },
  {
    content: '右下说明',
    position: { x: '100%-24', y: '100%-10', anchor: 'rightBottom' },
  },
]
```

其中：

- `x: '100%'` 表示内容区最右侧参考线
- `x: '100%-24'` 表示在最右侧基础上向左偏移 `24px`
- `y: '100%-10'` 表示在内容区底部基础上向上偏移 `10px`
- `anchor` 决定坐标对应的是文本框的哪个参考点

### 逐页配置

函数形式会在已知总页数后按页调用，返回 `null` 可禁用该页的页眉页脚：

```ts
await dompdf(element, {
  pagination: true,
  pageConfig(pageNum, totalPages) {
    if (pageNum === 1) return null;

    return {
      header: {
        content: '内部资料',
        height: 40,
        contentPosition: 'rightTop',
      },
      footer: {
        content: `${pageNum} / ${totalPages}`,
        height: 40,
        contentPosition: 'center',
      },
    };
  },
});
```

`PageRegionConfig.content` 的函数签名是旧版兼容入口，目前不会获得可操作的 PDF renderer。需要动态内容时，请使用 `pageConfig(pageNum, totalPages)` 返回字符串内容。

## 水印

### 文字水印

```ts
await dompdf(element, {
  pagination: true,
  watermark: {
    text: '内部资料 ${currentPage}/${totalPages}',
    color: 'rgba(185, 28, 28, 0.14)',
    fontFamily: 'Helvetica',
    fontSize: 28,
    fontWeight: 700,
    angle: -35,
    spacing: [180, 130],
    offset: [40, 40],
    layer: 'under',
    excludePages: [1],
  },
});
```

文字水印默认值包括：角度 `35`、字号 `28px`、颜色 `rgba(0, 0, 0, 0.12)`、间距 `[160, 120]`、偏移 `[36, 36]`、层级 `under`。

### 图片水印

```ts
await dompdf(element, {
  pagination: true,
  useCORS: true,
  watermark: {
    imageUrl: '/assets/company-mark.png',
    imageWidth: 120,
    opacity: 0.1,
    angle: -30,
    spacing: [220, 160],
    layer: 'over',
  },
});
```

图片水印支持 `imageWidth`、`imageHeight` 和 `opacity`。只指定宽或高时会按照原图比例计算另一边。

### 逐页水印

```ts
await dompdf(element, {
  pagination: true,
  watermark(pageNum) {
    if (pageNum === 1) return null;
    return {
      text: pageNum % 2 === 0 ? '偶数页' : '奇数页',
      color: 'rgba(30, 64, 175, 0.12)',
      layer: 'under',
    };
  },
});
```

## 字体与多语言

非拉丁文本建议显式嵌入 TTF 字体。最可靠的方式是先加载字体，再通过 `fontBytes` 传入：

```ts
import dompdf from 'dompdf.js';

const fontBuffer = await fetch('/fonts/SourceHanSansSC-Regular.ttf').then((response) => {
  if (!response.ok) throw new Error(`字体加载失败：${response.status}`);
  return response.arrayBuffer();
});

await dompdf(element, {
  fontConfig: {
    fontFamily: 'SourceHanSansSC-Regular',
    fontBytes: new Uint8Array(fontBuffer),
    fontStyle: 'normal',
    fontWeight: 400,
  },
});
```

`fontConfig` 可传单个字体或数组。主要字段：

| 字段 | 说明 |
| --- | --- |
| `fontFamily` | 必填，应与导出元素的 CSS `font-family` 对应 |
| `fontBytes` | 已解码的 TTF 字节，推荐使用 |
| `fontBase64` | Base64 编码的 TTF 数据 |
| `fontStyle` | `normal` 或 `italic` |
| `fontWeight` | 字重，如 `400`、`700` |
| `iconFont` | 是否作为图标字体处理 |

类型中保留了 `fontUrl`，但当前采集器不会主动读取它。需要从 URL 加载字体时，请先 `fetch` 并转换为 `Uint8Array`。

### 多语言字体回退

`langFontConfig` 可以通过 Unicode 范围选择字体，并设置默认回退字体：

```ts
await dompdf(element, {
  langFontConfig: [
    {
      fontFamily: 'SourceHanSansSC-Regular',
      fontBytes: chineseFontBytes,
      charRange: [[0x3400, 0x9fff]],
    },
    {
      fontFamily: 'NotoSans-Regular',
      fontBytes: fallbackFontBytes,
      isDefault: true,
    },
  ],
});
```

仓库提供了 [`examples/SourceHanSansSC-Regular.ttf`](./examples/SourceHanSansSC-Regular.ttf)，可用于本地演示和验证。生产项目应确认所用字体的授权范围，并避免重复注册体积较大的完整字体。

## 表单导出

表单值以导出开始时的 DOM 当前状态为准，而不是初始 HTML 属性值。

```ts
await dompdf(element, {
  pagination: true,
  form: {
    mode: 'hybrid',
    include: [
      'text',
      'textarea',
      'select',
      'checkbox',
      'radio',
      'date-time',
      'range',
      'color',
      'file',
      'progress',
      'meter',
    ],
  },
});
```

模式说明：

- `static`：默认模式，只保留控件当前的静态视觉外观
- `interactive`：为具备自然 PDF 映射的控件生成 AcroForm 字段
- `hybrid`：保留静态视觉，同时附加交互字段

当前交互字段映射：

- 文本类 `input`、`textarea`
- `select`
- `checkbox`
- `radio`

以下类型会保留静态外观，但不会生成等价的交互字段：

- `date`、`time`、`month`、`week`、`datetime-local`
- `range`、`color`、`file`
- `progress`、`meter`

`form: true` 与默认行为一样仍是静态模式；要生成交互字段，必须显式设置 `mode: 'interactive'` 或 `mode: 'hybrid'`。

## PDF 加密

```ts
await dompdf(element, {
  encryption: {
    userPassword: 'reader-password',
    ownerPassword: 'owner-password',
    userPermissions: ['print', 'copy'],
  },
});
```

可用权限：

- `print`：允许打印
- `modify`：允许修改
- `copy`：允许复制内容
- `annot-forms`：允许注释和填写表单

传入未知权限会抛出错误。PDF 权限最终是否严格执行还取决于阅读器；权限标志不能替代对敏感数据的访问控制。

## PDF 文档属性

设置 PDF 阅读器“文档属性”面板中显示的文档信息：

```ts
await dompdf(element, {
  metadata: {
    title: '季度报告',
    author: '刘发财',
    subject: '一季度汇总',
    keywords: ['报告', '财务'],
    creator: 'my-app',
    producer: 'my-app',
  },
});
```

- 所有字段均可选；`keywords` 接受字符串或字符串数组（数组以空格连接）。
- 提供 `metadata` 时，`producer` 默认为 `dompdf.js`，并自动将 `creationDate`/`modDate` 设为导出时间。
- 属性值以 UTF-16BE 字符串写入，支持中文等非 ASCII 文本。
- 未提供 `metadata` 时不写入 Info 字典，输出与之前版本字节级一致。

## 图片与跨域资源

同源图片、data URL、Canvas 和可读取的 SVG 可以直接参与导出。跨域图片需要资源服务器返回正确的 CORS 响应头：

```ts
await dompdf(element, {
  useCORS: true,
  jpegQuality: 0.9,
});
```

注意：

- `useCORS: true` 只会以匿名 CORS 方式请求图片，不能绕过服务器策略
- 图片服务器通常需要返回 `Access-Control-Allow-Origin`
- 导出前应等待图片和字体加载完成
- 无法读取的图片可能被跳过或降级
- `proxy`、`allowTaint`、`imageTimeout` 等旧 html2canvas 参数目前不会提供原版行为

可以在导出前等待页面字体和图片：

```ts
await document.fonts.ready;

await Promise.all(
  Array.from(element.querySelectorAll('img')).map((image) => {
    if (image.complete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    });
  }),
);
```

## 进度反馈

`onProgress` 会报告以下阶段：

- `collecting`：采集 DOM 和资源
- `countingPages`：为逐页页眉、页脚或水印计算总页数
- `rendering`：WASM 正在生成 PDF
- `done`：导出完成

```ts
await dompdf(element, {
  pagination: true,
  onProgress(progress) {
    switch (progress.stage) {
      case 'collecting':
        console.log('正在采集页面');
        break;
      case 'countingPages':
        console.log(`正在计算页数：${progress.totalPages ?? '...'}`);
        break;
      case 'rendering':
        console.log(
          `正在生成：${progress.currentPage ?? 0}/${progress.totalPages ?? '?'}`,
        );
        break;
      case 'done':
        console.log(`导出完成，共 ${progress.totalPages ?? 1} 页`);
        break;
    }
  },
});
```

并非每次导出都会出现 `countingPages` 阶段；只有需要先知道总页数的配置才会触发它。

## 兼容性与限制

### 浏览器兼容性

运行时依赖：

- DOM 和 CSSOM
- Web Worker
- WebAssembly
- `Blob`、`URL.createObjectURL`
- `TextEncoder`、`TextDecoder`

建议使用较新的 Chromium、Firefox 或 Safari。该库不支持直接在 Node.js、SSR 服务端或没有 DOM 的 Worker 中采集页面。Next.js、Nuxt 等 SSR 项目应仅在客户端调用导出 API。

### 旧版兼容参数

项目已经从 `html2canvas + jsPDF` 迁移到 `DOM 快照 + Worker + WASM`。以下参数会被类型和运行时接受，但当前不会提供旧版等价行为，部分参数会输出 warning：

- `onJspdfReady`、`onJspdfFinish`
- `foreignObjectRendering`、`allowTaint`、`proxy`、`imageTimeout`
- `logging`、`cache`
- `windowWidth`、`windowHeight`、`scrollX`、`scrollY`
- `x`、`y`、`width`、`height`、`scale`
- `canvas`、`removeContainer`、`onclone`
- `pdfFileName`、`floatPrecision`、`orientation`、`putOnlyUsedFonts`

其中 `ignoreElements` 已有实际行为，可以替代一部分旧版 clone 阶段的元素过滤逻辑。完整迁移建议见 [旧版 API 迁移说明](./docs/migration-compat.zh-CN.md)。

### 已知边界

- 动画、视频、iframe 和浏览器插件内容不能按动态状态完整导出
- 部分复杂滤镜、混合模式、遮罩和高级 CSS 会被降级或栅格化
- 超高分辨率图片和完整 CJK 字体会增加采集时间、内存和 PDF 体积
- `fontUrl` 和 `putOnlyUsedFonts` 目前只有兼容签名；字体 URL 需要由调用方先行加载
- `PageRegionConfig.content` 的 renderer 回调属于兼容签名，当前不提供可操作的 jsPDF 实例
- 依赖 jsPDF 插件或在导出结束后直接修改 jsPDF 实例的代码需要迁移

## 常见问题

### 为什么中文为空白或显示成方框？

浏览器字体不会自动嵌入 PDF。请通过 `fontConfig.fontBytes` 注册包含相应字符的 TTF 字体，并让元素的 CSS `font-family` 与 `fontFamily` 对应。

### 为什么分页位置和页面预览不一致？

确保导出容器宽度与目标纸张的内容宽度接近，并在导出前等待字体和图片完成加载。页边距、页眉和页脚都会减少每页可用区域。

### 如何导出横向页面？

使用自定义 `[宽, 高]` 或 `pageWidthPt/pageHeightPt`。不要依赖目前仅用于兼容的 `orientation`。

### 为什么跨域图片没有出现在 PDF 中？

设置 `useCORS: true`，并确认图片服务器允许跨域读取。仅在前端设置 CORS 选项不能绕过服务器响应头限制。

### 如何减小 PDF 体积？

启用 `compress: true`，避免使用远超显示尺寸的大图，适当降低 `jpegQuality`，并尽量只注册实际需要的字体和字重。

## 工作原理

1. 主线程遍历目标元素，读取浏览器计算后的布局、样式、文本、图片和表单状态。
2. TypeScript 将采集结果编码成紧凑的二进制快照。
3. 快照通过可转移对象发送到 Web Worker。
4. Rust/WASM 完成分页、字体子集、绘制和 PDF 对象写入。
5. 主线程收到 PDF 字节，并按调用方式返回 `Uint8Array`、`Blob` 或触发下载。

这套结构避免将整个文档先绘制成一张 Canvas，同时让主要 PDF 生成工作离开主线程。

## 示例页面

- [`examples/index.html`](./examples/index.html)：综合功能演示
- [`examples/comparison.html`](./examples/comparison.html)：与其他前端 PDF 方案对比
- [`examples/markdown-editor.html`](./examples/markdown-editor.html)：Markdown 编辑和实时导出
- [`userscript/dompdf-page-exporter.user.js`](./userscript/dompdf-page-exporter.user.js)：支持整页、单节点和排除元素的油猴导出脚本，安装说明见 [`userscript/README.md`](./userscript/README.md)

在仓库根目录运行 `npm run serve` 后访问对应页面。不要直接通过 `file://` 打开示例，否则模块、字体和跨域资源可能受浏览器安全策略限制。

## 本地开发

### 环境要求

- Node.js 18+
- Rust 工具链
- `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
npm install
npm run build
npm test
npm run serve
```

常用脚本：

| 命令 | 作用 |
| --- | --- |
| `npm run build:wasm` | 编译 Rust/WASM 模块 |
| `npm run build` | 构建发布包和 TypeScript 类型声明 |
| `npm run dev` | 监听源码并持续构建 |
| `npm test` | 构建 WASM 并运行 PDF 冒烟验证 |
| `npm run verify` | 与 `npm test` 相同，执行验证脚本 |
| `npm run serve` | 在 `8080` 端口启动静态文件服务 |

`npm test` 当前会执行 [`scripts/verify.mjs`](./scripts/verify.mjs)，验证基础分页、PDF 结构、图片、中文字体子集、透明度和复合字形。

## 项目结构

```text
dompdf.js/
├── src/                  # TypeScript API、DOM 采集、Worker 和 WASM 连接层
├── wasm/                 # Rust 分页、字体、压缩、加密和 PDF 写入器
├── dist/                 # 构建后的发布产物
├── examples/             # 浏览器演示页面和示例字体
├── docs/                 # 迁移说明与 PDF 差异系统文档
└── scripts/              # 构建、验证和 PDF 差异工具
```

## dompdf.js交流群



## 参与贡献

提交 PR 前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)，并至少运行：

```bash
npm test
npm run build
```

## 安全报告

安全问题请按照 [SECURITY.md](./SECURITY.md) 中的方式反馈，不要在公开 Issue 中披露尚未修复的漏洞。

## 变更记录

近期版本变化见 [CHANGELOG.md](./CHANGELOG.md)。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
