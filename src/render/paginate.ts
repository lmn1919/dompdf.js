import {Context} from '../core/context';
import {Bounds} from '../css/layout/bounds';
import type {TextBounds} from '../css/layout/text';
import type {ElementContainer} from '../dom/element-container';
import type {TextContainer} from '../dom/text-container';
import {pageConfigOptions} from './canvas/pdf-renderer';

const offSetPageObj: any = {};
let offSetTotal = 0;
let activePageHeight = 1123;
let pageMarginTop = 0;
let pageMarginBottom = 0;
const cloneContainerShallow = (src: ElementContainer): ElementContainer => {
    const c = Object.create(Object.getPrototypeOf(src)) as any;
    const srcObj = src as unknown as Record<string, unknown>;
    for (const key of Object.keys(srcObj)) {
        if (key === 'elements' || key === 'bounds' || key === 'styles' || key === 'textNodes') continue;
        c[key] = srcObj[key];
    }
    c.context = (src as ElementContainer & {context: Context}).context;
    c.styles = Object.assign(Object.create(Object.getPrototypeOf(src.styles)), src.styles);
    c.textNodes = src.textNodes;
    c.flags = src.flags;
    c.bounds = new Bounds(src.bounds.left, src.bounds.top, src.bounds.width, src.bounds.height);
    c.elements = [];
    return c as unknown as ElementContainer;
};

const cloneTextContainerShallow = (src: TextContainer): TextContainer => {
    const c = Object.create(Object.getPrototypeOf(src)) as any;
    c.text = (src as any).text;
    c.textBounds = [] as TextBounds[];
    return c as TextContainer;
};

const computeMaxBottom = (node: ElementContainer): number => {
    let maxBottom = node.bounds.top + node.bounds.height;
    for (const tn of node.textNodes) {
        for (const tb of tn.textBounds) {
            const b = tb.bounds.top + tb.bounds.height;
            if (b > maxBottom) maxBottom = b;
        }
    }
    for (const el of node.elements) {
        const b = computeMaxBottom(el);
        if (b > maxBottom) maxBottom = b;
    }
    return maxBottom;
};

const filterTextNodesForPage = (container: ElementContainer, pageStart: number, pageEnd: number): TextContainer[] => {
    const result: TextContainer[] = [];

    for (const tc of container.textNodes) {
        const filtered: TextBounds[] = [];

        for (const tb of tc.textBounds) {
            const pageIndex = Math.floor(pageEnd / activePageHeight);
            const maxKey = Math.max(...Object.keys(offSetPageObj).map((k) => +k));
            const activePageOffset = offSetPageObj[maxKey] || 0;
            const top = tb.bounds.top + activePageOffset;
            const bottom = tb.bounds.top + tb.bounds.height + activePageOffset;
            const intersects = bottom > pageStart && top < pageEnd;
            const crossesToNextPage = bottom > pageEnd;

            if (intersects && !crossesToNextPage) {
                let offsetNum = 0;
                if (top < pageStart) {
                    offsetNum = pageStart - top;

                    if (
                        !offSetPageObj[pageIndex] ||
                        (offSetPageObj[pageIndex] && offSetPageObj[pageIndex] < offsetNum)
                    ) {
                        if (offSetPageObj[pageIndex] && offSetPageObj[pageIndex] < offsetNum) {
                            offSetTotal = offSetTotal - offSetPageObj[pageIndex] + offsetNum;
                        } else {
                            offSetTotal += offsetNum;
                        }
                        offSetPageObj[pageIndex] = offSetTotal;
                    }
                }
                const visibleTop = Math.max(top, pageStart);
                const newTop = visibleTop - pageStart;

                // 根据可见区域生成新的 Bounds
                const nb = new Bounds(tb.bounds.left, newTop + pageMarginTop, tb.bounds.width, tb.bounds.height);
                // if (pageIndex == 3) {
                //     console.log(
                //         'nb',
                //         nb,
                //         'pageStart',
                //         pageStart,
                //         'tb.bounds.top',
                //         tb.bounds.top,
                //         'activePageOffset',
                //         activePageOffset,
                //         (tb as any).text
                //     );
                // }
                // 把文字内容和新的 bounds 一起放进 filtered
                filtered.push({text: (tb as any).text, bounds: nb} as TextBounds);
            }
        }
        if (filtered.length > 0) {
            const clone = cloneTextContainerShallow(tc);
            (clone as any).textBounds = filtered;
            result.push(clone);
        }
    }

    return result;
};

const filterElementForPage = (
    container: ElementContainer,
    pageStart: number,
    pageEnd: number
): ElementContainer | null => {
    const pageIndex = Math.floor(pageEnd / activePageHeight);
    const maxKey = Math.max(...Object.keys(offSetPageObj).map((k) => +k));
    const activePageOffset = offSetPageObj[maxKey] || 0;

    const top = container.bounds.top + activePageOffset;
    const bottom = container.bounds.top + container.bounds.height + activePageOffset;

    if (container.divisionDisable && bottom > pageEnd && top < pageEnd) {
        const offsetNum = pageEnd - top;
        const prev = offSetPageObj[pageIndex] || 0;
        if (!offSetPageObj[pageIndex] || prev < offsetNum) {
            offSetTotal += offsetNum - prev;
            offSetPageObj[pageIndex] = offSetTotal;
        }
        return null;
    }

    const children: ElementContainer[] = [];
    for (const child of container.elements) {
        const part = filterElementForPage(child, pageStart, pageEnd);
        if (part) children.push(part);
    }
    const textNodes = filterTextNodesForPage(container, pageStart, pageEnd);
    const visibleTop = Math.max(top, pageStart);
    const visibleBottom = Math.min(bottom, pageEnd);
    const newHeight = Math.max(0, visibleBottom - visibleTop);
    const hasContent = children.length > 0 || textNodes.length > 0 || newHeight > 0;
    if (!hasContent) return null;

    const clone = cloneContainerShallow(container) as any;
    clone.elements = children;
    clone.textNodes = textNodes;

    const newTop = visibleTop >= pageStart ? visibleTop - pageStart : 0;
    clone.bounds = new Bounds(container.bounds.left, newTop + pageMarginTop, container.bounds.width, newHeight);
    return clone as ElementContainer;
};

export const paginateNode = (
    root: ElementContainer,
    pageHeight: number,
    initialOffset = 0,
    pageConfig?: pageConfigOptions
): ElementContainer[] => {
    if (initialOffset < 0) initialOffset = 0;
    offSetTotal = 0;
    Object.keys(offSetPageObj).forEach((key) => delete offSetPageObj[key]);
    const maxBottom = computeMaxBottom(root);
    pageMarginTop = pageConfig?.header?.height || 0;
    pageMarginBottom = pageConfig?.footer?.height || 0;
    activePageHeight = pageHeight - pageMarginTop - pageMarginBottom;
    const totalPages = Math.max(1, Math.ceil((maxBottom - initialOffset) / activePageHeight));
    const pages: ElementContainer[] = [];
    for (let i = 0; i < totalPages; i++) {
        const pageStart = initialOffset + i * activePageHeight;
        const pageEnd = pageStart + activePageHeight;
        const pageRoot = filterElementForPage(root, pageStart, pageEnd);
        if (pageRoot) pages.push(pageRoot);
    }
    // console.log(offSetPageObj, '偏移量');
    return pages;
};
