import {Context2d, EncryptionOptions, jsPDF} from 'jspdf';
import 'jspdf/dist/polyfills.es.js';
import {contains} from '../../core/bitwise';
import {Context} from '../../core/context';
import {CSSParsedDeclaration} from '../../css';
import {Bounds} from '../../css/layout/bounds';
import {segmentGraphemes, TextBounds} from '../../css/layout/text';
import {BACKGROUND_CLIP} from '../../css/property-descriptors/background-clip';
import {BACKGROUND_REPEAT} from '../../css/property-descriptors/background-repeat';
import {BORDER_STYLE} from '../../css/property-descriptors/border-style';
import {DISPLAY} from '../../css/property-descriptors/display';
import {computeLineHeight} from '../../css/property-descriptors/line-height';
import {LIST_STYLE_TYPE} from '../../css/property-descriptors/list-style-type';
import {PAINT_ORDER_LAYER} from '../../css/property-descriptors/paint-order';
import {TEXT_ALIGN} from '../../css/property-descriptors/text-align';
import {TEXT_DECORATION_LINE} from '../../css/property-descriptors/text-decoration-line';
import {isDimensionToken} from '../../css/syntax/parser';
import {asString, Color, isTransparent} from '../../css/types/color';
import {calculateGradientDirection, calculateRadius, processColorStops} from '../../css/types/functions/gradient';
import {CSSImageType, CSSURLImage, isLinearGradient, isRadialGradient} from '../../css/types/image';
import {FIFTY_PERCENT, getAbsoluteValue} from '../../css/types/length-percentage';
import {ElementContainer, FLAGS} from '../../dom/element-container';
import {SelectElementContainer} from '../../dom/elements/select-element-container';
import {TextareaElementContainer} from '../../dom/elements/textarea-element-container';
// import {ReplacedElementContainer} from '../../dom/replaced-elements';
import {CanvasElementContainer} from '../../dom/replaced-elements/canvas-element-container';
import {IFrameElementContainer} from '../../dom/replaced-elements/iframe-element-container';
import {ImageElementContainer} from '../../dom/replaced-elements/image-element-container';
import {CHECKBOX, INPUT_COLOR, InputElementContainer, RADIO} from '../../dom/replaced-elements/input-element-container';
import {SVGElementContainer} from '../../dom/replaced-elements/svg-element-container';
import {TextContainer} from '../../dom/text-container';

import {calculateBackgroundRendering, getBackgroundValueForIndex} from '../background';
import {BezierCurve, isBezierCurve} from '../bezier-curve';
import {
    parsePathForBorder,
    parsePathForBorderDoubleInner,
    parsePathForBorderDoubleOuter,
    parsePathForBorderStroke
} from '../border';
import {BoundCurves, calculateBorderBoxPath, calculateContentBoxPath, calculatePaddingBoxPath} from '../bound-curves';
import {contentBox} from '../box-sizing';
import {EffectTarget, IElementEffect, isClipEffect, isOpacityEffect, isTransformEffect} from '../effects';
import {FontMetrics} from '../font-metrics';
// transformPath
import {FontConfig, getBackgroundRepeat, getImageTypeByPath, isArray, isEmptyValue, isObject} from '../../utils';
import {Path, transformPath} from '../path';
import {Renderer} from '../renderer';
import {ElementPaint, parseStackingContexts, StackingContext} from '../stacking-context';
import {Vector} from '../vector';

export type RenderConfigurations = RenderOptions & {
    backgroundColor: Color | null;
    fontConfig: FontConfig | FontConfig[] | undefined;
};

export type pageConfigOptions = {
    header: {
        content: string;
        height: number;
        contentPosition:
            | 'center'
            | 'centerLeft'
            | 'centerRight'
            | 'centerTop'
            | 'centerBottom'
            | 'leftTop'
            | 'leftBottom'
            | 'rightTop'
            | 'rightBottom'
            | [number, number];
        contentColor: string;
        contentFontSize: number;
        padding?: [number, number, number, number];
    };
    footer: {
        content: string;
        height: number;
        contentPosition:
            | 'center'
            | 'centerLeft'
            | 'centerRight'
            | 'centerTop'
            | 'centerBottom'
            | 'leftTop'
            | 'leftBottom'
            | 'rightTop'
            | 'rightBottom'
            | [number, number];
        contentColor: string;
        contentFontSize: number;
        padding?: [number, number, number, number];
    };
};

export interface RenderOptions {
    scale: number;
    canvas?: HTMLCanvasElement;
    x: number;
    y: number;
    width: number;
    height: number;
    pdfFileName?: string;
    encryption?: EncryptionOptions | undefined;
    precision?: number;
    floatPrecision?: number | 'smart';
    compress?: boolean;
    putOnlyUsedFonts?: boolean;
    pagination?: boolean;
    format?:
        | 'a0'
        | 'a1'
        | 'a2'
        | 'a3'
        | 'a4'
        | 'a5'
        | 'a6'
        | 'a7'
        | 'a8'
        | 'a9'
        | 'a10'
        | 'b0'
        | 'b1'
        | 'b2'
        | 'b3'
        | 'b4'
        | 'b5'
        | 'b6'
        | 'b7'
        | 'b8'
        | 'b9'
        | 'b10'
        | 'c0'
        | 'c1'
        | 'c2'
        | 'c3'
        | 'c4'
        | 'c5'
        | 'c6'
        | 'c7'
        | 'c8'
        | 'c9'
        | 'c10'
        | 'dl'
        | 'letter'
        | 'government-letter'
        | 'legal'
        | 'junior-legal'
        | 'ledger'
        | 'tabloid'
        | 'credit-card'
        | [number, number];
    pageConfig?: pageConfigOptions;
}

export class JsPdfContext2d {}
export interface JsPdfContext2d extends Context2d {
    getLineDash(): number[];
    setLineDash(segments: number[]): void;
}

export class CanvasRenderer extends Renderer {
    canvas: HTMLCanvasElement;
    // ctx: CanvasRenderingContext2D;
    readonly jspdfCtx: jsPDF;
    readonly context2dCtx: JsPdfContext2d;
    private readonly _activeEffects: IElementEffect[] = [];
    private readonly fontMetrics: FontMetrics;
    private readonly pxToPt: (px: number) => number;
    private totalPages = 1;

    constructor(context: Context, options: RenderConfigurations) {
        super(context, options);
        this.canvas = options.canvas ? options.canvas : document.createElement('canvas');
        // this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;

        this.pxToPt = (px: number) => px * (72 / 96);
        const pageWidth = this.pxToPt(options.width);
        const pageHeight = this.pxToPt(options.height);
        // 如果 format 是数组，则将 px 转换为 pt
        const format = Array.isArray(options.format) ? options.format.map((v) => this.pxToPt(v)) : options.format;

        this.jspdfCtx = new jsPDF({
            // orientation: pageWidth > pageHeight ? 'landscape' : 'landscape',
            unit: 'pt',
            format: options.pagination && format ? format : [pageHeight, pageWidth],
            hotfixes: ['px_scaling'],
            putOnlyUsedFonts: options.putOnlyUsedFonts,
            compress: options.compress,
            precision: options.precision,
            floatPrecision: options.floatPrecision,
            encryption: options.encryption
        });
        this.context2dCtx = this.jspdfCtx.context2d as JsPdfContext2d;
        this.context2dCtx.scale(0.75, 0.75);

        this.context2dCtx.translate(-options.x, -options.y);

        if (options.fontConfig) {
            try {
                this.addFontToJsPDF();
            } catch (error) {
                console.warn('Failed to set font:', error);
                this.jspdfCtx.setFont('Helvetica');
            }
        }

        if (!options.canvas) {
            this.canvas.width = 10;
            this.canvas.height = 10;
            this.canvas.style.width = `10px`;
            this.canvas.style.height = `10px`;
        }

        this.fontMetrics = new FontMetrics(document);
        this.context2dCtx.textBaseline = 'bottom';
        this._activeEffects = [];

        this.context.logger.debug(
            `Canvas renderer initialized (${options.width}x${options.height}) with scale ${options.scale}`
        );
    }

    addFontToJsPDF(): void {
        if (isEmptyValue(this.options.fontConfig as FontConfig)) {
            return;
        }
        const fonts = isObject(this.options.fontConfig)
            ? [this.options.fontConfig as FontConfig]
            : (this.options.fontConfig as FontConfig[]);
        fonts.forEach((v) => {
            this.jspdfCtx.addFileToVFS(`${v.fontFamily}.ttf`, v.fontBase64);
            this.jspdfCtx.addFont(`${v.fontFamily}.ttf`, v.fontFamily, 'normal');
            this.jspdfCtx.setFont(v.fontFamily);
        });
        // console.log('render getFont', this.jspdfCtx.getFont());
        this.context.logger.debug(`setFont renderer initialized`);
    }

    // reset all font
    resetJsPDFFont(): void {
        // if fontConfig is a single FontConfig object
        if (
            isObject(this.options.fontConfig) &&
            this.options.fontConfig &&
            (this.options.fontConfig as FontConfig).fontFamily
        ) {
            this.jspdfCtx.setFont((this.options.fontConfig as FontConfig).fontFamily);
        } else if (isArray(this.options.fontConfig) && !isEmptyValue(this.options.fontConfig)) {
            (this.options.fontConfig as FontConfig[]).forEach((v) => {
                v.fontFamily && this.jspdfCtx.setFont(v.fontFamily);
            });
        }
    }
    // setFont form options
    setTextFont(styles: CSSParsedDeclaration): string {
        // console.log(styles.fontWeight, styles.fontStyle, 'styles');
        if (isEmptyValue(this.options.fontConfig)) {
            return '';
        }
        if ((this.options.fontConfig as FontConfig[]).length === 1) {
            const fontFamilyCustom = (this.options.fontConfig as FontConfig[])[0].fontFamily ?? '';
            fontFamilyCustom && this.jspdfCtx.setFont(fontFamilyCustom);
            return fontFamilyCustom;
        }
        const fontFamilyCustom =
            (this.options.fontConfig as FontConfig[]).find(
                (v) => v.fontWeight === (styles.fontWeight > 500 ? 700 : 400) && v.fontStyle === styles.fontStyle
            )?.fontFamily ?? '';
        fontFamilyCustom && this.jspdfCtx.setFont(fontFamilyCustom);
        return fontFamilyCustom;
    }

    applyEffects(effects: IElementEffect[]): void {
        while (this._activeEffects.length) {
            this.popEffect();
        }

        effects.forEach((effect) => this.applyEffect(effect));
    }

    applyEffect(effect: IElementEffect): void {
        this.context2dCtx.save();
        if (isOpacityEffect(effect)) {
            this.context2dCtx.globalAlpha = effect.opacity;
        }

        if (isTransformEffect(effect)) {
            this.context2dCtx.translate(effect.offsetX, effect.offsetY);
            this.context2dCtx.transform(
                effect.matrix[0],
                effect.matrix[1],
                effect.matrix[2],
                effect.matrix[3],
                effect.matrix[4],
                effect.matrix[5]
            );
            this.context2dCtx.translate(-effect.offsetX, -effect.offsetY);
        }

        if (isClipEffect(effect)) {
            this.path(effect.path);
            this.context2dCtx.clip();
        }

        this._activeEffects.push(effect);
    }

    popEffect(): void {
        this._activeEffects.pop();
        this.context2dCtx.restore();
        this.resetJsPDFFont();
    }

    async renderStack(stack: StackingContext): Promise<void> {
        const styles = stack.element.container.styles;
        if (styles.isVisible()) {
            await this.renderStackContent(stack);
        }
    }

    async renderNode(paint: ElementPaint): Promise<void> {
        if (contains(paint.container.flags, FLAGS.DEBUG_RENDER)) {
            debugger;
        }

        if (paint.container.styles.isVisible()) {
            await this.renderNodeBackgroundAndBorders(paint);
            await this.renderNodeContent(paint);
        }
    }

    renderTextWithLetterSpacing(text: TextBounds, letterSpacing: number, baseline: number): void {
        if (letterSpacing === 0) {
            this.context2dCtx.fillText(text.text, text.bounds.left, text.bounds.top + baseline);
        } else {
            const letters = segmentGraphemes(text.text);
            letters.reduce((left, letter) => {
                this.context2dCtx.fillText(letter, left, text.bounds.top + baseline);
                return left + this.context2dCtx.measureText(letter);
                // return left + this.context2dCtx.measureText(letter).width;
            }, text.bounds.left);
        }
    }

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

    private convertColor(color: Color): string {
        if (isTransparent(color)) {
            return '#FFFFFF';
        }

        const r = 0xff & (color >> 24);
        const g = 0xff & (color >> 16);
        const b = 0xff & (color >> 8);
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b
            .toString(16)
            .padStart(2, '0')}`;

        // return asString(color);
    }

    async renderTextNode(text: TextContainer, styles: CSSParsedDeclaration): Promise<void> {
        const [font, fontFamily, fontSize] = this.createFontStyle(styles);
        const fontFamilyFinal = this.setTextFont(styles);
        this.context2dCtx.font = fontFamilyFinal || font;
        // console.log(fontFamilyFinal, styles, 'render getFont', this.jspdfCtx.getFont());
        // jspdf context2d not supported ‘direction’
        // this.context2dCtx.direction = styles.direction === DIRECTION.RTL ? 'rtl' : 'ltr';

        this.context2dCtx.textAlign = 'left';

        const fontSizePt = styles.fontSize.number;
        this.jspdfCtx.setFontSize(fontSizePt);

        const {baseline, middle} = this.fontMetrics.getMetrics(fontFamily, fontSize);
        const paintOrder = styles.paintOrder;
        text.textBounds.forEach((textItem) => {
            paintOrder.forEach((paintOrderLayer) => {
                switch (paintOrderLayer) {
                    case PAINT_ORDER_LAYER.FILL:
                        this.context2dCtx.fillStyle = asString(styles.color);

                        this.renderTextWithLetterSpacing(textItem, styles.letterSpacing, baseline);

                        if (styles.textDecorationLine.length) {
                            this.context2dCtx.fillStyle = asString(styles.textDecorationColor || styles.color);

                            styles.textDecorationLine.forEach((textDecorationLine) => {
                                const x = textItem.bounds.left;
                                const width = textItem.bounds.width;
                                const y_underline = Math.round(textItem.bounds.top + baseline);
                                const y_overline = Math.round(textItem.bounds.top);
                                const y_line_through = Math.ceil(textItem.bounds.top + middle);
                                const thickness = 1;

                                switch (textDecorationLine) {
                                    case TEXT_DECORATION_LINE.UNDERLINE:
                                        this.context2dCtx.fillRect(x, y_underline, width, thickness);
                                        break;
                                    case TEXT_DECORATION_LINE.OVERLINE:
                                        this.context2dCtx.fillRect(x, y_overline, width, thickness);
                                        break;
                                    case TEXT_DECORATION_LINE.LINE_THROUGH:
                                        this.context2dCtx.fillRect(x, y_line_through, width, thickness);
                                        break;
                                }
                            });
                        }
                        break;
                    case PAINT_ORDER_LAYER.STROKE:
                        if (styles.webkitTextStrokeWidth && textItem.text.trim().length) {
                            this.context2dCtx.strokeStyle = asString(styles.webkitTextStrokeColor);
                            this.context2dCtx.lineWidth = styles.webkitTextStrokeWidth;

                            this.context2dCtx.strokeText(
                                textItem.text,
                                textItem.bounds.left,
                                textItem.bounds.top + baseline
                            );
                        }
                        this.context2dCtx.strokeStyle = '';
                        this.context2dCtx.lineWidth = 0;
                        this.context2dCtx.lineJoin = 'miter';
                        break;
                }
            });
        });
    }

    renderReplacedJsPdfImage(container: ImageElementContainer, image: HTMLImageElement | HTMLCanvasElement): void {
        const bounds = contentBox(container);
        const x = this.pxToPt(bounds.left - this.options.x);
        const y = this.pxToPt(bounds.top - this.options.y);
        const width = this.pxToPt(bounds.width);
        const height = this.pxToPt(bounds.height);
        // fix: url is svg image export
        if (getImageTypeByPath(container.src, 'svg')) {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, width, height);
                ctx.drawImage(image, 0, 0, width, height);
                const dataURL = canvas.toDataURL('image/png', 0.8);
                this.addImagePdf(dataURL, 'PNG', x, y, width, height);
            }
        } else {
            this.addImagePdf(image, 'JPEG', x, y, width, height);
        }
    }
    renderReplacedJsPdfSvg(container: SVGElementContainer, image: HTMLImageElement | HTMLCanvasElement): void {
        const bounds = contentBox(container);
        const x = this.pxToPt(bounds.left - this.options.x);
        const y = this.pxToPt(bounds.top - this.options.y);
        const width = this.pxToPt(bounds.width);
        const height = this.pxToPt(bounds.height);

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(image, 0, 0, width, height);
            const dataURL = canvas.toDataURL('image/png', 0.8);
            this.addImagePdf(dataURL, 'PNG', x, y, width, height);
        }
    }
    renderReplacedJsPdfCanvasImage(container: CanvasElementContainer): void {
        const bounds = contentBox(container);
        const x = this.pxToPt(bounds.left - this.options.x);
        const y = this.pxToPt(bounds.top - this.options.y);
        const width = this.pxToPt(bounds.width);
        const height = this.pxToPt(bounds.height);
        const dataURL = container.canvas.toDataURL('image/png', 0.8);
        this.addImagePdf(dataURL, 'PNG', x, y, width, height);
    }

    async renderNodeContent(paint: ElementPaint): Promise<void> {
        this.applyEffects(paint.getEffects(EffectTarget.CONTENT));
        const container = paint.container;
        // const curves = paint.curves;
        const styles = container.styles;
        this.resetJsPDFFont();

        for (const child of container.textNodes) {
            await this.renderTextNode(child, styles);
        }

        if (container instanceof ImageElementContainer) {
            try {
                const image = await this.context.cache.match(container.src);
                this.renderReplacedJsPdfImage(container, image);
            } catch (e) {
                this.context.logger.error(`Error loading image ${container}`);
            }
        }

        if (container instanceof CanvasElementContainer) {
            try {
                this.renderReplacedJsPdfCanvasImage(container);
            } catch (err) {
                this.context.logger.error(`Error adding canvas to PDF: ${err}`);
            }
        }

        if (container instanceof SVGElementContainer) {
            try {
                const image = await this.context.cache.match(container.svg);
                this.renderReplacedJsPdfSvg(container, image);
            } catch (e) {
                this.context.logger.error(`Error loading svg ${e}`);
            }
        }

        if (container instanceof IFrameElementContainer && container.tree) {
        }

        if (container instanceof InputElementContainer) {
            const size = Math.min(container.bounds.width, container.bounds.height);

            if (container.type === CHECKBOX) {
                if (container.checked) {
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

                    this.context2dCtx.fillStyle = this.convertColor(INPUT_COLOR);
                    this.context2dCtx.fill();
                    this.context2dCtx.restore();
                }
            } else if (container.type === RADIO) {
                if (container.checked) {
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
                }
            }
        }

        if (isTextInputElement(container) && container.value.length) {
            const [fontFamily, fontSize] = this.createFontStyle(styles);
            const {baseline} = this.fontMetrics.getMetrics(fontFamily, fontSize);

            this.context2dCtx.fillStyle = this.convertColor(styles.color);

            this.context2dCtx.textBaseline = 'alphabetic';
            this.context2dCtx.textAlign = canvasTextAlign(container.styles.textAlign);

            const bounds = contentBox(container);

            let x = 0;

            switch (container.styles.textAlign) {
                case TEXT_ALIGN.CENTER:
                    x += bounds.width / 2;
                    break;
                case TEXT_ALIGN.RIGHT:
                    x += bounds.width;
                    break;
            }

            const textBounds = bounds.add(x, 0, 0, -bounds.height / 2 + 1);

            this.context2dCtx.save();
            this.path([
                new Vector(bounds.left, bounds.top),
                new Vector(bounds.left + bounds.width, bounds.top),
                new Vector(bounds.left + bounds.width, bounds.top + bounds.height),
                new Vector(bounds.left, bounds.top + bounds.height)
            ]);

            this.context2dCtx.clip();
            this.renderTextWithLetterSpacing(
                new TextBounds(container.value, textBounds),
                styles.letterSpacing,
                baseline
            );
            this.context2dCtx.restore();
            this.context2dCtx.textBaseline = 'alphabetic';
            this.context2dCtx.textAlign = 'left';
        }

        if (contains(container.styles.display, DISPLAY.LIST_ITEM)) {
            if (container.styles.listStyleImage !== null) {
                const img = container.styles.listStyleImage;
                if (img.type === CSSImageType.URL) {
                    let image;
                    const url = (img as CSSURLImage).url;
                    try {
                        image = await this.context.cache.match(url);
                        const iconWidth = image.width as number;
                        const iconHeight = image.height as number;
                        this.context2dCtx.drawImage(
                            image,
                            container.bounds.left - (image.width + 10),
                            container.bounds.top,
                            iconWidth,
                            iconHeight
                        );
                    } catch (e) {
                        this.context.logger.error(`Error loading list-style-image ${url}`);
                    }
                }
            } else if (paint.listValue && container.styles.listStyleType !== LIST_STYLE_TYPE.NONE) {
                const [fontFamily] = this.createFontStyle(styles);

                this.context2dCtx.font = fontFamily;
                this.context2dCtx.fillStyle = this.convertColor(styles.color);

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
                this.context2dCtx.textBaseline = 'bottom';
                this.context2dCtx.textAlign = 'left';
            }
        }
    }

    async renderStackContent(stack: StackingContext): Promise<void> {
        if (contains(stack.element.container.flags, FLAGS.DEBUG_RENDER)) {
            debugger;
        }

        await this.renderNodeBackgroundAndBorders(stack.element);
        for (const child of stack.negativeZIndex) {
            await this.renderStack(child);
        }
        await this.renderNodeContent(stack.element);

        for (const child of stack.nonInlineLevel) {
            await this.renderNode(child);
        }
        for (const child of stack.nonPositionedFloats) {
            await this.renderStack(child);
        }
        for (const child of stack.nonPositionedInlineLevel) {
            await this.renderStack(child);
        }
        for (const child of stack.inlineLevel) {
            await this.renderNode(child);
        }
        for (const child of stack.zeroOrAutoZIndexOrTransformedOrOpacity) {
            await this.renderStack(child);
        }
        for (const child of stack.positiveZIndex) {
            await this.renderStack(child);
        }
    }

    mask(paths: Path[]): void {
        this.context2dCtx.beginPath();
        this.context2dCtx.moveTo(0, 0);
        this.context2dCtx.lineTo(this.options.width, 0);
        this.context2dCtx.lineTo(this.options.width, this.options.height);
        this.context2dCtx.lineTo(0, this.options.height);
        this.context2dCtx.lineTo(0, 0);
        this.formatPath(paths.slice(0).reverse());
        this.context2dCtx.closePath();
    }

    path(paths: Path[], ctx2d?: Context2d | CanvasRenderingContext2D): void {
        const contextCtx = ctx2d ? ctx2d : this.context2dCtx;
        contextCtx.beginPath();
        this.formatPath(paths, contextCtx);
        contextCtx.closePath();
    }

    formatPath(paths: Path[], ctx2d?: Context2d | CanvasRenderingContext2D): void {
        const contextCtx = ctx2d ? ctx2d : this.context2dCtx;
        paths.forEach((point, index) => {
            const start: Vector = isBezierCurve(point) ? point.start : point;
            if (index === 0) {
                contextCtx.moveTo(start.x, start.y);
            } else {
                contextCtx.lineTo(start.x, start.y);
            }

            if (isBezierCurve(point)) {
                contextCtx.bezierCurveTo(
                    point.startControl.x,
                    point.startControl.y,
                    point.endControl.x,
                    point.endControl.y,
                    point.end.x,
                    point.end.y
                );
            }
        });
    }

    renderRepeat(
        boxs: Bounds,
        ctx: CanvasRenderingContext2D,
        path: Path[],
        pattern: CanvasPattern | CanvasGradient
    ): void {
        // renderRepeat(boxs: Bounds, ctx: CanvasRenderingContext2D, path: Path[], pattern: CanvasPattern | CanvasGradient, offsetX: number, offsetY: number): void {
        const contextCtx = ctx;
        this.path(path, contextCtx);
        contextCtx.fillStyle = pattern;
        contextCtx.translate(0, 0);
        // contextCtx.fill();
        contextCtx.fillRect(0, 0, boxs.width, boxs.height); // 绘制填充矩形（此时坐标系已偏移）
        contextCtx.translate(-0, -0);
    }

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

    async renderBackgroundImage(container: ElementContainer): Promise<void> {
        let index = container.styles.backgroundImage.length - 1;
        for (const backgroundImage of container.styles.backgroundImage.slice(0).reverse()) {
            // fix: background img render support gradient image-repeat
            if (backgroundImage.type === CSSImageType.URL) {
                let image;
                const url = (backgroundImage as CSSURLImage).url;
                try {
                    image = await this.context.cache.match(url);
                    if (image) {
                        const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [
                            image.width,
                            image.height,
                            image.width / image.height
                        ]);
                        const boxs = contentBox(container);
                        const ownerDocument = this.canvas.ownerDocument ?? document;
                        const canvas = ownerDocument.createElement('canvas');
                        canvas.width = Math.max(1, boxs.width);
                        canvas.height = Math.max(1, boxs.height);
                        const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                        ctx.save();
                        const repeatStr = getBackgroundRepeat(container.styles.backgroundRepeat[0]);
                        if (container.styles.backgroundRepeat[0] === BACKGROUND_REPEAT.NO_REPEAT) {
                            const xPt = this.pxToPt(x - this.options.x);
                            const yPt = this.pxToPt(y - this.options.y);
                            const widthPt = this.pxToPt(width);
                            const heightPt = this.pxToPt(height);
                            this.addImagePdf(image, 'JPEG', xPt, yPt, widthPt, heightPt);
                        } else {
                            const resizeImg = this.resizeImage(image, width, height);
                            const pattern = ctx.createPattern(resizeImg, repeatStr) as CanvasPattern;
                            // this.renderRepeat(boxs, ctx, path, pattern, x, y);
                            // need transformPath
                            const pathTs = transformPath(path, -x, -y, 0, 0);
                            this.renderRepeat(boxs, ctx, pathTs, pattern);
                            const dataURL = canvas.toDataURL('image/jpeg', 0.8);
                            // console.log(dataURL, 'dataURL', image)
                            ctx.restore();
                            const xPt = this.pxToPt(boxs.left - this.options.x);
                            const yPt = this.pxToPt(boxs.top - this.options.y);
                            const widthPt = this.pxToPt(boxs.width);
                            const heightPt = this.pxToPt(boxs.height);
                            this.addImagePdf(dataURL, 'JPEG', xPt, yPt, widthPt, heightPt);
                        }
                    }
                } catch (e) {
                    this.context.logger.error(`Error loading background-image ${url}`);
                }
            } else if (isLinearGradient(backgroundImage)) {
                const [path, x, y, width, height] = calculateBackgroundRendering(container, index, [null, null, null]);
                const [lineLength, x0, x1, y0, y1] = calculateGradientDirection(backgroundImage.angle, width, height);
                const boxs = contentBox(container);
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                const gradient = ctx.createLinearGradient(x0, y0, x1, y1);

                processColorStops(backgroundImage.stops, lineLength).forEach((colorStop) =>
                    gradient.addColorStop(colorStop.stop, asString(colorStop.color))
                );

                ctx.fillStyle = gradient;
                ctx.fillRect(0, 0, width, height);
                if (width > 0 && height > 0) {
                    const pattern = ctx.createPattern(canvas, 'repeat') as CanvasPattern;
                    // need transformPath
                    const pathTs = transformPath(path, -x, -y, 0, 0);
                    this.renderRepeat(boxs, ctx, pathTs, pattern);
                }
                const dataURL = canvas.toDataURL('image/jpeg', 0.8);
                // console.log(dataURL, 'dataURL', image)
                ctx.restore();
                const xPt = this.pxToPt(x - this.options.x);
                const yPt = this.pxToPt(y - this.options.y);
                const widthPt = this.pxToPt(width);
                const heightPt = this.pxToPt(height);
                this.addImagePdf(dataURL, 'JPEG', xPt, yPt, widthPt, heightPt);
            } else if (isRadialGradient(backgroundImage)) {
                const [path, left, top, width, height] = calculateBackgroundRendering(container, index, [
                    null,
                    null,
                    null
                ]);
                const position = backgroundImage.position.length === 0 ? [FIFTY_PERCENT] : backgroundImage.position;
                const x = getAbsoluteValue(position[0], width);
                const y = getAbsoluteValue(position[position.length - 1], height);

                const [rx, ry] = calculateRadius(backgroundImage, x, y, width, height);
                const ownerDocument = this.canvas.ownerDocument ?? document;
                const canvas = ownerDocument.createElement('canvas');
                canvas.width = Math.max(1, width);
                canvas.height = Math.max(1, height);
                const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
                if (rx > 0 && ry > 0) {
                    const radialGradient = ctx.createRadialGradient(x, y, 0, x, y, rx);
                    processColorStops(backgroundImage.stops, rx * 2).forEach((colorStop) =>
                        radialGradient.addColorStop(colorStop.stop, asString(colorStop.color))
                    );
                    // need transformPath
                    const pathTs = transformPath(path, -left, -top, 0, 0);

                    this.path(pathTs, ctx);
                    ctx.fillStyle = radialGradient;
                    if (rx !== ry) {
                        // transforms for elliptical radial gradient
                        const midX = 0 + 0.5 * width;
                        const midY = 0 + 0.5 * height;
                        const f = ry / rx;
                        const invF = 1 / f;

                        ctx.save();
                        ctx.translate(midX, midY);
                        ctx.transform(1, 0, 0, f, 0, 0);
                        ctx.translate(-midX, -midY);

                        ctx.fillRect(0, invF * (0 - midY) + midY, width, height * invF);
                        // ctx.fillRect(left, invF * (top - midY) + midY, width, height * invF);
                        ctx.restore();
                    } else {
                        ctx.fill();
                    }
                }
                const dataURL = canvas.toDataURL('image/jpeg', 0.8);
                const xPt = this.pxToPt(left - this.options.x);
                const yPt = this.pxToPt(top - this.options.y);
                const widthPt = this.pxToPt(width);
                const heightPt = this.pxToPt(height);
                this.addImagePdf(dataURL, 'JPEG', xPt, yPt, widthPt, heightPt);
            }
            index--;
        }
    }

    async renderSolidBorder(color: Color, side: number, curvePoints: BoundCurves): Promise<void> {
        this.path(parsePathForBorder(curvePoints, side));
        this.context2dCtx.fillStyle = this.convertColor(color);
        this.jspdfCtx.fill();
        this.context2dCtx.fill();
    }

    async renderDoubleBorder(color: Color, width: number, side: number, curvePoints: BoundCurves): Promise<void> {
        if (width < 3) {
            await this.renderSolidBorder(color, side, curvePoints);
            return;
        }

        const outerPaths = parsePathForBorderDoubleOuter(curvePoints, side);
        this.path(outerPaths);
        this.context2dCtx.fillStyle = this.convertColor(color);
        this.context2dCtx.fill();
        const innerPaths = parsePathForBorderDoubleInner(curvePoints, side);
        this.path(innerPaths);
        this.context2dCtx.fill();
    }

    async renderNodeBackgroundAndBorders(paint: ElementPaint): Promise<void> {
        this.applyEffects(paint.getEffects(EffectTarget.BACKGROUND_BORDERS));
        const styles = paint.container.styles;

        const hasBackground = !isTransparent(styles.backgroundColor) || styles.backgroundImage.length;

        const borders = [
            {style: styles.borderTopStyle, color: styles.borderTopColor, width: styles.borderTopWidth},
            {style: styles.borderRightStyle, color: styles.borderRightColor, width: styles.borderRightWidth},
            {style: styles.borderBottomStyle, color: styles.borderBottomColor, width: styles.borderBottomWidth},
            {style: styles.borderLeftStyle, color: styles.borderLeftColor, width: styles.borderLeftWidth}
        ];

        const backgroundPaintingArea = calculateBackgroundCurvedPaintingArea(
            getBackgroundValueForIndex(styles.backgroundClip, 0),
            paint.curves
        );
        const foreignobjectrendering = paint.container.foreignobjectrendering;
        if (hasBackground || styles.boxShadow.length) {
            // console.log('render getFont', this.jspdfCtx.getFont());
            if (!foreignobjectrendering) {
                this.context2dCtx.save();
                this.path(backgroundPaintingArea);
                this.context2dCtx.clip();

                if (!isTransparent(styles.backgroundColor)) {
                    this.context2dCtx.fillStyle = this.convertColor(styles.backgroundColor);
                    this.context2dCtx.fill();
                }
            }

            await this.renderBackgroundImage(paint.container);

            this.context2dCtx.restore();
            this.resetJsPDFFont();
        }
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
                    if (!foreignobjectrendering) {
                        await this.renderSolidBorder(border.color, side, paint.curves);
                    }
                }
            }
            side++;
        }
    }
    async renderDashedDottedBorder(
        color: Color,
        width: number,
        side: number,
        curvePoints: BoundCurves,
        style: BORDER_STYLE
    ): Promise<void> {
        this.context2dCtx.save();

        const strokePaths = parsePathForBorderStroke(curvePoints, side);
        const boxPaths = parsePathForBorder(curvePoints, side);

        if (style === BORDER_STYLE.DASHED) {
            this.path(boxPaths);
            this.context2dCtx.clip();
        }

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

        let length;
        if (side === 0 || side === 2) {
            length = Math.abs(startX - endX);
        } else {
            length = Math.abs(startY - endY);
        }

        this.context2dCtx.beginPath();
        if (style === BORDER_STYLE.DOTTED) {
            this.formatPath(strokePaths);
        } else {
            this.formatPath(boxPaths.slice(0, 2));
        }

        let dashLength = width < 3 ? width * 3 : width * 2;
        let spaceLength = width < 3 ? width * 2 : width;
        if (style === BORDER_STYLE.DOTTED) {
            dashLength = width;
            spaceLength = width;
        }

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

        if (useLineDash) {
            if (style === BORDER_STYLE.DOTTED) {
                this.context2dCtx.setLineDash([0, dashLength + spaceLength]);
            } else {
                this.context2dCtx.setLineDash([dashLength, spaceLength]);
            }
        }

        if (style === BORDER_STYLE.DOTTED) {
            this.context2dCtx.lineCap = 'round';
            this.context2dCtx.lineWidth = width;
        } else {
            this.context2dCtx.lineWidth = width * 2 + 1.1;
        }
        this.context2dCtx.strokeStyle = asString(color);
        this.context2dCtx.stroke();
        this.context2dCtx.setLineDash([]);

        // dashed round edge gap
        if (style === BORDER_STYLE.DASHED) {
            if (isBezierCurve(boxPaths[0])) {
                const path1 = boxPaths[3] as BezierCurve;
                const path2 = boxPaths[0] as BezierCurve;
                this.context2dCtx.beginPath();
                this.formatPath([new Vector(path1.end.x, path1.end.y), new Vector(path2.start.x, path2.start.y)]);
                this.context2dCtx.stroke();
            }
            if (isBezierCurve(boxPaths[1])) {
                const path1 = boxPaths[1] as BezierCurve;
                const path2 = boxPaths[2] as BezierCurve;
                this.context2dCtx.beginPath();
                this.formatPath([new Vector(path1.end.x, path1.end.y), new Vector(path2.start.x, path2.start.y)]);
                this.context2dCtx.stroke();
            }
        }

        this.context2dCtx.restore();
    }
    async addPage(offsetY: number): Promise<void> {
        this.context2dCtx.translate(0, -offsetY);
        this.jspdfCtx.addPage();
    }
    async renderPage(element: ElementContainer, pageNum: number): Promise<void> {
        const cfg = this.options.pageConfig;
        const pageW = this.jspdfCtx.internal.pageSize.getWidth();
        const pageH = this.jspdfCtx.internal.pageSize.getHeight();
        const mt = 0;
        const mb = 0;

        if (this.options.backgroundColor) {
            this.jspdfCtx.setFillColor(this.convertColor(this.options.backgroundColor));
            const bx = this.safe(this.options.x);
            const by = this.safe(this.options.y);
            const bw = Math.max(1, this.safe(this.options.width, 1));
            const bh = Math.max(1, this.safe(this.options.height, 1));
            this.jspdfCtx.rect(bx, by, bw, bh, 'F');
        }

        const stack = parseStackingContexts(element);
        await this.renderStack(stack);
        this.applyEffects([]);

        if (cfg?.header) {
            const headerText = String(cfg.header.content)
                .replace('${currentPage}', String(pageNum))
                .replace('${totalPages}', String(this.totalPages));
            this.jspdfCtx.setFontSize(this.safe(this.pxToPt(cfg.header.contentFontSize), 1));
            this.setTextColorFromString(cfg.header.contentColor);
            const headerPos = this.computeContentPosition(
                cfg.header.contentPosition,
                pageW,
                pageH,
                cfg.header.height,
                mt,
                mb,
                'header',
                cfg.header.padding
            );
            this.textPdf(headerText, headerPos.x, headerPos.y, headerPos.align);
        }

        if (cfg?.footer) {
            const footerText = String(cfg.footer.content)
                .replace('${currentPage}', String(pageNum))
                .replace('${totalPages}', String(this.totalPages));
            this.jspdfCtx.setFontSize(this.safe(this.pxToPt(cfg.footer.contentFontSize), 1));
            this.setTextColorFromString(cfg.footer.contentColor);
            const footerPos = this.computeContentPosition(
                cfg.footer.contentPosition,
                pageW,
                pageH,
                cfg.footer.height,
                mt,
                mb,
                'footer',
                cfg.footer.padding
            );
            this.textPdf(footerText, footerPos.x, footerPos.y, footerPos.align);
        }
    }

    setTotalPages(total: number): void {
        this.totalPages = total;
    }

    private setTextColorFromString(color: string): void {
        const named: Record<string, [number, number, number]> = {
            black: [0, 0, 0],
            white: [255, 255, 255],
            red: [255, 0, 0],
            green: [0, 128, 0],
            blue: [0, 0, 255],
            gray: [128, 128, 128]
        };
        let r = 0,
            g = 0,
            b = 0;
        const c = color?.toLowerCase() || 'black';
        if (c in named) {
            [r, g, b] = named[c];
        } else if (c.startsWith('#') && (c.length === 7 || c.length === 4)) {
            const hex = c.length === 4 ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}` : c;
            r = parseInt(hex.slice(1, 3), 16);
            g = parseInt(hex.slice(3, 5), 16);
            b = parseInt(hex.slice(5, 7), 16);
        }
        this.jspdfCtx.setTextColor(r, g, b);
    }

    private safe(n: number, min = 0): number {
        const v = Number(n);
        return Number.isFinite(v) ? v : min;
    }

    private textPdf(text: string, x: number, y: number, align: 'left' | 'center' | 'right'): void {
        const sx = this.safe(x);
        const sy = this.safe(y);
        this.jspdfCtx.text(String(text), sx, sy, {align});
    }

    private computeContentPosition(
        pos:
            | 'center'
            | 'centerLeft'
            | 'centerRight'
            | 'centerTop'
            | 'centerBottom'
            | 'leftTop'
            | 'leftBottom'
            | 'rightTop'
            | 'rightBottom'
            | number[],
        pageW: number,
        pageH: number,
        areaH: number,
        mt: number,
        mb: number,
        area: 'header' | 'footer',
        paddingPx?: [number, number, number, number]
    ): {x: number; y: number; align: 'left' | 'center' | 'right'} {
        const [pt, pr, pb, pl] = (paddingPx ?? [24, 24, 24, 24]).map((v) => this.pxToPt(v));
        const areaHPt = this.pxToPt(areaH);
        const mtPt = this.pxToPt(mt);
        const mbPt = this.pxToPt(mb);
        if (Array.isArray(pos) && pos.length >= 2) {
            return {x: this.pxToPt(pos[0]), y: this.pxToPt(pos[1]), align: 'left'};
        }
        if (area === 'header') {
            switch (pos) {
                case 'center':
                    return {
                        x: pageW / 2,
                        y: mtPt + pt + (areaHPt - pt - pb) / 2,
                        align: 'center'
                    };
                case 'centerLeft':
                    return {x: pl, y: mtPt + pt + (areaHPt - pt - pb) / 2, align: 'left'};
                case 'centerRight':
                    return {x: pageW - pr, y: mtPt + pt + (areaHPt - pt - pb) / 2, align: 'right'};
                case 'centerTop':
                    return {x: pageW / 2, y: mtPt + pt, align: 'center'};
                case 'centerBottom':
                    return {x: pageW / 2, y: mtPt + areaHPt - pb, align: 'center'};
                case 'leftTop':
                    return {x: pl, y: mtPt + pt, align: 'left'};
                case 'leftBottom':
                    return {x: pl, y: mtPt + areaHPt - pb, align: 'left'};
                case 'rightTop':
                    return {x: pageW - pr, y: mtPt + pt, align: 'right'};
                case 'rightBottom':
                    return {x: pageW - pr, y: mtPt + areaHPt - pb, align: 'right'};
                default:
                    return {x: pl, y: mtPt + pt, align: 'left'};
            }
        } else {
            switch (pos) {
                case 'center':
                    return {
                        x: pageW / 2,
                        y: pageH - mbPt - areaHPt + pt + (areaHPt - pt - pb) / 2,
                        align: 'center'
                    };
                case 'centerLeft':
                    return {x: pl, y: pageH - mbPt - areaHPt + pt + (areaHPt - pt - pb) / 2, align: 'left'};
                case 'centerRight':
                    return {x: pageW - pr, y: pageH - mbPt - areaHPt + pt + (areaHPt - pt - pb) / 2, align: 'right'};
                case 'centerTop':
                    return {x: pageW / 2, y: pageH - mbPt - areaHPt + pt, align: 'center'};
                case 'centerBottom':
                    return {x: pageW / 2, y: pageH - mbPt - pb, align: 'center'};
                case 'leftTop':
                    return {x: pl, y: pageH - mbPt - areaHPt + pt, align: 'left'};
                case 'leftBottom':
                    return {x: pl, y: pageH - mbPt - pb, align: 'left'};
                case 'rightTop':
                    return {x: pageW - pr, y: pageH - mbPt - areaHPt + pt, align: 'right'};
                case 'rightBottom':
                    return {x: pageW - pr, y: pageH - mbPt - pb, align: 'right'};
                default:
                    return {x: pl, y: pageH - mbPt - pb, align: 'left'};
            }
        }
    }

    private addImagePdf(
        img: HTMLImageElement | HTMLCanvasElement | string,
        format: 'PNG' | 'JPEG' | 'WEBP',
        x: number,
        y: number,
        w: number,
        h: number
    ): void {
        const sx = this.safe(x);
        const sy = this.safe(y);
        const sw = Math.max(1, this.safe(w, 1));
        const sh = Math.max(1, this.safe(h, 1));
        // draw a big image，jsPDF：Error: Invalid image dimensions: width and height must be positive numbers.
        this.jspdfCtx.addImage(img, format, sx, sy, sw, sh, '', 'FAST');
    }

    async output(): Promise<Blob> {
        const pdfBlob = this.jspdfCtx.output('blob');
        return pdfBlob;
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
