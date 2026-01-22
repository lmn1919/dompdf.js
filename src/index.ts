import {CacheStorage} from './core/cache-storage';
import {Context, ContextOptions} from './core/context';
import {Bounds, parseBounds, parseDocumentSize} from './css/layout/bounds';
import {COLORS, isTransparent, parseColor} from './css/types/color';
import {CloneConfigurations, CloneOptions, DocumentCloner, WindowOptions} from './dom/document-cloner';
import type {ElementContainer} from './dom/element-container';
import {isBodyElement, isHTMLElement, parseTree} from './dom/node-parser';
import {ForeignObjectRenderer} from './render/canvas/foreignobject-renderer';
import {CanvasRenderer, RenderConfigurations, RenderOptions} from './render/canvas/pdf-renderer';
import {PAGE_FORMAT_MAP} from './render/page-format-map';
import {paginateNode} from './render/paginate';
import {isEmptyValue} from './utils';
// paginationState

interface FontConfig {
    fontFamily: string;
    fontBase64: string;
}
// import { Console } from 'console';
export type Options = CloneOptions &
    WindowOptions &
    RenderOptions &
    ContextOptions & {
        backgroundColor: string | null;
        foreignObjectRendering: boolean;
        divisionDisable?: boolean; // 禁用分割
        removeContainer?: boolean;
        fontConfig?: FontConfig;
    };

const dompdf = (element: HTMLElement, options: Partial<Options> = {}): Promise<HTMLCanvasElement> => {
    return renderElement(element, options);
};

export default dompdf;

if (typeof window !== 'undefined') {
    CacheStorage.setContext(window);
}

const parseBackgroundColor = (context: Context, element: HTMLElement, backgroundColorOverride?: string | null) => {
    const ownerDocument = element.ownerDocument;
    // http://www.w3.org/TR/css3-background/#special-backgrounds
    const documentBackgroundColor = ownerDocument.documentElement
        ? parseColor(context, getComputedStyle(ownerDocument.documentElement).backgroundColor as string)
        : COLORS.TRANSPARENT;
    const bodyBackgroundColor = ownerDocument.body
        ? parseColor(context, getComputedStyle(ownerDocument.body).backgroundColor as string)
        : COLORS.TRANSPARENT;

    const defaultBackgroundColor =
        typeof backgroundColorOverride === 'string'
            ? parseColor(context, backgroundColorOverride)
            : backgroundColorOverride === null
            ? COLORS.TRANSPARENT
            : 0xffffffff;
    return element === ownerDocument.documentElement
        ? isTransparent(documentBackgroundColor)
            ? isTransparent(bodyBackgroundColor)
                ? defaultBackgroundColor
                : bodyBackgroundColor
            : documentBackgroundColor
        : defaultBackgroundColor;
};

const renderElement = async (element: HTMLElement, opts: Partial<Options>): Promise<any> => {
    if (!element || typeof element !== 'object') {
        return Promise.reject('Invalid element provided as first argument');
    }
    const ownerDocument = element.ownerDocument;

    if (!ownerDocument) {
        throw new Error(`Element is not attached to a Document`);
    }

    const defaultView = ownerDocument.defaultView;

    if (!defaultView) {
        throw new Error(`Document is not attached to a Window`);
    }

    const resourceOptions = {
        allowTaint: opts.allowTaint ?? false,
        imageTimeout: opts.imageTimeout ?? 15000,
        proxy: opts.proxy,
        useCORS: opts.useCORS ?? false
    };

    const contextOptions = {
        logging: opts.logging ?? true,
        cache: opts.cache,
        ...resourceOptions
    };

    const windowOptions = {
        windowWidth: opts.windowWidth ?? defaultView.innerWidth,
        windowHeight: opts.windowHeight ?? defaultView.innerHeight,
        scrollX: opts.scrollX ?? defaultView.pageXOffset,
        scrollY: opts.scrollY ?? defaultView.pageYOffset
    };

    const windowBounds = new Bounds(
        windowOptions.scrollX,
        windowOptions.scrollY,
        windowOptions.windowWidth,
        windowOptions.windowHeight
    );

    const context = new Context(contextOptions, windowBounds);

    const foreignObjectRendering = opts.foreignObjectRendering ?? false;

    const cloneOptions: CloneConfigurations = {
        allowTaint: opts.allowTaint ?? false,
        onclone: opts.onclone,
        ignoreElements: opts.ignoreElements,
        inlineImages: foreignObjectRendering,
        copyStyles: foreignObjectRendering
    };

    context.logger.debug(
        `Starting document clone with size ${windowBounds.width}x${
            windowBounds.height
        } scrolled to ${-windowBounds.left},${-windowBounds.top}`
    );

    const documentCloner = new DocumentCloner(context, element, cloneOptions);
    const clonedElement = documentCloner.clonedReferenceElement;
    if (clonedElement && clonedElement.style) {
        clonedElement.style.border = 'none';
        clonedElement.style.boxShadow = 'none';

        if (!opts.fontConfig || !opts.fontConfig.fontBase64) {
            clonedElement.style.fontFamily = 'Helvetica';
        }
    }
    if (!clonedElement) {
        return Promise.reject(`Unable to find element in cloned iframe`);
    }

    const container = await documentCloner.toIFrame(ownerDocument, windowBounds);

    const {width, height, left, top} =
        isBodyElement(clonedElement) || isHTMLElement(clonedElement)
            ? parseDocumentSize(clonedElement.ownerDocument)
            : parseBounds(context, clonedElement);

    const backgroundColor = parseBackgroundColor(context, clonedElement, opts.backgroundColor);

    const renderOptions: RenderConfigurations = {
        canvas: opts.canvas,
        backgroundColor,
        scale: opts.scale ?? defaultView.devicePixelRatio ?? 1,
        x: (opts.x ?? 0) + left,
        y: (opts.y ?? 0) + top,
        width: opts.width ?? Math.ceil(width),
        height: opts.height ?? Math.ceil(height),
        fontConfig: opts.fontConfig ?? {
            fontFamily: '',
            fontBase64: ''
        },
        encryption: isEmptyValue(opts.encryption) ? undefined : opts.encryption, // fix：jspdf encryption default value
        precision: opts.precision ?? 16,
        floatPrecision: opts.floatPrecision ?? 16,
        compress: opts.compress ?? false,
        putOnlyUsedFonts: opts.putOnlyUsedFonts ?? false,
        pagination: opts.pagination ?? false,
        format: opts.format ?? 'a4',
        pageConfig: opts.pageConfig ?? {
            header: {
                content: '',
                height: 50,
                contentPosition: 'centerRight',
                contentColor: '#333333',
                contentFontSize: 16,
                padding: [0, 24, 0, 24]
            },
            footer: {
                content: '${currentPage}/${totalPages}',
                height: 50,
                contentPosition: 'center',
                contentColor: '#333333',
                contentFontSize: 16,
                padding: [0, 24, 0, 24]
            }
        }
    };

    let canvas;

    if (foreignObjectRendering) {
        context.logger.debug(`Document cloned, using foreign object rendering`);
        const renderer = new ForeignObjectRenderer(context, renderOptions);
        canvas = await renderer.render(clonedElement);
    } else {
        context.logger.debug(
            `Document cloned, element located at ${left},${top} with size ${width}x${height} using computed rendering`
        );

        context.logger.debug(`Starting DOM parsing`, context, clonedElement);
        const root = await parseTree(context, clonedElement);
        const {height: pageHeight} = PAGE_FORMAT_MAP[renderOptions.format || 'a4'];
        if (renderOptions.y !== 0) {
            const offsetY = renderOptions.y;
            renderOptions.y = 0;
            const adjustTop = (node: ElementContainer, delta: number) => {
                node.bounds.top = node.bounds.top - delta;
                for (const tn of node.textNodes as any[]) {
                    for (const tb of tn.textBounds as any[]) {
                        tb.bounds.top = tb.bounds.top - delta;
                    }
                }
                for (const el of node.elements) {
                    adjustTop(el, delta);
                }
            };
            adjustTop(root, offsetY);
        }
        const pageRoots = paginateNode(root, pageHeight, renderOptions.y, renderOptions.pageConfig);

        Reflect.deleteProperty(root, 'context');
        if (backgroundColor === root.styles.backgroundColor) {
            root.styles.backgroundColor = COLORS.TRANSPARENT;
        }
        context.logger.debug(
            `Starting renderer for element at ${renderOptions.x},${renderOptions.y} with size ${renderOptions.width}x${renderOptions.height}`
        );
        // console.log('pageRootrenderOptions', root, renderOptions, pageRoots);
        // , pageRoots, paginationState
        renderOptions.y = 0;
        const renderer = new CanvasRenderer(context, renderOptions);
        renderer.setTotalPages(pageRoots.length);
        if (pageRoots.length > 0) {
            await renderer.renderPage(pageRoots[0], 1);
            for (let i = 1; i < pageRoots.length; i++) {
                renderer.addPage(0);
                await renderer.renderPage(pageRoots[i], i + 1);
            }
        }
        canvas = await renderer.output();
    }

    if (opts.removeContainer ?? true) {
        if (!DocumentCloner.destroy(container)) {
            context.logger.error(`Cannot detach cloned iframe as it is not in the DOM anymore`);
        }
    }

    context.logger.debug(`Finished rendering`);
    return canvas;
};
