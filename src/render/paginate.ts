import {Context} from '../core/context';
import {Bounds} from '../css/layout/bounds';
import type {TextBounds} from '../css/layout/text';
import type {ElementContainer} from '../dom/element-container';
import type {TextContainer} from '../dom/text-container';
import {pageConfigOptions} from './canvas/pdf-renderer';

let offSetPageObj: Record<number | string, number> = {};
let offSetTotal = 0;
let activePageHeight = 1123;
let pageMarginTop = 0;
let pageMarginBottom = 0;
// let realPageSize = 0;
const pageTopOffset = 10;
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
            const activePageOffset = pageIndex === 1 ? 0 : offSetPageObj[maxKey] || 0;
            const prevMaxKey = Math.max(
                ...Object.keys(offSetPageObj)
                    .filter((k) => +k < pageIndex)
                    .map((k) => +k)
            );
            const prevPageOffset = offSetPageObj[prevMaxKey] || 0;
            let top = tb.bounds.top + activePageOffset;
            let bottom = tb.bounds.top + tb.bounds.height + activePageOffset;
            const intersects = bottom > pageStart && top < pageEnd;
            const crossesToNextPage = bottom > pageEnd;
            if (intersects && !crossesToNextPage) {
                let offsetNum = 0;
                if (top < pageStart) {
                    if (prevPageOffset || pageIndex > 1) {
                        // Because the offset is only increased when paging occurs, and each time elements are paged, a full traversal is performed
                        // Determine that the current text does not require pagination rendering based on the height calculated on the previous page, so proceed directly to continue
                        const prevPageStart = pageStart - activePageHeight;
                        const prevPageEnd = pageEnd - activePageHeight;
                        const prevTop = tb.bounds.top + prevPageOffset;
                        const prevBottom = tb.bounds.top + tb.bounds.height + prevPageOffset;
                        const prevIntersects = prevBottom > prevPageStart && prevTop < prevPageEnd;
                        const prevCrossesToNextPage = prevBottom > prevPageEnd;
                        if (prevIntersects && !prevCrossesToNextPage) {
                            continue;
                        }
                    }
                    offsetNum = pageStart - top + pageTopOffset;
                    const prev = offSetPageObj[pageIndex] || 0;
                    if (!offSetPageObj[pageIndex] || prev < offsetNum) {
                        if (prev < offsetNum) {
                            offSetTotal = offSetTotal - prev + offsetNum;
                        } else {
                            offSetTotal += offsetNum;
                        }
                        offSetPageObj[pageIndex] = offSetTotal;
                    }
                    // Fix the issue where no offset is added for the first text container
                    bottom += offsetNum;
                    top += offsetNum;
                    // fix add realpageSize
                    // TODO
                    // if (offsetNum && realPageSize <= pageIndex) {
                    //     realPageSize = pageIndex + 1;
                    // }
                }
                const visibleTop = Math.max(top, pageStart);
                const visibleBottom = Math.min(bottom, pageEnd);
                const newTop = visibleTop - pageStart;
                const newHeight = Math.max(0, visibleBottom - visibleTop);
                // Generate new Bounds based on the visible area
                const nb = new Bounds(tb.bounds.left, newTop + pageMarginTop, tb.bounds.width, newHeight);
                // Put the text content and the new bounds into filtered
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
    let maxKey = Math.max(...Object.keys(offSetPageObj).map((k) => +k));
    let activePageOffset = pageIndex === 1 ? 0 : offSetPageObj[maxKey] || 0;
    let top = container.bounds.top + activePageOffset;
    let bottom = container.bounds.top + container.bounds.height + activePageOffset;

    if (container.divisionDisable && bottom > pageEnd && top < pageEnd) {
        const offsetNum = pageEnd - top + pageTopOffset;
        const prev = offSetPageObj[pageIndex] || 0;
        if (!offSetPageObj[pageIndex] || prev < offsetNum) {
            offSetTotal += offsetNum - prev;
            offSetPageObj[pageIndex] = offSetTotal;
        }
        // fix add realpageSize
        // TODO
        // if (offsetNum && realPageSize <= pageIndex) {
        //     realPageSize = pageIndex + 1;
        // }
        return null;
    }

    const children: ElementContainer[] = [];
    for (const child of container.elements) {
        const part = filterElementForPage(child, pageStart, pageEnd);
        if (part) children.push(part);
    }
    const textNodes = filterTextNodesForPage(container, pageStart, pageEnd);
    // Prevent the outer container from not synchronizing the offsetPage when the text spans multiple pages
    maxKey = Math.max(...Object.keys(offSetPageObj).map((k) => +k));
    activePageOffset = pageIndex === 1 ? 0 : offSetPageObj[maxKey] || 0;
    top = container.bounds.top + activePageOffset;
    bottom = container.bounds.top + container.bounds.height + activePageOffset;
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
    totalHeight?: number,
    pageConfig?: pageConfigOptions
): ElementContainer[] => {
    if (initialOffset < 0) initialOffset = 0;
    offSetTotal = 0;
    offSetPageObj = {};
    const maxBottom = totalHeight || computeMaxBottom(root);
    pageMarginTop = pageConfig?.header?.height || 0;
    pageMarginBottom = pageConfig?.footer?.height || 0;
    activePageHeight = pageHeight - pageMarginTop - pageMarginBottom;
    const totalPages = Math.max(1, Math.ceil((maxBottom - initialOffset) / activePageHeight));
    // realPageSize = totalPages;
    const pages: ElementContainer[] = [];
    for (let i = 0; i < totalPages; i++) {
        const pageStart = initialOffset + i * activePageHeight;
        const pageEnd = pageStart + activePageHeight;
        const pageRoot = filterElementForPage(root, pageStart, pageEnd);
        if (pageRoot) pages.push(pageRoot);
    }
    // If the number of pages increases due to divisionDisable or text truncation, recalculation of pages is required
    // TODO
    // if (realPageSize > totalPages) {
    //     for (let i = totalPages; i < realPageSize; i++) {
    //         const pageStart = initialOffset + i * activePageHeight;
    //         const pageEnd = pageStart + activePageHeight;
    //         const pageRoot = filterElementForPage(root, pageStart, pageEnd);
    //         if (pageRoot) pages.push(pageRoot);
    //     }
    // }
    // console.log(offSetPageObj, '偏移量');
    return pages;
};
