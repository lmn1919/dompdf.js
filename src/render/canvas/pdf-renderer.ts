import {jsPDF} from 'jspdf';
import {contains} from '../../core/bitwise';
import {Context} from '../../core/context';
import {CSSParsedDeclaration} from '../../css';
import {Bounds} from '../../css/layout/bounds';
import {segmentGraphemes, TextBounds} from '../../css/layout/text';
import {BACKGROUND_CLIP} from '../../css/property-descriptors/background-clip';
import {BORDER_STYLE} from '../../css/property-descriptors/border-style';
import {DIRECTION} from '../../css/property-descriptors/direction';
import {DISPLAY} from '../../css/property-descriptors/display';
import {computeLineHeight} from '../../css/property-descriptors/line-height';
import {LIST_STYLE_TYPE} from '../../css/property-descriptors/list-style-type';
import {PAINT_ORDER_LAYER} from '../../css/property-descriptors/paint-order';
import {TEXT_ALIGN} from '../../css/property-descriptors/text-align';
import {TEXT_DECORATION_LINE} from '../../css/property-descriptors/text-decoration-line';
import {isDimensionToken} from '../../css/syntax/parser';
import {asString, Color, isTransparent} from '../../css/types/color';
import {CSSImageType, CSSURLImage} from '../../css/types/image';
import {getAbsoluteValue} from '../../css/types/length-percentage';
import {ElementContainer, FLAGS} from '../../dom/element-container';
import {SelectElementContainer} from '../../dom/elements/select-element-container';
import {TextareaElementContainer} from '../../dom/elements/textarea-element-container';
import {ReplacedElementContainer} from '../../dom/replaced-elements';
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
import {Path} from '../path';
import {Renderer} from '../renderer';
import {ElementPaint, parseStackingContexts, StackingContext} from '../stacking-context';
import {Vector} from '../vector';

interface FontConfig {
    fontFamily: string;
    fontBase64: string;
}

export type RenderConfigurations = RenderOptions & {
    backgroundColor: Color | null;
    fontConfig: FontConfig;
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
    encryption?: {
        userPassword?: string;
        ownerPassword?: string;
        userPermissions?: string[];
    };
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
        | 'credit-card';
    pageConfig?: pageConfigOptions;
}
export class CanvasRenderer extends Renderer {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    readonly jspdfCtx: any;
    readonly context2dCtx: any;
    private readonly _activeEffects: IElementEffect[] = [];
    private readonly fontMetrics: FontMetrics;
    private readonly pxToPt: (px: number) => number;
    private totalPages = 1;

    constructor(context: Context, options: RenderConfigurations) {
        super(context, options);
        this.canvas = options.canvas ? options.canvas : document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D;

        const pxToPt = (px: number) => px * (72 / 96);
        const pageWidth = pxToPt(options.width);
        const pageHeight = pxToPt(options.height);

        // const enc =
        //     this.options.encryption &&
        //     (this.options.encryption.userPassword ||
        //         this.options.encryption.ownerPassword ||
        //         (this.options.encryption.userPermissions && this.options.encryption.userPermissions.length))
        //         ? this.options.encryption
        //         : [];
        const encOptions = this.options.encryption
            ? {
                  userPassword: this.options.encryption.userPassword,
                  ownerPassword: this.options.encryption.ownerPassword,
                  userPermissions: this.options.encryption.userPermissions as (
                      | 'print'
                      | 'modify'
                      | 'copy'
                      | 'annot-forms'
                  )[]
              }
            : undefined;

        this.jspdfCtx = new jsPDF({
            orientation: pageWidth > pageHeight ? 'landscape' : 'portrait',
            unit: 'pt',
            format: options.pagination && options.format ? options.format : [pageHeight, pageWidth],
            hotfixes: ['px_scaling'],
            putOnlyUsedFonts: options.putOnlyUsedFonts,
            compress: options.compress,
            precision: options.precision,
            floatPrecision: options.floatPrecision,
            encryption: encOptions
        });
        //     orientation: pageWidth > pageHeight ? 'landscape' : 'portrait',
        //     unit: 'pt',
        //     format: options.pagination && options.format ? options.format : [pageHeight, pageWidth],
        //     hotfixes: ['px_scaling'],
        //     putOnlyUsedFonts: options.putOnlyUsedFonts,
        //     compress: options.compress,
        //     precision: options.precision,
        //     floatPrecision: options.floatPrecision,
        //     encryption: enc
        // });
        this.context2dCtx = this.jspdfCtx.context2d;
        this.context2dCtx.scale(0.75, 0.75);

        this.context2dCtx.translate(-options.x, -options.y);

        if (options.fontConfig) {
            try {
                this.loadFont();
            } catch (error) {
                console.warn('Failed to set font:', error);
                this.jspdfCtx.setFont('Helvetica');
            }
        }

        this.pxToPt = pxToPt;

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

    async loadFont() {
        let fontData;

        if (this.options.fontConfig.fontBase64) {
            fontData = this.options.fontConfig.fontBase64;
        }
        this.addFontToJsPDF(fontData as string);
    }
    addFontToJsPDF(fontData: string) {
        const {fontFamily} = this.options.fontConfig;
        if (!fontFamily) {
            return;
        }
        this.jspdfCtx.addFileToVFS(`${fontFamily}.ttf`, fontData);
        this.jspdfCtx.addFont(`${fontFamily}.ttf`, fontFamily, 'normal');
        this.jspdfCtx.setFont(fontFamily);
    }

    applyEffects(effects: IElementEffect[]): void {
        while (this._activeEffects.length) {
            this.popEffect();
        }

        effects.forEach((effect) => this.applyEffect(effect));
    }

    applyEffect(effect: IElementEffect): void {
        this.ctx.save();
        if (isOpacityEffect(effect)) {
            this.ctx.globalAlpha = effect.opacity;
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
        }

        if (isClipEffect(effect)) {
            this.path(effect.path);
            this.ctx.clip();
        }

        this._activeEffects.push(effect);
    }

    popEffect(): void {
        this._activeEffects.pop();
        this.context2dCtx.restore();
        if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
            this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
        }
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
                return left + this.ctx.measureText(letter).width;
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

        return asString(color);
    }

    async renderTextNode(text: TextContainer, styles: CSSParsedDeclaration): Promise<void> {
        const [font, fontFamily, fontSize] = this.createFontStyle(styles);

        this.ctx.font = font;
        this.context2dCtx.font = this.options.fontConfig.fontFamily;

        this.ctx.direction = styles.direction === DIRECTION.RTL ? 'rtl' : 'ltr';
        this.context2dCtx.direction = styles.direction === DIRECTION.RTL ? 'rtl' : 'ltr';

        this.ctx.textAlign = 'left';
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
        }
    }

    async renderNodeContent(paint: ElementPaint): Promise<void> {
        this.applyEffects(paint.getEffects(EffectTarget.CONTENT));
        const container = paint.container;
        const curves = paint.curves;
        const styles = container.styles;

        for (const child of container.textNodes) {
            await this.renderTextNode(child, styles);
        }

        if (container instanceof ImageElementContainer) {
            try {
                const image = await this.context.cache.match(container.src);
                this.renderReplacedElement(container, curves, image);

                try {
                    const bounds = contentBox(container);
                    const x = this.pxToPt(bounds.left - this.options.x);
                    const y = this.pxToPt(bounds.top - this.options.y);
                    const width = this.pxToPt(bounds.width);
                    const height = this.pxToPt(bounds.height);

                    this.addImagePdf(image, 'JPEG', x, y, width, height);
                } catch (err) {
                    this.context.logger.error(`Error adding image to PDF: ${err}`);
                }
            } catch (e) {
                this.context.logger.error(`Error loading image ${container}`);
            }
        }

        if (container instanceof CanvasElementContainer) {
            this.renderReplacedElement(container, curves, container.canvas);

            try {
                const bounds = contentBox(container);
                const x = this.pxToPt(bounds.left - this.options.x);
                const y = this.pxToPt(bounds.top - this.options.y);
                const width = this.pxToPt(bounds.width);
                const height = this.pxToPt(bounds.height);

                const dataURL = container.canvas.toDataURL('image/png', 0.95);

                this.addImagePdf(dataURL, 'PNG', x, y, width, height);
            } catch (err) {
                this.context.logger.error(`Error adding canvas to PDF: ${err}`);
            }
        }

        if (container instanceof SVGElementContainer) {
            try {
                const image = await this.context.cache.match(container.svg);
                this.renderReplacedElement(container, curves, image);

                try {
                    const bounds = contentBox(container);
                    const x = this.pxToPt(bounds.left - this.options.x);
                    const y = this.pxToPt(bounds.top - this.options.y);
                    const width = this.pxToPt(bounds.width);
                    const height = this.pxToPt(bounds.height);

                    const canvas = document.createElement('canvas');
                    canvas.width = container.intrinsicWidth || image.width;
                    canvas.height = container.intrinsicHeight || image.height;
                    const ctx = canvas.getContext('2d');
                    if (ctx) {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                        const dataURL = canvas.toDataURL('image/png');

                        this.addImagePdf(dataURL, 'PNG', x, y, width, height);
                    }
                } catch (err) {
                    this.context.logger.error(`Error adding SVG to PDF: ${err}`);
                }
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
                    if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
                        this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
                    }
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
                        this.context2dCtx.drawImage(
                            image,
                            container.bounds.left - (image.width + 10),
                            container.bounds.top
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

        if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
            this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
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

    path(paths: Path[]): void {
        this.context2dCtx.beginPath();
        this.formatPath(paths);
        this.context2dCtx.closePath();
    }

    formatPath(paths: Path[]): void {
        paths.forEach((point, index) => {
            const start: Vector = isBezierCurve(point) ? point.start : point;
            if (index === 0) {
                this.context2dCtx.moveTo(start.x, start.y);
            } else {
                this.context2dCtx.lineTo(start.x, start.y);
            }

            if (isBezierCurve(point)) {
                this.context2dCtx.bezierCurveTo(
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

    renderRepeat(path: Path[], pattern: CanvasPattern | CanvasGradient, offsetX: number, offsetY: number): void {
        this.path(path);
        this.ctx.fillStyle = pattern;
        this.context2dCtx.translate(offsetX, offsetY);
        this.context2dCtx.fill();
        this.context2dCtx.translate(-offsetX, -offsetY);
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

                    const xPt = this.pxToPt(x - this.options.x);
                    const yPt = this.pxToPt(y - this.options.y);
                    const widthPt = this.pxToPt(width);
                    const heightPt = this.pxToPt(height);
                    this.addImagePdf(image, 'JPEG', xPt, yPt, widthPt, heightPt);
                }
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
            if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
                this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
            }
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

            if (this.options.fontConfig && this.options.fontConfig.fontFamily) {
                this.jspdfCtx.setFont(this.options.fontConfig.fontFamily);
            }
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
         /**
         * fix: Fixed an error when calling this.jspdfCtx.restoreGraphicsState() when the internal graphics state stack of jsPDF is empty
         * Save the jsPDF graphics state first
         */
        this.jspdfCtx.saveGraphicsState();
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
        this.jspdfCtx.setDrawColor(this.convertColor(color));

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
                this.jspdfCtx.setLineDashPattern([0, dashLength + spaceLength], 0);
            } else {
                this.jspdfCtx.setLineDashPattern([dashLength, spaceLength], 0);
            }
        }

        if (style === BORDER_STYLE.DOTTED) {
            this.jspdfCtx.setLineCap('round');
            this.jspdfCtx.setLineWidth(width);
        } else {
            this.jspdfCtx.setLineWidth(width * 2 + 1.1);
        }
        this.jspdfCtx.stroke();
        this.jspdfCtx.setLineDashPattern([], 0);

        if (style === BORDER_STYLE.DASHED) {
            if (isBezierCurve(boxPaths[0])) {
                const path1 = boxPaths[3] as BezierCurve;
                const path2 = boxPaths[0] as BezierCurve;

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
                this.jspdfCtx.lines(
                    [[path1.end.x, path1.end.y, path2.start.x, path2.start.y]],
                    path1.end.x,
                    path1.end.y
                );
                this.jspdfCtx.stroke();
            }
        }

        this.jspdfCtx.restoreGraphicsState();
    }
    async addPage(offsetY: number) {
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
        (this.jspdfCtx as any).text(String(text), sx, sy, {align});
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
        this.jspdfCtx.addImage(img as any, format, sx, sy, sw, sh);
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
