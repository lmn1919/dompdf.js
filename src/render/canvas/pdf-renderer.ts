import { jsPDF } from "jspdf"; // 用于生成PDF文档

// import "../../SourceHanSansSC-Normal-Min-normal"; // 导入思源黑体
// import "../../SourceHanSansCN-Medium-normal"; // 导入阿里巴巴普惠体字体
import { contains } from '../../core/bitwise'; // 位运算工具函数
import { Context } from '../../core/context'; // 上下文对象
import { CSSParsedDeclaration } from '../../css'; // CSS解析声明
import { Bounds } from '../../css/layout/bounds'; // 边界计算
import { segmentGraphemes, TextBounds } from '../../css/layout/text'; // 文本分段和边界
import { BACKGROUND_CLIP } from '../../css/property-descriptors/background-clip'; // 背景裁剪属性
import { BORDER_STYLE } from '../../css/property-descriptors/border-style'; // 边框样式
import { DIRECTION } from '../../css/property-descriptors/direction'; // 文字方向
import { DISPLAY } from '../../css/property-descriptors/display'; // 显示属性
import { computeLineHeight } from '../../css/property-descriptors/line-height'; // 行高计算
import { LIST_STYLE_TYPE } from '../../css/property-descriptors/list-style-type'; // 列表样式类型
import { PAINT_ORDER_LAYER } from '../../css/property-descriptors/paint-order'; // 绘制顺序层
import { TEXT_ALIGN } from '../../css/property-descriptors/text-align'; // 文本对齐
import { TEXT_DECORATION_LINE } from '../../css/property-descriptors/text-decoration-line'; // 文本装饰线
// import { TextShadow } from '../../css/property-descriptors/text-shadow'; // 文本阴影
import { isDimensionToken } from '../../css/syntax/parser'; // 维度标记判断
import { asString, Color, isTransparent, } from '../../css/types/color'; // 颜色相关工具
// import { calculateGradientDirection, calculateRadius, processColorStops } from '../../css/types/functions/gradient'; // 渐变计算
import { CSSImageType, CSSURLImage, isLinearGradient, isRadialGradient } from '../../css/types/image'; // 图片类型
import { getAbsoluteValue } from '../../css/types/length-percentage'; // 长度百分比FIFTY_PERCENT,
import { ElementContainer, FLAGS } from '../../dom/element-container'; // 元素容器
import { SelectElementContainer } from '../../dom/elements/select-element-container'; // Select元素容器
import { TextareaElementContainer } from '../../dom/elements/textarea-element-container'; // Textarea元素容器
import { ReplacedElementContainer } from '../../dom/replaced-elements'; // 替换元素容器
import { CanvasElementContainer } from '../../dom/replaced-elements/canvas-element-container'; // Canvas元素容器
import { IFrameElementContainer } from '../../dom/replaced-elements/iframe-element-container'; // IFrame元素容器
import { ImageElementContainer } from '../../dom/replaced-elements/image-element-container'; // Image元素容器
import { CHECKBOX, INPUT_COLOR, InputElementContainer, RADIO } from '../../dom/replaced-elements/input-element-container'; // Input元素容器
import { SVGElementContainer } from '../../dom/replaced-elements/svg-element-container'; // SVG元素容器
import { TextContainer } from '../../dom/text-container'; // 文本容器


import { calculateBackgroundRendering, getBackgroundValueForIndex } from '../background'; // 背景渲染计算
import { BezierCurve, isBezierCurve } from '../bezier-curve'; // 贝塞尔曲线
import {
    parsePathForBorder,
    parsePathForBorderDoubleInner,
    parsePathForBorderDoubleOuter,
    parsePathForBorderStroke
} from '../border'; // 边框路径解析
import { BoundCurves, calculateBorderBoxPath, calculateContentBoxPath, calculatePaddingBoxPath } from '../bound-curves'; // 边界曲线计算
import { contentBox } from '../box-sizing'; // 内容盒模型
import { EffectTarget, IElementEffect, isClipEffect, isOpacityEffect, isTransformEffect } from '../effects'; // 效果相关
import { FontMetrics } from '../font-metrics'; // 字体度量
// transformPath
import { Path } from '../path'; // 路径变换
import { Renderer } from '../renderer'; // 渲染器基类
import { ElementPaint, parseStackingContexts, StackingContext } from '../stacking-context'; // 堆叠上下文
import { Vector } from '../vector'; // 向量

interface FontConfig {
    fontFamily: string;
    fontBase64: string;
    fontUrl: string;
    fontWeight: number;
    fontStyle: string;
}

// 渲染配置接口,继承自RenderOptions并添加backgroundColor属性
export type RenderConfigurations = RenderOptions & {
    backgroundColor: Color | null;
    fontConfig: FontConfig; // 字体
};

// 渲染选项接口
export interface RenderOptions {
    scale: number; // 缩放比例
    canvas?: HTMLCanvasElement; // 可选的canvas元素
    x: number; // x坐标
    y: number; // y坐标
    width: number; // 宽度
    height: number; // 高度
    pdfFileName?: string; // 新增 PDF 文件名选项
}

// 遮罩偏移常量
// const MASK_OFFSET = 10000;

// Canvas渲染器类,继承自Renderer
export class CanvasRenderer extends Renderer {
    canvas: HTMLCanvasElement; // canvas元素
    ctx: CanvasRenderingContext2D; // canvas上下文
    readonly jspdfCtx: any; // jsPDF上下文
    readonly context2dCtx: any; // jsPDFcontext2d上下文
    private readonly _activeEffects: IElementEffect[] = []; // 活动效果数组
    private readonly fontMetrics: FontMetrics; // 字体度量
    private readonly pxToPt: (px: number) => number; // 将 px 转换为 pt 的函数


    // 构造函数
    constructor(context: Context, options: RenderConfigurations) {
        console.log('options参数',options,context)
        super(context, options);
        this.canvas = options.canvas ? options.canvas : document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;

        // 计算页面尺寸并转换为 pt 单位 (1pt = 1/72 inch, 1px = 1/96 inch)
        const pxToPt = (px: number) => px * (72 / 96);
        //
        const pageWidth = pxToPt(options.width);
        const pageHeight = pxToPt(options.height);



        // 初始化 jsPDF
        this.jspdfCtx = new jsPDF({
            orientation: pageWidth > pageHeight ? 'landscape' : 'portrait',
            unit: 'pt',
            format: [pageWidth, pageHeight],
            hotfixes: ["px_scaling"]
        });
// 设置PDF文件的保存方式
        this.context2dCtx = this.jspdfCtx.context2d;
        this.context2dCtx.scale(0.75, 0.75);

        this.context2dCtx.translate(-options.x, -options.y);

        // 确保字体已加载并注册到 jsPDF
        if (options.fontConfig) {
            try {
                this.loadFont();
            } catch (error) {
                console.warn('Failed to set font:', error);
                // 如果设置失败，使用默认字体
                this.jspdfCtx.setFont('Helvetica');
            }
        }

        // this.jspdfCtx.setFont('SourceHanSansSC-Normal-Min');

        // 将 pxToPt 保存为实例属性，以便其他方法使用
        this.pxToPt = pxToPt;

        if (!options.canvas) {
            this.canvas.width = 10;
            this.canvas.height = 10;
            this.canvas.style.width = `10px`;
            this.canvas.style.height = `10px`;
        }

        this.fontMetrics = new FontMetrics(document);
        // this.ctx.scale(this.options.scale, this.options.scale);
        // this.ctx.translate(-options.x, -options.y);

        // this.ctx.textBaseline = 'bottom';


        this.context2dCtx.textBaseline = 'bottom';
        this._activeEffects = [];

        this.context.logger.debug(
            `Canvas renderer initialized (${options.width}x${options.height}) with scale ${options.scale}`
        );
    }


    async loadFont() {
        let fontData;

        if (this.options.fontConfig.fontBase64) {
            // 直接使用 Base64 编码
            fontData = this.options.fontConfig.fontBase64;
        } else if (this.options.fontConfig.fontUrl) {
            fontData = await this.loadFontFromURL(this.options.fontConfig.fontUrl);
        }
        // console.log('fontData',fontData)
        // 将字体添加到 jsPDF
        this.addFontToJsPDF(fontData as string);
    }

    async loadFontFromURL(url: string) {
        // 使用 fetch 加载远程字体文件
        const response = await fetch(url, {
            mode: 'no-cors', // 强制绕过 CORS
            headers: {
                'Content-Type': 'font/ttf'
            }
        });

        const blob = await response.blob();
        // const fontUrl = URL.createObjectURL(blob);
        // console.log('response', blob, fontUrl)

        // 注意：no-cors 模式下无法读取响应内容！
        // const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader: any = new FileReader();
            reader.onload = () => resolve(reader.result.split(',')[1]); // 提取 Base64 数据
            reader.onerror = () => reject(new Error('字体文件读取失败'));
            reader.readAsDataURL(blob);
        });
    }


    addFontToJsPDF(fontData: string) {
        const { fontFamily, fontWeight, fontStyle } = this.options.fontConfig;
        if (!fontFamily) {
            return
        }
        this.jspdfCtx.addFileToVFS(`${fontFamily}.ttf`, fontData); // 将字体添加到虚拟文件系统
        this.jspdfCtx.addFont(`${fontFamily}.ttf`, fontFamily, fontStyle, fontWeight); // 注册字体
        this.jspdfCtx.setFont(fontFamily); // 设置当前字体
    }


    // 应用效果数组
    applyEffects(effects: IElementEffect[]): void {
        while (this._activeEffects.length) {
            this.popEffect();
        }

        effects.forEach((effect) => this.applyEffect(effect));
    }



    // 应用单个效果
    applyEffect(effect: IElementEffect): void {
        this.ctx.save();
        // this.context2dCtx.save()
        if (isOpacityEffect(effect)) {
            this.ctx.globalAlpha = effect.opacity;
            // this.context2dCtx.globalAlpha = effect.opacity
        }

        if (isTransformEffect(effect)) {
            this.ctx.translate(effect.offsetX, effect.offsetY);
            this.ctx.transform(
                effect.matrix[0],
                effect.matrix[1],
                effect.matrix[2],
                effect.matrix[3],
                effect.matrix[4],
                effect.matrix[5]
            );
            this.ctx.translate(-effect.offsetX, -effect.offsetY);

            // this.context2dCtx.translate(effect.offsetX, effect.offsetY);
            // this.context2dCtx.transform(
            //     effect.matrix[0],
            //     effect.matrix[1],
            //     effect.matrix[2],
            //     effect.matrix[3],
            //     effect.matrix[4],
            //     effect.matrix[5]
            // );
            // this.context2dCtx.translate(-effect.offsetX, -effect.offsetY);
        }

        if (isClipEffect(effect)) {
            this.path(effect.path);
            this.ctx.clip();
            // this.context2dCtx.clip()
        }

        this._activeEffects.push(effect);
    }

    // 移除最后应用的效果
    popEffect(): void {
        this._activeEffects.pop();
        // this.ctx.restore();
        this.context2dCtx.restore()
        if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
            this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
        }
    }

    // 渲染堆叠上下文
    async renderStack(stack: StackingContext): Promise<void> {

        const styles = stack.element.container.styles;
        if (styles.isVisible()) {
            await this.renderStackContent(stack);
        } else {
            // console.log('不渲染', styles.isVisible())
        }
    }

    // 渲染节点
    async renderNode(paint: ElementPaint): Promise<void> {
        if (contains(paint.container.flags, FLAGS.DEBUG_RENDER)) {
            debugger;
        }

        if (paint.container.styles.isVisible()) {
            await this.renderNodeBackgroundAndBorders(paint);
            await this.renderNodeContent(paint);

        }
    }


    // 渲染带有字母间距的文本
    renderTextWithLetterSpacing(text: TextBounds, letterSpacing: number, baseline: number): void {

        if (letterSpacing === 0) {
            // console.log(text.text, text.bounds.left,'绘制文字-没有letterSpacing')
            // this.ctx.fillText(text.text, text.bounds.left, text.bounds.top + baseline);
            this.context2dCtx.fillText(text.text, text.bounds.left, text.bounds.top + baseline);
        } else {
            const letters = segmentGraphemes(text.text);
            letters.reduce((left, letter) => {
                // console.log(left, letter,'绘制文字')
                // this.ctx.fillText(letter, left, text.bounds.top + baseline);
                // this.context2dCtx.fillText(letter, left - leftMargin, text.bounds.top + baseline - topMargin);
// 使用jspdf绘制文字
                this.context2dCtx.fillText(letter, left, text.bounds.top + baseline);
                return left + this.ctx.measureText(letter).width;
            }, text.bounds.left);
        }
    }

    // 创建字体样式
    private createFontStyle(styles: CSSParsedDeclaration): string[] {
        const fontVariant = styles.fontVariant
            .filter((variant) => variant === 'normal' || variant === 'small-caps')
            .join('');
        const fontFamily = fixIOSSystemFonts(styles.fontFamily).join(', ');
        const fontSize = isDimensionToken(styles.fontSize)
            ? `${styles.fontSize.number}${styles.fontSize.unit}`
            : `${styles.fontSize.number}px`;

        return [
            [styles.fontStyle, fontVariant, styles.fontWeight, fontSize, fontFamily].join(' '),
            fontFamily,
            fontSize
        ];
    }

    // 添加一个新的颜色转换函数
    private convertColor(color: Color): string {
        // 如果是透明色，返回白色
        if (isTransparent(color)) {
            return '#FFFFFF';
        }

        // 将 rgba 转换为 rgb
        // 从32位整数中提取RGB分量
        const r = 0xff & (color >> 24);
        const g = 0xff & (color >> 16);
        const b = 0xff & (color >> 8);
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;

        // 其他颜色格式直接使用 asString
        return asString(color);
    }

    async renderTextNode(text: TextContainer, styles: CSSParsedDeclaration): Promise<void> {
        const [font, fontFamily, fontSize] = this.createFontStyle(styles);
        // ,

        // 设置 CanvasRenderingContext2D 的字体样式
        this.ctx.font = font;
        // 设置 jsPDF context2d 的字体样式 (如果需要，jsPDF 通常会自动同步)
        this.context2dCtx.font = this.options.fontConfig.fontFamily; // 通常不需要显式设置，jsPDF 会处理

        this.ctx.direction = styles.direction === DIRECTION.RTL ? 'rtl' : 'ltr';
        this.context2dCtx.direction = styles.direction === DIRECTION.RTL ? 'rtl' : 'ltr'; // 根据 jsPDF API 调整

        this.ctx.textAlign = 'left';
        this.context2dCtx.textAlign = 'left'; // 根据 jsPDF API 调整

        // this.ctx.textBaseline = 'alphabetic';

        const fontSizePt = styles.fontSize.number;
        this.jspdfCtx.setFontSize(fontSizePt);
        // this.context2dCtx.textBaseline = 'alphabetic'; // 根据 jsPDF API 调整

        const { baseline, middle } = this.fontMetrics.getMetrics(fontFamily, fontSize);
        const paintOrder = styles.paintOrder;
        text.textBounds.forEach((textItem) => {
            paintOrder.forEach((paintOrderLayer) => {
                switch (paintOrderLayer) {
                    case PAINT_ORDER_LAYER.FILL:
                        // 设置 CanvasRenderingContext2D 的填充样式
                        // this.ctx.fillStyle = asString(styles.color);
                        // 设置 jsPDF context2d 的填充样式
                        this.context2dCtx.fillStyle = asString(styles.color);

                        this.renderTextWithLetterSpacing(textItem, styles.letterSpacing, baseline);

                        if (styles.textDecorationLine.length) {
                            // 设置 CanvasRenderingContext2D 的填充样式
                            // this.ctx.fillStyle = asString(styles.textDecorationColor || styles.color);
                            // 设置 jsPDF context2d 的填充样式
                            this.context2dCtx.fillStyle = asString(styles.textDecorationColor || styles.color);

                            styles.textDecorationLine.forEach((textDecorationLine) => {
                                const x = textItem.bounds.left;
                                const width = textItem.bounds.width;
                                const y_underline = Math.round(textItem.bounds.top + baseline);
                                const y_overline = Math.round(textItem.bounds.top);
                                const y_line_through = Math.ceil(textItem.bounds.top + middle);
                                const thickness = 1; // 装饰线的粗细，可以根据需要调整

                                switch (textDecorationLine) {
                                    case TEXT_DECORATION_LINE.UNDERLINE:
                                        // this.ctx.fillRect(x, y_underline, width, thickness);
                                        this.context2dCtx.fillRect(x, y_underline, width, thickness);
                                        break;
                                    case TEXT_DECORATION_LINE.OVERLINE:
                                        // this.ctx.fillRect(x, y_overline, width, thickness);
                                        this.context2dCtx.fillRect(x, y_overline , width, thickness);
                                        break;
                                    case TEXT_DECORATION_LINE.LINE_THROUGH:
                                        // this.ctx.fillRect(x, y_line_through, width, thickness);
                                        this.context2dCtx.fillRect(x, y_line_through , width, thickness);
                                        break;
                                }
                            });
                        }
                        break;
                    case PAINT_ORDER_LAYER.STROKE:
                        if (styles.webkitTextStrokeWidth && textItem.text.trim().length) {
                            // 设置 CanvasRenderingContext2D 的描边样式
                            // this.ctx.strokeStyle = asString(styles.webkitTextStrokeColor);
                            // this.ctx.lineWidth = styles.webkitTextStrokeWidth;
                            // this.ctx.lineJoin = !!(window as any).chrome ? 'miter' : 'round';

                            // 设置 jsPDF context2d 的描边样式
                            this.context2dCtx.strokeStyle = asString(styles.webkitTextStrokeColor);
                            this.context2dCtx.lineWidth = styles.webkitTextStrokeWidth;
                            // this.context2dCtx.lineJoin = ...; // 根据 jsPDF API 调整

                            // CanvasRenderingContext2D 描边
                            // this.ctx.strokeText(textItem.text, textItem.bounds.left, textItem.bounds.top + baseline);
                            // jsPDF context2d 描边
                            this.context2dCtx.strokeText(textItem.text, textItem.bounds.left, textItem.bounds.top + baseline);
                        }
                        // 清除 CanvasRenderingContext2D 的描边样式
                        // this.ctx.strokeStyle = '';
                        // this.ctx.lineWidth = 0;
                        // this.ctx.lineJoin = 'miter';

                        // 清除 jsPDF context2d 的描边样式
                        this.context2dCtx.strokeStyle = '';
                        this.context2dCtx.lineWidth = 0;
                        this.context2dCtx.lineJoin = 'miter';
                        break;
                }
            });
        });
    }




    renderReplacedElement(
        container: ReplacedElementContainer,
        curves: BoundCurves,
        image: HTMLImageElement | HTMLCanvasElement
    ): void {
        if (image && container.intrinsicWidth > 0 && container.intrinsicHeight > 0) {
            const box = contentBox(container);
            const path = calculatePaddingBoxPath(curves);
            this.path(path);
            this.ctx.save();
            this.ctx.clip();
            this.ctx.drawImage(
                image,
                0,
                0,
                container.intrinsicWidth,
                container.intrinsicHeight,
                box.left,
                box.top,
                box.width,
                box.height
            );
            this.ctx.restore();


            // this.context2dCtx.save();
            // this.context2dCtx.clip();
            // this.context2dCtx.drawImage(
            //     image,
            //     0,
            //     0,
            //     container.intrinsicWidth,
            //     container.intrinsicHeight,
            //     box.left,
            //     box.top,
            //     box.width,
            //     box.height
            // );
            // this.context2dCtx.restore();
        }
    }


    // 渲染节点内容
    // 渲染节点内容的异步方法
    async renderNodeContent(paint: ElementPaint): Promise<void> {
        // 应用内容效果
        this.applyEffects(paint.getEffects(EffectTarget.CONTENT));
        const container = paint.container;
        const curves = paint.curves;
        const styles = container.styles;
        // console.log('stylescontainer',styles,container)
        // if (!leftMargin) {
        //     leftMargin = container.bounds.left
        // }
        // if (!topMargin) {
        //     topMargin = container.bounds.top
        // }
        // 渲染所有文本节点
        for (const child of container.textNodes) {

            await this.renderTextNode(child, styles);
        }

        if (container instanceof ImageElementContainer) {
            try {
                const image = await this.context.cache.match(container.src);
                // 渲染到 Canvas
                this.renderReplacedElement(container, curves, image);

                // 添加到 PDF
                try {
                    // 计算图片在 PDF 中的位置和尺寸
                    const bounds = contentBox(container);
                    const x = this.pxToPt(bounds.left-this.options.x);
                    const y = this.pxToPt(bounds.top-this.options.y);
                    const width = this.pxToPt(bounds.width);
                    const height = this.pxToPt(bounds.height);

                    // 将图片添加到 PDF
                    this.jspdfCtx.addImage(
                        image,
                        'JPEG', // 默认使用 JPEG 格式
                        x,
                        y,
                        width,
                        height
                    );
                } catch (err) {
                    this.context.logger.error(`Error adding image to PDF: ${err}`);
                }
            } catch (e) {
                this.context.logger.error(`Error loading image ${container}`);
            }
        }

        if (container instanceof CanvasElementContainer) {
            // 渲染到 Canvas
            this.renderReplacedElement(container, curves, container.canvas);

            // 添加到 PDF
            try {
                // 计算 Canvas 在 PDF 中的位置和尺寸
                const bounds = contentBox(container);
                const x = this.pxToPt(bounds.left-this.options.x);
                const y = this.pxToPt(bounds.top-this.options.y);
                const width = this.pxToPt(bounds.width);
                const height = this.pxToPt(bounds.height);

                // 将 Canvas 转换为 dataURL
                const dataURL = container.canvas.toDataURL('image/png', 0.95);

                // 将 Canvas 添加到 PDF
                this.jspdfCtx.addImage(
                    dataURL,
                    'PNG',
                    x,
                    y,
                    width,
                    height
                );
            } catch (err) {
                this.context.logger.error(`Error adding canvas to PDF: ${err}`);
            }
        }

        if (container instanceof SVGElementContainer) {
            try {
                const image = await this.context.cache.match(container.svg);
                // 渲染到 Canvas
                this.renderReplacedElement(container, curves, image);

                // 添加到 PDF
                try {
                    // 计算 SVG 在 PDF 中的位置和尺寸
                    const bounds = contentBox(container);
                    const x = this.pxToPt(bounds.left-this.options.x);
                    const y = this.pxToPt(bounds.top-this.options.y);
                    const width = this.pxToPt(bounds.width);
                    const height = this.pxToPt(bounds.height);

                    // 创建临时 Canvas 来转换 SVG 为图片格式
                    const canvas = document.createElement('canvas');
                    canvas.width = container.intrinsicWidth || image.width;
                    canvas.height = container.intrinsicHeight || image.height;
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        // 设置白色背景或保持透明
                        ctx.clearRect(0, 0, canvas.width, canvas.height);

                        // 绘制SVG图像
                        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

                        // 使用PNG格式而不是JPEG，保留透明度
                        const dataURL = canvas.toDataURL('image/png');

                        // 将 SVG 添加到 PDF
                        this.jspdfCtx.addImage(
                            dataURL,
                            'PNG',
                            x,
                            y,
                            width,
                            height
                        );
                    }
                } catch (err) {
                    this.context.logger.error(`Error adding SVG to PDF: ${err}`);
                }
            } catch (e) {
                this.context.logger.error(`Error loading svg ${e}`);
            }
        }


        // 处理IFrame元素
        if (container instanceof IFrameElementContainer && container.tree) {
            const iframeRenderer = new CanvasRenderer(this.context, {
                scale: this.options.scale,
                fontConfig: this.options.fontConfig,
                backgroundColor: container.backgroundColor,
                x: 0,
                y: 0,
                width: container.width,
                height: container.height
            });

            const canvas = await iframeRenderer.render(container.tree);
            if (container.width && container.height) {
                // this.ctx.drawImage(
                //     canvas,
                //     0,
                //     0,
                //     container.width,
                //     container.height,
                //     container.bounds.left,
                //     container.bounds.top,
                //     container.bounds.width,
                //     container.bounds.height
                // );
                this.context2dCtx.drawImage(
                    canvas,
                    0,
                    0,
                    container.width,
                    container.height,
                    container.bounds.left,
                    container.bounds.top,
                    container.bounds.width,
                    container.bounds.height
                );
            }
        }

        // 处理Input元素
        if (container instanceof InputElementContainer) {
            const size = Math.min(container.bounds.width, container.bounds.height);

            // 渲染复选框
            if (container.type === CHECKBOX) {
                if (container.checked) {
                    // this.ctx.save();
                    this.context2dCtx.save();
                    this.path([
                        new Vector(container.bounds.left + size * 0.39363, container.bounds.top + size * 0.79),
                        new Vector(container.bounds.left + size * 0.16, container.bounds.top + size * 0.5549),
                        new Vector(container.bounds.left + size * 0.27347, container.bounds.top + size * 0.44071),
                        new Vector(container.bounds.left + size * 0.39694, container.bounds.top + size * 0.5649),
                        new Vector(container.bounds.left + size * 0.72983, container.bounds.top + size * 0.23),
                        new Vector(container.bounds.left + size * 0.84, container.bounds.top + size * 0.34085),
                        new Vector(container.bounds.left + size * 0.39363, container.bounds.top + size * 0.79)
                    ]);

                    // this.ctx.fillStyle = this.convertColor(INPUT_COLOR);
                    // this.ctx.fill();
                    // this.ctx.restore();
                    this.context2dCtx.fillStyle = this.convertColor(INPUT_COLOR);
                    this.context2dCtx.fill();
                    this.context2dCtx.restore();
                    if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
                        this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
                    }

                }
            }
            // 渲染单选框
            else if (container.type === RADIO) {
                if (container.checked) {
                    // this.ctx.save();
                    // this.ctx.beginPath();

                    // this.ctx.arc(
                    //     container.bounds.left + size / 2,
                    //     container.bounds.top + size / 2,
                    //     size / 4,
                    //     0,
                    //     Math.PI * 2,
                    //     true
                    // );
                    // this.ctx.fillStyle = this.convertColor(INPUT_COLOR);
                    // this.ctx.fill();
                    // this.ctx.restore();

                    this.context2dCtx.save();
                    this.context2dCtx.beginPath();
                    this.context2dCtx.arc(
                        container.bounds.left + size / 2,
                        container.bounds.top + size / 2,
                        size / 4,
                        0,
                        Math.PI * 2,
                        true
                    );
                    this.context2dCtx.fillStyle = this.convertColor(INPUT_COLOR);
                    this.context2dCtx.fill();
                    this.context2dCtx.restore();
                    // 在 restore 之后重新设置字体


                }
            }
        }

        // 处理文本输入元素
        if (isTextInputElement(container) && container.value.length) {
            const [fontFamily, fontSize] = this.createFontStyle(styles);
            const { baseline } = this.fontMetrics.getMetrics(fontFamily, fontSize);

            // this.ctx.font = fontFamily;
            // this.ctx.fillStyle = this.convertColor(styles.color);
            // this.context2dCtx.font = fontFamily;
            this.context2dCtx.fillStyle = this.convertColor(styles.color);

            // this.ctx.textBaseline = 'alphabetic';
            // this.ctx.textAlign = canvasTextAlign(container.styles.textAlign);
            this.context2dCtx.textBaseline = 'alphabetic';
            this.context2dCtx.textAlign = canvasTextAlign(container.styles.textAlign);

            const bounds = contentBox(container);

            let x = 0;

            // 根据文本对齐方式调整x坐标
            switch (container.styles.textAlign) {
                case TEXT_ALIGN.CENTER:
                    x += bounds.width / 2;
                    break;
                case TEXT_ALIGN.RIGHT:
                    x += bounds.width;
                    break;
            }

            const textBounds = bounds.add(x, 0, 0, -bounds.height / 2 + 1);

            // this.ctx.save();
            this.context2dCtx.save();
            this.path([
                new Vector(bounds.left, bounds.top),
                new Vector(bounds.left + bounds.width, bounds.top),
                new Vector(bounds.left + bounds.width, bounds.top + bounds.height),
                new Vector(bounds.left, bounds.top + bounds.height)
            ]);

            // this.ctx.clip();
            this.context2dCtx.clip();
            this.renderTextWithLetterSpacing(
                new TextBounds(container.value, textBounds),
                styles.letterSpacing,
                baseline
            );
            // this.ctx.restore();
            // this.ctx.textBaseline = 'alphabetic';
            // this.ctx.textAlign = 'left';
            this.context2dCtx.restore();
            this.context2dCtx.textBaseline = 'alphabetic';
            this.context2dCtx.textAlign = 'left';
        }

        // 处理列表项
        if (contains(container.styles.display, DISPLAY.LIST_ITEM)) {
            // 渲染列表项图标
            if (container.styles.listStyleImage !== null) {
                const img = container.styles.listStyleImage;
                if (img.type === CSSImageType.URL) {
                    let image;
                    const url = (img as CSSURLImage).url;
                    try {
                        image = await this.context.cache.match(url);
                        // this.ctx.drawImage(image, container.bounds.left - (image.width + 10), container.bounds.top);
                        this.context2dCtx.drawImage(image, container.bounds.left - (image.width + 10), container.bounds.top);

                    } catch (e) {
                        this.context.logger.error(`Error loading list-style-image ${url}`);
                    }
                }
            }
            // 渲染列表项标记
            else if (paint.listValue && container.styles.listStyleType !== LIST_STYLE_TYPE.NONE) {
                const [fontFamily] = this.createFontStyle(styles);

                // this.ctx.font = fontFamily;
                // this.ctx.fillStyle = this.convertColor(styles.color);
                this.context2dCtx.font = fontFamily;
                this.context2dCtx.fillStyle = this.convertColor(styles.color);

                // this.ctx.textBaseline = 'middle';
                // this.ctx.textAlign = 'right';
                this.context2dCtx.textBaseline = 'middle';
                this.context2dCtx.textAlign = 'right';
                const bounds = new Bounds(
                    container.bounds.left,
                    container.bounds.top + getAbsoluteValue(container.styles.paddingTop, container.bounds.width),
                    container.bounds.width,
                    computeLineHeight(styles.lineHeight, styles.fontSize.number) / 2 + 1
                );

                this.renderTextWithLetterSpacing(
                    new TextBounds(paint.listValue, bounds),
                    styles.letterSpacing,
                    computeLineHeight(styles.lineHeight, styles.fontSize.number) / 2 + 2
                );
                // this.ctx.textBaseline = 'bottom';
                // this.ctx.textAlign = 'left';
                this.context2dCtx.textBaseline = 'bottom';
                this.context2dCtx.textAlign = 'left';
            }
        }

        if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
            this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
        }
    }

    // 渲染堆叠上下文内容
    async renderStackContent(stack: StackingContext): Promise<void> {
        if (contains(stack.element.container.flags, FLAGS.DEBUG_RENDER)) {
            debugger;
        }

        // https://www.w3.org/TR/css-position-3/#painting-order
        // 1. the background and borders of the element forming the stacking context.
        await this.renderNodeBackgroundAndBorders(stack.element);
        // 2. the child stacking contexts with negative stack levels (most negative first).
        for (const child of stack.negativeZIndex) {
            await this.renderStack(child);
        }
        // 3. For all its in-flow, non-positioned, block-level descendants in tree order:
        await this.renderNodeContent(stack.element);

        for (const child of stack.nonInlineLevel) {
            await this.renderNode(child);
        }
        // 4. All non-positioned floating descendants, in tree order. For each one of these,
        // treat the element as if it created a new stacking context, but any positioned descendants and descendants
        // which actually create a new stacking context should be considered part of the parent stacking context,
        // not this new one.
        for (const child of stack.nonPositionedFloats) {
            await this.renderStack(child);
        }
        // 5. the in-flow, inline-level, non-positioned descendants, including inline tables and inline blocks.
        for (const child of stack.nonPositionedInlineLevel) {
            await this.renderStack(child);
        }
        for (const child of stack.inlineLevel) {
            await this.renderNode(child);
        }
        // 6. All positioned, opacity or transform descendants, in tree order that fall into the following categories:
        //  All positioned descendants with 'z-index: auto' or 'z-index: 0', in tree order.
        //  For those with 'z-index: auto', treat the element as if it created a new stacking context,
        //  but any positioned descendants and descendants which actually create a new stacking context should be
        //  considered part of the parent stacking context, not this new one. For those with 'z-index: 0',
        //  treat the stacking context generated atomically.
        //
        //  All opacity descendants with opacity less than 1
        //
        //  All transform descendants with transform other than none
        for (const child of stack.zeroOrAutoZIndexOrTransformedOrOpacity) {
            await this.renderStack(child);
        }
        // 7. Stacking contexts formed by positioned descendants with z-indices greater than or equal to 1 in z-index
        // order (smallest first) then tree order.
        for (const child of stack.positiveZIndex) {
            await this.renderStack(child);
        }

        // 检查是否是根堆叠上下文
        // 检查是否是根堆叠上下文

        // console.log('stack',stack)
        // if (stack.hasOwnProperty('parent') && !stack.parent) {
        //     // 如果是根堆叠上下文,说明所有内容都渲染完成,可以保存PDF
        //     this.jspdfCtx.save("a4.pdf");
        // }
    }

    // 创建遮罩
    mask(paths: Path[]): void {
        // this.ctx.beginPath();
        // this.ctx.moveTo(0, 0);
        // this.ctx.lineTo(this.canvas.width, 0);
        // this.ctx.lineTo(this.canvas.width, this.canvas.height);
        // this.ctx.lineTo(0, this.canvas.height);
        // this.ctx.lineTo(0, 0);
        // this.formatPath(paths.slice(0).reverse());
        // this.ctx.closePath();

        this.context2dCtx.beginPath();
        this.context2dCtx.moveTo(0, 0);
        this.context2dCtx.lineTo(this.options.width, 0);
        this.context2dCtx.lineTo(this.options.width, this.options.height);
        this.context2dCtx.lineTo(0, this.options.height);
        this.context2dCtx.lineTo(0, 0);
        this.formatPath(paths.slice(0).reverse());
        this.context2dCtx.closePath();
    }

    // 创建路径
    path(paths: Path[]): void {
        // this.ctx.beginPath();
        // this.formatPath(paths);
        // this.ctx.closePath();
        this.context2dCtx.beginPath();
        this.formatPath(paths);
        this.context2dCtx.closePath();

    }

    // 格式化路径
    formatPath(paths: Path[]): void {
        paths.forEach((point, index) => {
            const start: Vector = isBezierCurve(point) ? point.start : point;
            if (index === 0) {
                // this.ctx.moveTo(start.x, start.y);
                this.context2dCtx.moveTo(start.x, start.y);
            } else {
                // this.ctx.lineTo(start.x, start.y);
                this.context2dCtx.lineTo(start.x, start.y);
            }

            if (isBezierCurve(point)) {
                // this.ctx.bezierCurveTo(
                //     point.startControl.x,
                //     point.startControl.y,
                //     point.endControl.x,
                //     point.endControl.y,
                //     point.end.x,
                //     point.end.y
                // );
                this.context2dCtx.bezierCurveTo(
                    point.startControl.x ,
                    point.startControl.y ,
                    point.endControl.x ,
                    point.endControl.y ,
                    point.end.x ,
                    point.end.y
                )

            }
        });
    }

    // 渲染重复图案
    renderRepeat(path: Path[], pattern: CanvasPattern | CanvasGradient, offsetX: number, offsetY: number): void {
        this.path(path);
        this.ctx.fillStyle = pattern;
        // this.ctx.translate(offsetX, offsetY);
        // this.ctx.fill();
        // this.ctx.translate(-offsetX, -offsetY);

        //    this.context2dCtx.fillStyle =this.convertColor(pattern) ;
        this.context2dCtx.translate(offsetX, offsetY);
        this.context2dCtx.fill();
        this.context2dCtx.translate(-offsetX, -offsetY);
    }

    // 调整图片大小
    resizeImage(image: HTMLImageElement, width: number, height: number): HTMLCanvasElement | HTMLImageElement {
        if (image.width === width && image.height === height) {
            return image;
        }

        const ownerDocument = this.canvas.ownerDocument ?? document;
        const canvas = ownerDocument.createElement('canvas');
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
        ctx.drawImage(image, 0, 0, image.width, image.height, 0, 0, width, height);
        return canvas;
    }

    // 渲染背景图片
    async renderBackgroundImage(container: ElementContainer): Promise<void> {
        let index = container.styles.backgroundImage.length - 1;
        for (const backgroundImage of container.styles.backgroundImage.slice(0).reverse()) {
            if (backgroundImage.type === CSSImageType.URL) {
                let image;
                const url = (backgroundImage as CSSURLImage).url;
                try {
                    image = await this.context.cache.match(url);
                } catch (e) {
                    this.context.logger.error(`Error loading background-image ${url}`);
                }

                if (image) {
                    const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [
                        image.width,
                        image.height,
                        image.width / image.height
                    ]);
                    const pattern = this.ctx.createPattern(
                        this.resizeImage(image, width, height),
                        'repeat'
                    ) as CanvasPattern;
                    this.renderRepeat(path, pattern, x, y);

                    // PDF 背景图片渲染
                    const xPt = this.pxToPt(x-this.options.x);
                    const yPt = this.pxToPt(y-this.options.y);
                    const widthPt = this.pxToPt(width);
                    const heightPt = this.pxToPt(height);
                    // console.log('绘制背景图片', xPt, yPt, image)
                    this.jspdfCtx.addImage(
                        image,
                        'JPEG',
                        xPt,
                        yPt,
                        widthPt,
                        heightPt
                    );
                }
            } else if (isLinearGradient(backgroundImage)) {
                // const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [null, null, null]);
                // const [lineLength, x0, x1, y0, y1] = calculateGradientDirection(backgroundImage.angle, width, height);

                // const canvas = document.createElement('canvas');
                // canvas.width = width;
                // canvas.height = height;
                // const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                // const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

                // processColorStops(backgroundImage.stops, lineLength).forEach((colorStop) =>
                //     gradient.addColorStop(colorStop.stop, this.convertColor(colorStop.color))
                // );

                // ctx.fillStyle = gradient;
                // ctx.fillRect(0, 0, width, height);
                // if (width > 0 && height > 0) {
                //     const pattern = this.ctx.createPattern(canvas, 'repeat') as CanvasPattern;
                //     this.renderRepeat(path, pattern, x, y);
                // }
            } else if (isRadialGradient(backgroundImage)) {
                // const [path, left, top, width, height] = calculateBackgroundRendering(container, index, [
                //     null,
                //     null,
                //     null
                // ]);
                // const position = backgroundImage.position.length === 0 ? [FIFTY_PERCENT] : backgroundImage.position;
                // const x = getAbsoluteValue(position[0], width);
                // const y = getAbsoluteValue(position[position.length - 1], height);

                // const [rx, ry] = calculateRadius(backgroundImage, x, y, width, height);
                // if (rx > 0 && ry > 0) {
                //     const radialGradient = this.ctx.createRadialGradient(left + x, top + y, 0, left + x, top + y, rx);

                //     processColorStops(backgroundImage.stops, rx * 2).forEach((colorStop) =>
                //         radialGradient.addColorStop(colorStop.stop, this.convertColor(colorStop.color))
                //     );

                //     this.path(path);
                //     this.ctx.fillStyle = radialGradient;
                //     this.context2dCtx.fillStyle = this.convertColor(radialGradient);
                //     if (rx !== ry) {
                //         // transforms for elliptical radial gradient
                //         const midX = container.bounds.left + 0.5 * container.bounds.width;
                //         const midY = container.bounds.top + 0.5 * container.bounds.height;
                //         const f = ry / rx;
                //         const invF = 1 / f;

                //         // this.ctx.save();
                //         // this.ctx.translate(midX, midY);
                //         // this.ctx.transform(1, 0, 0, f, 0, 0);
                //         // this.ctx.translate(-midX, -midY);

                //         // this.ctx.fillRect(left, invF * (top - midY) + midY, width, height * invF);
                //         // this.ctx.restore();


                //         this.context2dCtx.save();
                //         this.context2dCtx.translate(midX, midY);
                //         this.context2dCtx.transform(1, 0, 0, f, 0, 0);
                //         this.context2dCtx.translate(-midX, -midY);

                //         this.context2dCtx.fillRect(left, invF * (top - midY) + midY, width, height * invF);
                //         this.context2dCtx.restore();
                //     } else {
                //         // this.ctx.fill();
                //         this.context2dCtx.fill()
                //     }
                // }
            }
            index--;
        }
    }


    /**
     * 渲染实线边框
     * @param color - 边框颜色
     * @param side - 边的位置(0-3,分别代表上右下左)
     * @param curvePoints - 边框曲线点
     */
    async renderSolidBorder(color: Color, side: number, curvePoints: BoundCurves): Promise<void> {
        // console.log('绘制边框')

        // 解析边框路径
        // console.log('Border curve points:', JSON.stringify(curvePoints));
        // console.log('Page height:', this.jspdf.internal.pageSize.height);
        this.path(parsePathForBorder(curvePoints, side));
        // 设置填充颜色
        // this.ctx.fillStyle = this.convertColor(color);
        this.context2dCtx.fillStyle = this.convertColor(color);

        // 填充路径
        // this.ctx.fill();
        this.jspdfCtx.fill();
        this.context2dCtx.fill()
    }

    // 渲染双线边框


    async renderDoubleBorder(color: Color, width: number, side: number, curvePoints: BoundCurves): Promise<void> {
        if (width < 3) {
            await this.renderSolidBorder(color, side, curvePoints);
            return;
        }

        const outerPaths = parsePathForBorderDoubleOuter(curvePoints, side);
        this.path(outerPaths);
        // this.ctx.fillStyle = this.convertColor(color);
        // this.ctx.fill();
        this.context2dCtx.fillStyle = this.convertColor(color);
        this.context2dCtx.fill();
        const innerPaths = parsePathForBorderDoubleInner(curvePoints, side);
        this.path(innerPaths);
        // this.ctx.fill();
        this.context2dCtx.fill();
    }

    // 渲染节点的背景和边框
    async renderNodeBackgroundAndBorders(paint: ElementPaint): Promise<void> {
        // 应用背景和边框的效果


        this.applyEffects(paint.getEffects(EffectTarget.BACKGROUND_BORDERS));
        const styles = paint.container.styles;

        // 检查是否有背景色或背景图片
        const hasBackground = !isTransparent(styles.backgroundColor) || styles.backgroundImage.length;

        // 定义四个边框的样式、颜色和宽度
        const borders = [
            { style: styles.borderTopStyle, color: styles.borderTopColor, width: styles.borderTopWidth },
            { style: styles.borderRightStyle, color: styles.borderRightColor, width: styles.borderRightWidth },
            { style: styles.borderBottomStyle, color: styles.borderBottomColor, width: styles.borderBottomWidth },
            { style: styles.borderLeftStyle, color: styles.borderLeftColor, width: styles.borderLeftWidth }
        ];

        // 计算背景的绘制区域
        const backgroundPaintingArea = calculateBackgroundCurvedPaintingArea(
            getBackgroundValueForIndex(styles.backgroundClip, 0),
            paint.curves
        );
        let foreignobjectrendering=paint.container.foreignobjectrendering
        if (hasBackground || styles.boxShadow.length) {

            // console.log(paint,foreignobjectrendering, 'paint边框')

            // 在 save 之前确保字体设置正确
            if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
                this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
            }
            if(!foreignobjectrendering){
                this.context2dCtx.save();
                this.path(backgroundPaintingArea);
                this.context2dCtx.clip();
                // this.ctx.save();
                // this.path(backgroundPaintingArea);
                // this.ctx.clip();

                if (!isTransparent(styles.backgroundColor)) {
                    // this.ctx.fillStyle = asString(styles.backgroundColor);
                    // this.ctx.fill();
                    this.context2dCtx.fillStyle = this.convertColor(styles.backgroundColor);
                    this.context2dCtx.fill();
                }
            }


            await this.renderBackgroundImage(paint.container);

            // this.ctx.restore();
            this.context2dCtx.restore();

            // 在 restore 之后重新设置字体
            if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
                this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
            }

        }
// console.log('绘制边框',paint.container)
        // if(!true){
        let side = 0;
        for (const border of borders) {
            if (border.style !== BORDER_STYLE.NONE && !isTransparent(border.color) && border.width > 0) {
                if (border.style === BORDER_STYLE.DASHED) {
                    await this.renderDashedDottedBorder(
                        border.color,
                        border.width,
                        side,
                        paint.curves,
                        BORDER_STYLE.DASHED
                    );
                } else if (border.style === BORDER_STYLE.DOTTED) {
                    await this.renderDashedDottedBorder(
                        border.color,
                        border.width,
                        side,
                        paint.curves,
                        BORDER_STYLE.DOTTED
                    );
                } else if (border.style === BORDER_STYLE.DOUBLE) {
                    await this.renderDoubleBorder(border.color, border.width, side, paint.curves);
                } else {
                    if (!foreignobjectrendering ) {

                        await this.renderSolidBorder(border.color, side, paint.curves);

                    }
                }
            }
            side++;
        }

    // }
    }




    // 这个方法用于渲染虚线和点线边框
    async renderDashedDottedBorder(
        color: Color,          // 边框颜色
        width: number,         // 边框宽度
        side: number,          // 边的位置(0-3,分别代表上右下左)
        curvePoints: BoundCurves,  // 边框曲线点
        style: BORDER_STYLE    // 边框样式(DASHED或DOTTED)
    ): Promise<void> {
        // this.ctx.save();  // 保存当前画布状态
        // this.jspdfCtx.saveGraphicsState(); // 保存PDF绘图状态
          this.context2dCtx.save()

        // 获取边框的路径信息
        const strokePaths = parsePathForBorderStroke(curvePoints, side);
        const boxPaths = parsePathForBorder(curvePoints, side);

        // 如果是虚线边框,需要先裁剪路径
        if (style === BORDER_STYLE.DASHED) {
            this.path(boxPaths);
            // this.ctx.clip();
            // // PDF裁剪路径
            // this.jspdfCtx.clip();
            this.context2dCtx.clip()
        }

        // 获取边框起点和终点坐标
        let startX, startY, endX, endY;
        if (isBezierCurve(boxPaths[0])) {
            startX = (boxPaths[0] as BezierCurve).start.x;
            startY = (boxPaths[0] as BezierCurve).start.y;
        } else {
            startX = (boxPaths[0] as Vector).x;
            startY = (boxPaths[0] as Vector).y;
        }
        if (isBezierCurve(boxPaths[1])) {
            endX = (boxPaths[1] as BezierCurve).end.x;
            endY = (boxPaths[1] as BezierCurve).end.y;
        } else {
            endX = (boxPaths[1] as Vector).x;
            endY = (boxPaths[1] as Vector).y;
        }

        // 计算边框长度
        let length;
        if (side === 0 || side === 2) {
            length = Math.abs(startX - endX);
        } else {
            length = Math.abs(startY - endY);
        }

        // 开始绘制路径
        // this.ctx.beginPath();

        this.context2dCtx.beginPath()
        this.jspdfCtx.setDrawColor(this.convertColor(color)); // 设置PDF绘制颜色

        if (style === BORDER_STYLE.DOTTED) {
            this.formatPath(strokePaths);
        } else {
            this.formatPath(boxPaths.slice(0, 2));
        }

        // 计算虚线或点线的间距
        let dashLength = width < 3 ? width * 3 : width * 2;
        let spaceLength = width < 3 ? width * 2 : width;
        if (style === BORDER_STYLE.DOTTED) {
            dashLength = width;
            spaceLength = width;
        }

        // 根据边框长度调整虚线样式
        let useLineDash = true;
        if (length <= dashLength * 2) {
            useLineDash = false;
        } else if (length <= dashLength * 2 + spaceLength) {
            const multiplier = length / (2 * dashLength + spaceLength);
            dashLength *= multiplier;
            spaceLength *= multiplier;
        } else {
            const numberOfDashes = Math.floor((length + spaceLength) / (dashLength + spaceLength));
            const minSpace = (length - numberOfDashes * dashLength) / (numberOfDashes - 1);
            const maxSpace = (length - (numberOfDashes + 1) * dashLength) / numberOfDashes;
            spaceLength =
                maxSpace <= 0 || Math.abs(spaceLength - minSpace) < Math.abs(spaceLength - maxSpace)
                    ? minSpace
                    : maxSpace;
        }

        // 设置虚线样式
        if (useLineDash) {
            if (style === BORDER_STYLE.DOTTED) {
                // this.ctx.setLineDash([0, dashLength + spaceLength]);
                this.jspdfCtx.setLineDashPattern([0, dashLength + spaceLength], 0); // PDF虚线样式
            } else {
                // this.ctx.setLineDash([dashLength, spaceLength]);
                this.jspdfCtx.setLineDashPattern([dashLength, spaceLength], 0); // PDF虚线样式
            }
        }

        // 设置线条样式并绘制
        if (style === BORDER_STYLE.DOTTED) {
            // this.ctx.lineCap = 'round';
            // this.ctx.lineWidth = width;
            this.jspdfCtx.setLineCap('round'); // PDF线帽样式
            this.jspdfCtx.setLineWidth(width);
        } else {
            // this.ctx.lineWidth = width * 2 + 1.1;
            this.jspdfCtx.setLineWidth(width * 2 + 1.1);
        }
        // this.ctx.strokeStyle = this.convertColor(color);
        // this.ctx.stroke();
        this.jspdfCtx.stroke(); // PDF绘制线条
        // this.ctx.setLineDash([]);
        this.jspdfCtx.setLineDashPattern([], 0); // 重置PDF虚线样式

        // 处理虚线边框的圆角连接处
        if (style === BORDER_STYLE.DASHED) {
            if (isBezierCurve(boxPaths[0])) {
                const path1 = boxPaths[3] as BezierCurve;
                const path2 = boxPaths[0] as BezierCurve;

                // 确保所有坐标都转换为 pt 单位
                const x1 = this.pxToPt(path1.end.x);
                const y1 = this.pxToPt(path1.end.y);
                const x2 = this.pxToPt(path2.start.x);
                const y2 = this.pxToPt(path2.start.y);

                try {
                    this.jspdfCtx.line(x1, y1, x2, y2);
                    this.jspdfCtx.stroke();
                } catch (error) {
                    console.warn('Failed to draw dashed border:', error);
                }
            }
            if (isBezierCurve(boxPaths[1])) {
                const path1 = boxPaths[1] as BezierCurve;
                const path2 = boxPaths[2] as BezierCurve;
                // this.ctx.beginPath();
                // this.formatPath([new Vector(path1.end.x, path1.end.y), new Vector(path2.start.x, path2.start.y)]);
                // this.ctx.stroke();
                this.jspdfCtx.lines([[path1.end.x, path1.end.y, path2.start.x, path2.start.y]], path1.end.x, path1.end.y); // PDF绘制连接线
                this.jspdfCtx.stroke();
            }
        }

        // this.ctx.restore(); // 恢复画布状态
        this.jspdfCtx.restoreGraphicsState(); // 恢复PDF绘图状态
    }

    async render(element: ElementContainer): Promise<HTMLCanvasElement> {
        if (this.options.backgroundColor) {
            // this.ctx.fillStyle = this.convertColor(this.options.backgroundColor);
            // this.ctx.fillRect(this.options.x, this.options.y, this.options.width, this.options.height);
            this.jspdfCtx.setFillColor(this.convertColor(this.options.backgroundColor)); // PDF填充背景颜色
            this.jspdfCtx.rect(this.options.x, this.options.y, this.options.width, this.options.height, 'F'); // PDF绘制矩形
        }

        const stack = parseStackingContexts(element);

        await this.renderStack(stack);
        this.applyEffects([]);

        // 使用配置的文件名或默认名称
        // const fileName = this.options.pdfFileName || 'output.pdf';
        // this.jspdfCtx.save(fileName);
        const pdfBlob = this.jspdfCtx.output('blob');
        return pdfBlob;
        // return this.canvas;
    }
}

const isTextInputElement = (
    container: ElementContainer
): container is InputElementContainer | TextareaElementContainer | SelectElementContainer => {
    if (container instanceof TextareaElementContainer) {
        return true;
    } else if (container instanceof SelectElementContainer) {
        return true;
    } else if (container instanceof InputElementContainer && container.type !== RADIO && container.type !== CHECKBOX) {
        return true;
    }
    return false;
};

const calculateBackgroundCurvedPaintingArea = (clip: BACKGROUND_CLIP, curves: BoundCurves): Path[] => {
    switch (clip) {
        case BACKGROUND_CLIP.BORDER_BOX:
            return calculateBorderBoxPath(curves);
        case BACKGROUND_CLIP.CONTENT_BOX:
            return calculateContentBoxPath(curves);
        case BACKGROUND_CLIP.PADDING_BOX:
        default:
            return calculatePaddingBoxPath(curves);
    }
};

const canvasTextAlign = (textAlign: TEXT_ALIGN): CanvasTextAlign => {
    switch (textAlign) {
        case TEXT_ALIGN.CENTER:
            return 'center';
        case TEXT_ALIGN.RIGHT:
            return 'right';
        case TEXT_ALIGN.LEFT:
        default:
            return 'left';
    }
};

// see https://github.com/niklasvh/html2canvas/pull/2645
const iOSBrokenFonts = ['-apple-system', 'system-ui'];

const fixIOSSystemFonts = (fontFamilies: string[]): string[] => {
    return /iPhone OS 15_(0|1)/.test(window.navigator.userAgent)
        ? fontFamilies.filter((fontFamily) => iOSBrokenFonts.indexOf(fontFamily) === -1)
        : fontFamilies;
};
