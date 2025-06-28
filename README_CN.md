# dompdf

dompdf 纯前端将HTML转换为可编辑，非图片式的，可打印的PDF文件。

> :warning: v0.10 版本中报告了一些问题。这些问题正在调查中,同时您可以考虑继续使用 v0.9.3 版本("^0.9.3" in npm, 或者[在 HTML script 标签中使用 cdnjs](https://cdnjs.com/libraries/dompdf.js/0.9.3))。

## 目录

- [开始使用](#开始使用)
  - [CDN](#cdn)
  - [原生 JS](#原生-js)
  - [NPM](#npm)
  - [Bower](#bower)
  - [控制台](#控制台)
- [使用方法](#使用方法)
  - [高级用法](#高级用法)
    - [工作流程](#工作流程)
    - [Worker API](#worker-api)
- [配置选项](#配置选项)
  - [分页](#分页)
    - [分页设置](#分页设置)
    - [分页模式](#分页模式)
    - [使用示例](#使用示例)
  - [图片类型和质量](#图片类型和质量)
- [进度跟踪](#进度跟踪)
- [依赖项](#依赖项)
- [贡献](#贡献)
  - [问题](#问题)
  - [测试](#测试)
  - [Pull requests](#pull-requests)
- [致谢](#致谢)
- [许可证](#许可证)

## 开始使用

#### CDN

使用 dompdf.js 最简单的方法是通过 cdnjs 在 HTML 中引入它:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/dompdf.js/0.10.1/dompdf.bundle.min.js" integrity="sha512-GsLlZN/3F2ErC5ifS5QtgpiJtWd43JWSuIgh7mbzZ8zBps+dvLusV+eNQATqgA/HdeKFVgA5v3S/cIrLF7QnIg==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
```

使用 CDN URL 会锁定到特定版本,这可以确保稳定性并让您控制何时更改版本。cdnjs 提供访问 [dompdf.js 的所有历史版本](https://cdnjs.com/libraries/dompdf.js)。

*注意: 关于使用未打包版本 `dist/html2canvas.min.js` 的更多信息,请参阅[依赖项](#依赖项)。*

#### 原生 JS

您也可以直接下载 `dist/dompdf.bundle.min.js` 到项目文件夹中,并在 HTML 中引入:

```html
<script src="dompdf.bundle.min.js"></script>
```

#### NPM

使用 NPM 安装 dompdf.js 及其依赖项: `npm install --save dompdf.js` (请确保包名中包含 `.js`)。

*注意: 您可以使用 NPM 创建项目,但 dompdf.js **不能在 Node.js 中运行**,它必须在浏览器中运行。*

#### Bower

使用 Bower 安装 dompdf.js 及其依赖项: `bower install --save dompdf.js` (请确保包名中包含 `.js`)。

#### 控制台

如果您在一个无法直接修改的网页上想要使用 dompdf.js 来捕获截图,可以按照以下步骤操作:

1. 打开浏览器控制台(不同浏览器的说明[在此](https://webmasters.stackexchange.com/a/77337/94367))。
2. 粘贴以下代码:
    ```js
    function addScript(url) {
        var script = document.createElement('script');
        script.type = 'application/javascript';
        script.src = url;
        document.head.appendChild(script);
    }
    addScript('https://cdnjs.cloudflare.com/ajax/libs/dompdf.js/0.10.1/dompdf.bundle.min.js');
    ```
3. 现在您可以直接在控制台中执行 dompdf.js 命令。要捕获整个页面的默认 PDF,使用 `dompdf(document.body)`。

## 使用方法

安装完成后,dompdf.js 就可以使用了。以下命令将生成 `#element-to-print` 的 PDF 并提示用户保存结果:

```js
var element = document.getElementById('element-to-print');
dompdf(element);
```

### 高级用法

dompdf.js 的每个步骤都是可配置的,使用其新的基于 Promise 的 API。如果调用 dompdf.js 时没有参数,它将返回一个 `Worker` 对象:

```js
var worker = dompdf();  // 或:  var worker = new dompdf.Worker;
```

这个 worker 有一些方法可以按顺序链式调用,每个 Promise 解析后,允许在步骤之间插入您自己的中间函数。先决条件系统允许您跳过必需的步骤(如画布创建)而不会出现任何问题:

```js
// 这将在保存之前隐式创建画布和 PDF 对象
var worker = dompdf().from(element).save();
```

#### 工作流程

dompdf.js 任务的基本工作流程(由先决条件系统强制执行)是:

```
.from() -> .toContainer() -> .toCanvas() -> .toImg() -> .toPdf() -> .save()
```

#### Worker API

| Method       | Arguments          | Description |
|--------------|--------------------|-------------|
| from         | src, type          | Sets the source (HTML string or element) for the PDF. Optional `type` specifies other sources: `'string'`, `'element'`, `'canvas'`, or `'img'`. |
| to           | target             | Converts the source to the specified target (`'container'`, `'canvas'`, `'img'`, or `'pdf'`). Each target also has its own `toX` method that can be called directly: `toContainer()`, `toCanvas()`, `toImg()`, and `toPdf()`. |
| output       | type, options, src | Routes to the appropriate `outputPdf` or `outputImg` method based on specified `src` (`'pdf'` (default) or `'img'`). |
| outputPdf    | type, options      | Sends `type` and `options` to the jsPDF object's `output` method, and returns the result as a Promise (use `.then` to access). See the [jsPDF source code](https://rawgit.com/MrRio/jsPDF/master/docs/jspdf.js.html#line992) for more info. |
| outputImg    | type, options      | Returns the specified data type for the image as a Promise (use `.then` to access). Supported types: `'img'`, `'datauristring'`/`'dataurlstring'`, and `'datauri'`/`'dataurl'`. |
| save         | filename           | Saves the PDF object with the optional filename (creates user download prompt). |
| set          | opt                | Sets the specified properties. See [Options](#options) below for more details. |
| get          | key, cbk           | Returns the property specified in `key`, either as a Promise (use `.then` to access), or by calling `cbk` if provided. |
| then         | onFulfilled, onRejected | Standard Promise method, with `this` re-bound to the Worker, and with added progress-tracking (see [Progress](#progress) below). Note that `.then` returns a `Worker`, which is a subclass of Promise. |
| thenCore     | onFulFilled, onRejected | Standard Promise method, with `this` re-bound to the Worker (no progress-tracking). Note that `.thenCore` returns a `Worker`, which is a subclass of Promise. |
| thenExternal | onFulfilled, onRejected | True Promise method. Using this 'exits' the Worker chain - you will not be able to continue chaining Worker methods after `.thenExternal`. |
| catch, catchExternal | onRejected | Standard Promise method. `catchExternal` exits the Worker chain - you will not be able to continue chaining Worker methods after `.catchExternal`. |
| error        | msg                | Throws an error in the Worker's Promise chain. |

A few aliases are also provided for convenience:

| Method    | Alias     |
|-----------|-----------|
| save      | saveAs    |
| set       | using     |
| output    | export    |
| then      | run       |

## 配置选项

dompdf.js 可以使用可选的 `opt` 参数进行配置:

```js
var element = document.getElementById('element-to-print');
var opt = {
  margin:       1,
  filename:     'myfile.pdf',
  image:        { type: 'jpeg', quality: 0.98 },
  html2canvas:  { scale: 2 },
  jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
};

// New Promise-based usage:
dompdf().set(opt).from(element).save();

// Old monolithic-style usage:
dompdf(element, opt);
```

`opt` 参数具有以下可选字段:

|Name        |Type            |Default                         |Description                                                                                                 |
|------------|----------------|--------------------------------|------------------------------------------------------------------------------------------------------------|
|margin      |number or array |`0`                             |PDF margin (in jsPDF units). Can be a single number, `[vMargin, hMargin]`, or `[top, left, bottom, right]`. |
|filename    |string          |`'file.pdf'`                    |The default filename of the exported PDF.                                                                   |
|pagebreak   |object          |`{mode: ['css', 'legacy']}`     |Controls the pagebreak behaviour on the page. See [Page-breaks](#page-breaks) below.                        |
|image       |object          |`{type: 'jpeg', quality: 0.95}` |The image type and quality used to generate the PDF. See [Image type and quality](#image-type-and-quality) below.|
|enableLinks |boolean         |`true`                          |If enabled, PDF hyperlinks are automatically added ontop of all anchor tags.                                |
|html2canvas |object          |`{ }`                           |Configuration options sent directly to `html2canvas` ([see here](https://html2canvas.hertzen.com/configuration) for usage).|
|jsPDF       |object          |`{ }`                           |Configuration options sent directly to `jsPDF` ([see here](http://rawgit.com/MrRio/jsPDF/master/docs/jsPDF.html) for usage).|

### Page-breaks

dompdf.js 具有自动添加页面断点的能力,以清理您的文档。页面断点可以通过 CSS 样式、使用选择器设置在单个元素上,或者避免在所有元素内部断开(`avoid-all` 模式)。

默认情况下,dompdf.js 将尊重大多数 CSS [`break-before`](https://developer.mozilla.org/en-US/docs/Web/CSS/break-before), [`break-after`](https://developer.mozilla.org/en-US/docs/Web/CSS/break-after), 和 [`break-inside`](https://developer.mozilla.org/en-US/docs/Web/CSS/break-inside) 规则,并在任何元素具有类 `dompdf__page-break` 时添加页面断点(出于遗留目的)。

#### Page-break settings

|Setting   |Type            |Default             |Description |
|----------|----------------|--------------------|------------|
|mode      |string or array |`['css', 'legacy']` |The mode(s) on which to automatically add page-breaks. One or more of `'avoid-all'`, `'css'`, and `'legacy'`. |
|before    |string or array |`[]`                |CSS selectors for which to add page-breaks before each element. Can be a specific element with an ID (`'#myID'`), all elements of a type (e.g. `'img'`), all of a class (`'.myClass'`), or even `'*'` to match every element. |
|after     |string or array |`[]`                |Like 'before', but adds a page-break immediately after the element. |
|avoid     |string or array |`[]`                |Like 'before', but avoids page-breaks on these elements. You can enable this feature on every element using the 'avoid-all' mode. |

#### Page-break modes

| Mode      | Description |
|-----------|-------------|
| avoid-all | Automatically adds page-breaks to avoid splitting any elements across pages. |
| css       | Adds page-breaks according to the CSS `break-before`, `break-after`, and `break-inside` properties. Only recognizes `always/left/right` for before/after, and `avoid` for inside. |
| legacy    | Adds page-breaks after elements with class `dompdf__page-break`. This feature may be removed in the future. |

#### 使用示例

```js
// Avoid page-breaks on all elements, and add one before #page2el.
dompdf().set({
  pagebreak: { mode: 'avoid-all', before: '#page2el' }
});

// Enable all 'modes', with no explicit elements.
dompdf().set({
  pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
});

// No modes, only explicit elements.
dompdf().set({
  pagebreak: { before: '.beforeClass', after: ['#after1', '#after2'], avoid: 'img' }
});
```

### Image type and quality

You may customize the image type and quality exported from the canvas by setting the `image` option. This must be an object with the following fields:

|Name        |Type            |Default                       |Description                                                                                  |
|------------|----------------|------------------------------|---------------------------------------------------------------------------------------------|
|type        |string          |'jpeg'                        |The image type. HTMLCanvasElement only supports 'png', 'jpeg', and 'webp' (on Chrome).       |
|quality     |number          |0.95                          |The image quality, from 0 to 1. This setting is only used for jpeg/webp (not png).           |

These options are limited to the available settings for [HTMLCanvasElement.toDataURL()](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toDataURL), which ignores quality settings for 'png' images. To enable png image compression, try using the [canvas-png-compression shim](https://github.com/ShyykoSerhiy/canvas-png-compression), which should be an in-place solution to enable png compression via the `quality` option.

## 进度跟踪

`dompdf()` 返回的 Worker 对象具有内置的进度跟踪机制。它将更新以允许进度回调,但目前仍在进行中。

## 依赖项

dompdf.js 依赖于外部包 [html2canvas](https://github.com/niklasvh/html2canvas), [jsPDF](https://github.com/MrRio/jsPDF), 和 [es6-promise](https://github.com/stefanpenner/es6-promise)。这些依赖项在使用 NPM 或捆绑包时自动加载。

如果使用未打包的 `dist/dompdf.min.js` (或其未最小化的版本),您还必须包括每个依赖项。顺序很重要,否则 html2canvas 将被 jsPDF 的内部实现覆盖:

```html
<script src="es6-promise.auto.min.js"></script>
<script src="jspdf.min.js"></script>
<script src="html2canvas.min.js"></script>
<script src="dompdf.min.js"></script>
```

## 贡献

### 问题

在提交问题时,请提供可重现的代码,最好是创建一个[这个模板 jsFiddle](https://jsfiddle.net/u6o6ne41/) 的 fork(已经加载了 dompdf.js),记住 dompdf.js 使用 [html2canvas](https://github.com/niklasvh/html2canvas) 和 [jsPDF](https://github.com/MrRio/jsPDF) 作为依赖项,所以检查每个仓库的问题跟踪器以查看是否已经解决了您的问题。

#### 已知问题

1. **渲染:** html2canvas 渲染引擎不是完美的(尽管它相当不错!)。如果 html2canvas 没有正确渲染您的内容,我无法修复它。
    - 您可以使用[这个 fiddle](https://jsfiddle.net/eKoopmans/z1rupL4c/) 进行测试,看看画布创建本身是否有问题。

2. **节点克隆(CSS 等):** dompdf.js 克隆内容的方式存在错误。正在开发修复 - 尝试:
    - 直接文件: 转到 [dompdf.js/bugfix/clone-nodes-BUILD](/eKoopmans/dompdf.js/tree/bugfix/clone-nodes-BUILD) 并替换项目中的相关文件(例如 `dist/dompdf.bundle.js`)
    - npm: `npm install eKoopmans/dompdf.js#bugfix/clone-nodes-BUILD`
    - 相关项目: [Bugfix: Cloned nodes](https://github.com/eKoopmans/dompdf.js/projects/9)

3. **调整大小:** 目前,dompdf.js 将根元素调整大小以适应 PDF 页面(导致内部内容"重新流动")。
    - 这通常是所需的行为,但并非总是如此。
    - 有计划添加替代行为(例如"shrink-to-page"),但尚未准备好测试。
    - 相关项目: [Feature: Single-page PDFs](https://github.com/eKoopmans/dompdf.js/projects/1)

4. **渲染为图像:** dompdf.js 将所有内容渲染为图像,然后将该图像放入 PDF 中。
    - 这意味着文本是*不可选择或可搜索的*,并导致大文件大小。
    - 这是目前不可避免的,但是最近在 jsPDF 中的改进可能很快使其能够直接渲染为矢量图形。
    - 相关项目: [Feature: New renderer](https://github.com/eKoopmans/dompdf.js/projects/4)

5. **Promise 冲突:** dompdf.js 依赖于特定的 Promise 行为,并且可能在与自定义 Promise 库一起使用时失败。
    - 在下一个版本中,Promises 将在 dompdf.js 中沙盒化以删除此问题。
    - 相关项目: [Bugfix: Sandboxed promises](https://github.com/eKoopmans/dompdf.js/projects/11)

6. **最大大小:** HTML5 画布具有[最大高度/宽度](https://stackoverflow.com/a/11585939/4080966)。任何大于该值的都会失败。
    - 这是 HTML5 本身的限制,导致 dompdf.js 中的大 PDF 完全空白。
    - jsPDF 画布渲染器(在已知问题 #4 中提到)可能能够修复此问题!
    - 相关项目: [Bugfix: Maximum canvas size](https://github.com/eKoopmans/dompdf.js/projects/5)

### 测试

dompdf.js 目前严重缺乏单元测试。任何贡献或建议的自动(或手动)测试都是受欢迎的。这是这个项目的高优先级待办事项。

### Pull requests

如果您想创建新功能或错误修复,请随时分叉并提交拉取请求!分叉,从 `main` 分支分支,并对 `/src/` 文件进行更改(而不是直接对 `/dist/` 进行更改)。您可以通过重建 `npm run build` 来测试更改。

## 致谢

[Erik Koopmans](https://github.com/eKoopmans)

#### 贡献者

- [@WilcoBreedt](https://github.com/WilcoBreedt)
- [@Ranger1230](https://github.com/Ranger1230)

#### 特别感谢

- [Sauce Labs](https://saucelabs.com/) 用于单元测试。

## 许可证

[The MIT License](http://opensource.org/licenses/MIT)

Copyright (c) 2017-2019 Erik Koopmans <[http://www.erik-koopmans.com/](http://www.erik-koopmans.com/)>