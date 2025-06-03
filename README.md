html2pdf
===========

<!-- [主页](https://html2canvas.hertzen.com) | [下载](https://github.com/niklasvh/html2canvas/releases) | [问题](https://github.com/niklasvh/html2canvas/discussions/categories/q-a)

[![Gitter](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/niklasvh/html2canvas?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge) 
![CI](https://github.com/niklasvh/html2canvas/workflows/CI/badge.svg?branch=master)
[![NPM Downloads](https://img.shields.io/npm/dm/html2canvas.svg)](https://www.npmjs.org/package/html2canvas)
[![NPM Version](https://img.shields.io/npm/v/html2canvas.svg)](https://www.npmjs.org/package/html2canvas) -->


该脚本允许您直接在用户浏览器上将网页或部分网页生成为可编辑、非图片式、可打印的pdf。由于生成是基于 DOM 的，因此可能与实际表现不会 100% 一致。

### 它是如何工作的
该脚本基于[html2canvas](https://github.com/niklasvh/html2canvas)和[jspdf](https://github.com/MrRio/jsPDF)，与以往将html页面通过html2canvas渲染为图片，再通过jspdf将图片生成pdf文件不同，该脚本通过读取 DOM 和应用于元素的不同样式，改造了html2canvas的canvas-renderer文件，调用jspdf的方法生成pdf文件。
所以他有以下优势：
1. 不需要服务器端的任何渲染，因为整个pdf是在**客户端浏览器**上创建的。
2. 生成的是真正的pdf文件，而不是图片式的，这样生成的pdf质量更高，您也可以编辑和打印生成pdf文件。
   
当然，它也有一些缺点：
1. 由于是基于DOM的，所以可能与实际表现不会 100% 一致。
2. 有的css属性还没有被支持，查看[支持的css属性](https://www.html2canvas.cn/html2canvas-features.html)。
3. 不适合在nodejs中使用。
4. 有的样式可能无法被正确渲染，比如：
    - box-shadow
    - text-shadow
  

### 已实现功能
| 功能     | 状态     | 说明                                                                          |
| -------- | -------- | ----------------------------------------------------------------------------- |
| 文本渲染 | ✅        | 支持基础文本内容渲染,font-family,font-size,font-style,font-variant,color等    |
| 图片渲染 | ✅        | 支持网络图片，base64图片，svg图片                                             |
| 边框     | ✅        | 支持border-width,border-color,border-style,border-radius,展示只实现了实线边框 |
| 背景     | ✅        | 支持背景颜色，背景图片，背景渐变                                              |
| canvas   | ✅        | 支持渲染canvas                                                                |
| svg      | ✅        | 支持渲染svg                                                                   |
| iframe   | ❌        | 支持渲染iframe                                                                |
| 阴影渲染 | ❌        | 暂不支持box-shadow、text-shadow                                               |
| 渐变渲染 | ❌        | 暂不支持渐变背景                                                              |




### 浏览器兼容性

该库应该可以在以下浏览器上正常工作（需要 `Promise` polyfill）：

* Firefox 3.5+
* Google Chrome
* Opera 12+
* IE9+
* Safari 6+

### 使用方法

html2pdf 库使用 `Promise` 并期望它们在全局上下文中可用。如果您希望支持不原生支持 `Promise` 的[较旧浏览器](http://caniuse.com/#search=promise)，请在引入 `html2pdf` 之前包含一个 polyfill，比如 [es6-promise](https://github.com/jakearchibald/es6-promise)。

要使用 html2pdf 渲染一个 `element`，只需调用：


```js
    html2pdf(document.body, 
    {
        useCORS: true,//是否允许跨域
        scale: 1,//缩放比例
        fontConfig: {
            fontFamily: 'SourceHanSansSC-Normal-Min',//字体名称
            fontBase64: window.fontBase64,//字体base64
            fontWeight: 400,//字体粗细
            fontStyle: 'normal'//字体样式
        },
        pdfFileName: 'my-document.pdf'  // 指定 PDF 文件名
    }).then(function(res) {
       console.log(res,'生成成功')
    }).catch(function(err){
        console.log(err,'err')
    });
```

### 构建

<!-- 您可以在[这里](https://github.com/niklasvh/html2canvas/releases)下载已构建好的版本。 -->

克隆 git 仓库：

    $ git clone git@github.com:lmn1919/html2pdf.git

安装依赖：

    $ npm install

构建浏览器包：

    $ npm run build

<!-- ### 示例

有关更多信息和示例，请访问[主页](https://html2canvas.hertzen.com)或尝试[测试控制台](https://html2canvas.hertzen.com/tests/)。

### 贡献

如果您希望为项目做出贡献，请将拉取请求发送到 develop 分支。在提交任何更改之前，请尝试测试这些更改是否适用于所有支持的浏览器。如果某些 CSS 属性不受支持或不完整，请在提交任何代码更改之前也为其创建适当的测试。 -->
