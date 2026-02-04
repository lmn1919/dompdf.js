# dompdf.js

[English](./README.md) | [中文](./README_CN.md)

<!-- [Home](https://html2canvas.hertzen.com) | [Downloads](https://github.com/niklasvh/html2canvas/releases) | [Questions](https://github.com/niklasvh/html2canvas/discussions/categories/q-a)

[![Gitter](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/niklasvh/html2canvas?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge)
![CI](https://github.com/niklasvh/html2canvas/workflows/CI/badge.svg?branch=master)
[![NPM Downloads](https://img.shields.io/npm/dm/html2canvas.svg)](https://www.npmjs.org/package/html2canvas)
[![NPM Version](https://img.shields.io/npm/v/html2canvas.svg)](https://www.npmjs.org/package/html2canvas) -->

This script allows you to generate editable, non-image, printable vector PDFs directly on the user's browser from web pages or parts of web pages. It supports pagination and can generate PDF files with thousands of pages. Since the generation is based on the DOM, the result may not be 100% consistent with the actual appearance. It is not recommended for complex PDF generation requirements.

Live Demo: [Online Demo](https://dompdfjs.lisky.com.cn)

### PDF Generation Example

![PDF Generation Example](./examples/test.jpg)

### 🛠️ How it works

This script is based on [html2canvas](https://github.com/niklasvh/html2canvas) and [jspdf](https://github.com/MrRio/jsPDF). Unlike traditional methods that render HTML pages to images via html2canvas and then generate PDF files from images via jspdf, this script modifies the canvas-renderer file of html2canvas by reading the DOM and styles applied to elements, and calls jspdf methods to generate PDF files.
Therefore, it has the following advantages:

1. No server-side rendering is required because the entire PDF is created on the **client-side browser**.
2. It generates real PDF files, not image-based ones, so the quality of the generated PDF is higher, and you can edit and print the generated PDF files.
3. Smaller PDF file size.
4. Not limited by canvas rendering height, allowing for the generation of PDF files with thousands of pages.

Of course, it also has some disadvantages:

1. Since it is based on the DOM, it may not be 100% consistent with the actual appearance.
2. Some CSS properties are not yet supported. See [Supported CSS Properties](https://www.html2canvas.cn/html2canvas-features.html).

### Implemented Features

| Feature            | Status | Description                                                                                                                                              |
| :----------------- | :----- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pagination         | ✅     | Supports PDF pagination rendering, capable of generating PDF files with thousands of pages                                                               |
| Text Rendering     | ✅     | Supports basic text content rendering, font-family, font-size, font-style, font-variant, color, etc., supports text stroke, does not support text shadow |
| Image Rendering    | ✅     | Supports web images, base64 images, svg images                                                                                                           |
| Borders            | ✅     | Supports border-width, border-color, border-style, border-radius, currently only solid borders are implemented                                           |
| Background         | ✅     | Supports background color, background image, background gradient                                                                                         |
| Canvas             | ✅     | Supports rendering canvas                                                                                                                                |
| SVG                | ✅     | Supports rendering svg                                                                                                                                   |
| Shadow Rendering   | ✅     | Uses foreignObjectRendering, supports border shadow rendering                                                                                            |
| Gradient Rendering | ✅     | Uses foreignObjectRendering, supports background gradient rendering                                                                                      |
| Iframe             | ❌     | Does not support rendering iframe yet                                                                                                                    |

### Usage

The dompdf library uses `Promise` and expects them to be available in the global context. If you wish to support [older browsers](http://caniuse.com/#search=promise) that do not natively support `Promise`, please include a polyfill, such as [es6-promise](https://github.com/jakearchibald/es6-promise), before importing `dompdf`.

Installation:

     npm install dompdf.js --save

CDN Import:

```html
<script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.js"></script>
```

#### Basic Usage

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

#### PDF Pagination Rendering

By default, dompdf renders the entire document onto a single page.

You can enable pagination rendering by setting the `pagination` option to `true`. Customize header and footer size, content, font color/size, position, etc., via the pageConfig field.

**_ Note: Please ensure that the DOM node to be generated as PDF is set to the corresponding page width (px). For example, set the width to 794px for A4. Here is the page size reference table: [page_sizes.md](./page_sizes.md) _**

```js
import dompdf from 'dompdf.js';

dompdf(document.querySelector('#capture'), {
    pagination: true,
    format: 'a4',
    pageConfig: {
        header: {
            content: 'This is the header',
            height: 50,
            contentColor: '#333333',
            contentFontSize: 12,
            contentPosition: 'center',
            padding: [0, 0, 0, 0]
        },
        footer: {
            content: 'Page ${currentPage} of ${totalPages}',
            height: 50,
            contentColor: '#333333',
            contentFontSize: 12,
            contentPosition: 'center',
            padding: [0, 0, 0, 0]
        }
    }
})
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

##### Precise Pagination Control - `divisionDisable` Attribute

If you do not want a container to be split during pagination, add the `divisionDisable` attribute to that element, and it will be moved to the next page entirely when crossing pages.

#### ⚙️ options Parameters

| Parameter          | Required | Default    | Type                     | Description                                                                                                                                                                                                                                                                                                                                               |
| :----------------- | :------- | :--------- | :----------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useCORS`          | No       | `false`    | `boolean`                | Allow cross-origin resources (requires server-side CORS configuration)                                                                                                                                                                                                                                                                                    |
| `backgroundColor`  | No       | Auto/White | `string \| null`         | Override page background color; pass `null` to generate transparent background                                                                                                                                                                                                                                                                            |
| `fontConfig`       | No       | -          | `object \| Array`        | Non-English font configuration, see table below                                                                                                                                                                                                                                                                                                           |
| `encryption`       | No       | Empty      | `object`                 | PDF encryption configuration. Property `userPassword` is used for the user password under the given permission list; property `ownerPassword` needs userPassword and ownerPassword to be set for correct authentication; property `userPermissions` is used to specify user permissions, optional values are `['print', 'modify', 'copy', 'annot-forms']` |
| `precision`        | No       | `16`       | `number`                 | Element position precision                                                                                                                                                                                                                                                                                                                                |
| `compress`         | No       | `false`    | `boolean`                | Whether to compress PDF                                                                                                                                                                                                                                                                                                                                   |
| `putOnlyUsedFonts` | No       | `false`    | `boolean`                | Embed only actually used fonts into PDF                                                                                                                                                                                                                                                                                                                   |
| `pagination`       | No       | `false`    | `boolean`                | Enable pagination rendering                                                                                                                                                                                                                                                                                                                               |
| `format`           | No       | `'a4'`     | `string`                 | Page size, supports `a0–a10`, `b0–b10`, `c0–c10`, `letter`, etc.                                                                                                                                                                                                                                                                                          |
| `pageConfig`       | No       | See below  | `object`                 | Header and footer configuration                                                                                                                                                                                                                                                                                                                           |
| `onJspdfReady`     | No       | ``         | `Function(jspdf: jsPDF)` | jspdf instance initialization                                                                                                                                                                                                                                                                                                                             |
| `onJspdfFinish`    | No       | ``         | `Function(jspdf: jsPDF)` | jspdf instance finished drawing PDF                                                                                                                                                                                                                                                                                                                       |

##### `pageConfig` Fields:

| Parameter | Default                     | Type   | Description     |
| :-------- | :-------------------------- | :----- | :-------------- |
| `header`  | See pageConfigOptions below | object | Header settings |
| `footer`  | See pageConfigOptions below | object | Footer settings |

##### `pageConfigOptions` Fields:

| Parameter         | Default                                                                   | Type                               | Description                                                                                                                                                      |
| :---------------- | :------------------------------------------------------------------------ | :--------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `content`         | Header default is empty, footer default is `${currentPage}/${totalPages}` | `string`                           | Text content, supports `${currentPage}`, `${totalPages}`, `${currentPage}` is current page number, `${totalPages}` is total page number                          |
| `height`          | `50`                                                                      | `number`                           | Area height (px)                                                                                                                                                 |
| `contentPosition` | `'center'`                                                                | `string \| [number, number]`       | Text position enum `center`, `centerLeft`, `centerRight`, `centerTop`, `centerBottom`, `leftTop`, `leftBottom`, `rightTop`, `rightBottom` or coordinates `[x,y]` |
| `contentColor`    | `'#333333'`                                                               | `string`                           | Text color                                                                                                                                                       |
| `contentFontSize` | `16`                                                                      | `number`                           | Text font size (px)                                                                                                                                              |
| `padding`         | `[0,24,0,24]`                                                             | `[number, number, number, number]` | Top/Right/Bottom/Left padding (px)                                                                                                                               |

##### Font Configuration (`fontConfig`) Fields:

| Field        | Required                          | Default | Type     | Description                                |
| :----------- | :-------------------------------- | :------ | :------- | :----------------------------------------- |
| `fontFamily` | Yes (when using custom font)      | `''`    | `string` | Font family name (same as injected `.ttf`) |
| `fontBase64` | Yes (when using custom font)      | `''`    | `string` | Base64 string content of `.ttf`            |
| `fontStyle`  | Yes (when using custom font)      | `''`    | `string` | `normal \| italic`                         |
| `fontWeight` | Yes (when using custom font bold) | `''`    | `number` | `400 \| 700`                               |

#### 🔣 Garbled Characters - Font Import Support

Since jspdf only supports English, other languages will appear as garbled characters, requiring the import of corresponding font files to resolve. If you need custom fonts, convert the font tff file to a base64 format js file [here](https://github.com/lmn1919/dompdf.js/tree/main/fontconverter). For Chinese fonts, [Source Han Sans](https://github.com/lmn1919/dompdf.js/blob/main/examples/SourceHanSansSC-Normal-Min-normal.js) is recommended due to its smaller size.
Import the file in the code.

> **Note: Importing fonts will increase the final PDF file size. If there are requirements for the final PDF size, it is recommended to streamline the font, you can remove unnecessary fonts. Or use tools like `Fontmin` to slim down the font.**

```js
<script type="text/javascript" src="./SourceHanSansSC-Normal-Min-normal.js"></script>
<script type="text/javascript" src="./SourceHanSansCNBold-bold.js"></script>
<script type="text/javascript" src="./SourceHanSansCNNormal-normal.js"></script>
<script type="text/javascript" src="./SourceHanSansCNRegularItalic-normal.js"></script>
<script>
  /* Import fonts */
  dompdf(document.querySelector('#capture'), {
    useCORS: true,
    /* Single font import */
    /* fontConfig: {
      fontFamily: 'SourceHanSansSC-Normal-Min',
      fontBase64: window.fontBase64,
      fontStyle: 'normal',
      fontWeight: 400,
    }, */
    /* Import and register multiple fonts, import corresponding fonts for required languages and styles */
    fontConfig: [
        {
            fontFamily: 'SourceHanSansCNRegularItalic',
            fontBase64: window.SourceHanSansCNRegularItalic,
            fontUrl: '',
            fontWeight: 400,
            fontStyle: 'italic' // Italic
        },
        {
            fontFamily: 'SourceHanSansCNBold',
            fontBase64: window.SourceHanSansCNBold,
            fontUrl: '',
            fontWeight: 700, // Bold
            fontStyle: 'normal'
        },
        {
            fontFamily: 'SourceHanSansCNNormal',
            fontBase64: window.SourceHanSansCNNormal,
            fontUrl: '',
            fontWeight: 400,
            fontStyle: 'normal'
        },
    ],
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
      console.error(err);
    });
</script>
```

#### 🎨 Rendering Complex Styles like Gradients, Shadows - Using foreignObjectRendering

In cases where the DOM is very complex or the PDF cannot be drawn (e.g., complex tables, border shadows, gradients, etc.), consider using foreignObjectRendering.
Add the foreignObjectRendering attribute to the element to be rendered, and it will be rendered as a background image inserted into the PDF file via svg's foreignObject.

However, since the rendering of foreignObject elements depends on the browser's implementation, it may behave differently in different browsers.
Therefore, when using foreignObjectRendering, please note the following:

1. The rendering of foreignObject elements depends on the browser's implementation, so it may behave differently in different browsers.
2. IE browser does not support it at all, recommended to use in Chrome, Firefox, Edge.
3. The generated image will increase the PDF file size.

Example

```html
<div style="width: 100px;height: 100px;" foreignObjectRendering>
    <div
        style="width: 50px;height: 50px;border: 1px solid #000;box-shadow: 2px 2px 5px rgba(0,0,0,0.3);background: linear-gradient(45deg, #ff6b6b, #4ecdc4);"
    >
        This is a div element
    </div>
</div>
```

### 🌐 Browser Compatibility

The library should work properly on the following browsers (requires `Promise` polyfill):

-   Firefox 3.5+
-   Google Chrome
-   Opera 12+
-   IE9+
-   Safari 6+

### 🏗️ Build

Clone git repository:

    $ git clone git@github.com:lmn1919/dompdf.js.git

Install dependencies:

    $ npm install

Build browser package:

    $ npm run build

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=lmn1919/dompdf.js&type=Date)](https://www.star-history.com/#lmn1919/dompdf.js&Date)

