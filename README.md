# dompdf

<!-- [主页](https://html2canvas.hertzen.com) | [下载](https://github.com/niklasvh/html2canvas/releases) | [问题](https://github.com/niklasvh/html2canvas/discussions/categories/q-a)

[![Gitter](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/niklasvh/html2canvas?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge)
![CI](https://github.com/niklasvh/html2canvas/workflows/CI/badge.svg?branch=master)
[![NPM Downloads](https://img.shields.io/npm/dm/html2canvas.svg)](https://www.npmjs.org/package/html2canvas)
[![NPM Version](https://img.shields.io/npm/v/html2canvas.svg)](https://www.npmjs.org/package/html2canvas) -->

该脚本允许您直接在用户浏览器上将网页或部分网页生成为可编辑、非图片式、可打印的 pdf。由于生成是基于 DOM 的，因此可能与实际表现不会 100% 一致。如果是复杂的pdf生成需求，不建议使用。


在线体验：[在线体验](https://dompdfjs.lisky.com.cn)

pdf生成示例

### pdf生成示例
![pdf生成示例](./examples/test.png)


### 它是如何工作的

该脚本基于[html2canvas](https://github.com/niklasvh/html2canvas)和[jspdf](https://github.com/MrRio/jsPDF)，与以往将 html 页面通过 html2canvas 渲染为图片，再通过 jspdf 将图片生成 pdf 文件不同，该脚本通过读取 DOM 和应用于元素的不同样式，改造了 html2canvas 的 canvas-renderer 文件，调用 jspdf 的方法生成 pdf 文件。
所以他有以下优势：

1. 不需要服务器端的任何渲染，因为整个 pdf 是在**客户端浏览器**上创建的。
2. 生成的是真正的 pdf 文件，而不是图片式的，这样生成的 pdf 质量更高，您也可以编辑和打印生成 pdf 文件。
3. 更小的 pdf 文件体积

当然，它也有一些缺点：

1. 由于是基于 DOM 的，所以可能与实际表现不会 100% 一致。
2. 有的 css 属性还没有被支持，查看[支持的 css 属性](https://www.html2canvas.cn/html2canvas-features.html)。
3. 不适合在 nodejs 中使用。
4. 有的样式可能无法被正确渲染，比如：
    - text-shadow

### 已实现功能

| 功能     | 状态 | 说明                                                                                                      |
| -------- | ---- | --------------------------------------------------------------------------------------------------------- |
| 文本渲染 | ✅   | 支持基础文本内容渲染,font-family,font-size,font-style,font-variant,color 等，支持文字描边，不支持文字阴影 |
| 图片渲染 | ✅   | 支持网络图片，base64 图片，svg 图片                                                                       |
| 边框     | ✅   | 支持 border-width,border-color,border-style,border-radius,暂时只实现了实线边框                            |
| 背景     | ✅   | 支持背景颜色，背景图片，背景渐变                                                                          |
| canvas   | ✅   | 支持渲染 canvas                                                                                           |
| svg      | ✅   | 支持渲染 svg                                                                                              |
| 阴影渲染 | ✅   | 使用 foreignObjectRendering，支持边框阴影渲染                                                             |
| 渐变渲染 | ✅   | 使用 foreignObjectRendering，支持背景渐变渲染                                                             |
| iframe   | ❌   | 支持渲染 iframe                                                                                           |

### foreignObjectRendering 使用

在 dom 十分复杂，或者 pdf 无法绘制的情况（比如：复杂的表格，边框阴影，渐变等），可以考虑使用 foreignObjectRendering。
给要渲染的元素添加 foreignObjectRendering 属性，就可以通过 svg 的 foreignObject 将它渲染成一张背景图插入到 pdf 文件中。

但是，由于 foreignObject 元素的渲染依赖于浏览器的实现，因此在不同的浏览器中可能会有不同的表现。
所以，在使用 foreignObjectRendering 时，需要注意以下事项：

1. foreignObject 元素的渲染依赖于浏览器的实现，因此在不同的浏览器中可能会有不同的表现。
2. IE 浏览器完全不支持，推荐在 chrome 和 firefox,edge 中使用。
3. 生成的图片会导致 pdf 文件体积变大。

示例

```html
<div style="width: 100px;height: 100px;" foreignObjectRendering>
    <div
        style="width: 50px;height: 50px;border: 1px solid #000;box-shadow: 2px 2px 5px rgba(0,0,0,0.3);background: linear-gradient(45deg, #ff6b6b, #4ecdc4);"
    >
        这是一个div元素
    </div>
</div>
```

### 浏览器兼容性

该库应该可以在以下浏览器上正常工作（需要 `Promise` polyfill）：

-   Firefox 3.5+
-   Google Chrome
-   Opera 12+
-   IE9+
-   Safari 6+

### 使用方法

dompdf 库使用 `Promise` 并期望它们在全局上下文中可用。如果您希望支持不原生支持 `Promise` 的[较旧浏览器](http://caniuse.com/#search=promise)，请在引入 `dompdf` 之前包含一个 polyfill，比如 [es6-promise](https://github.com/jakearchibald/es6-promise)。

安装：

     npm install dompdf.js --save

CDN引入：
```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@1.0.4/dist/dompdf.min.js"></script>   
```

#### 基础用法

```js
import dompdf from 'dompdf.js';
dompdf(document.querySelector("#capture"), {
    useCORS: true //是否允许跨域
    })
    .then(function (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'example.pdf';
        document.body.appendChild(a);
        a.click();
    })
    .catch(function (err) {
        console.log(err, 'err');
    });
```

#### 字体支持

如果需要自定义字体，在[这里](https://rawgit.com/MrRio/jsPDF/master/fontconverter/fontconverter.html)将字体 tff 文件转化成 base64 格式的 js 文件，中文字体推荐使用[思源黑体](https://github.com/lmn1919/dompdf.js/blob/main/examples/SourceHanSansSC-Normal-Min-normal.js),体积较小。
在代码中引入该文件即可。

````js
    <script type="text/javascript" src="./SourceHanSansSC-Normal-Min-normal.js"></script>
    dompdf(document.querySelector("#capture"), {
    useCORS: true, //是否允许跨域
    fontConfig: {
                    fontFamily: 'SourceHanSansSC-Normal-Min',
                    fontBase64: window.fontBase64,
                },
    })
    .then(function (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'example.pdf';
        document.body.appendChild(a);
        a.click();
    })
    .catch(function (err) {
        console.log(err, 'err');
    });
````

### 构建

<!-- 您可以在[这里](https://github.com/niklasvh/html2canvas/releases)下载已构建好的版本。 -->

克隆 git 仓库：

    $ git clone git@github.com:lmn1919/dompdf.js.git

安装依赖：

    $ npm install

构建浏览器包：

    $ npm run build

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=lmn1919/dompdf.js&type=Date)](https://www.star-history.com/#lmn1919/dompdf.js&Date)

