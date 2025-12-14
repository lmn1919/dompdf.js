import {snapdom} from '@zumer/snapdom';
import {Context} from '../core/context';
import {CSSParsedDeclaration} from '../css';
import {ElementContainer, FLAGS} from './element-container';
import {LIElementContainer} from './elements/li-element-container';
import {OLElementContainer} from './elements/ol-element-container';
import {SelectElementContainer} from './elements/select-element-container';
import {TextareaElementContainer} from './elements/textarea-element-container';
import {CanvasElementContainer} from './replaced-elements/canvas-element-container';
import {IFrameElementContainer} from './replaced-elements/iframe-element-container';
import {ImageElementContainer} from './replaced-elements/image-element-container';
import {InputElementContainer} from './replaced-elements/input-element-container';
import {SVGElementContainer} from './replaced-elements/svg-element-container';
import {TextContainer} from './text-container';

const LIST_OWNERS = ['OL', 'UL', 'MENU'];
// let foreignObjectRendererList: any = []
const parseNodeTree = (
    context: Context,
    node: Node,
    parent: ElementContainer,
    root: ElementContainer,
    foreignObjectRendererList: Element[]
) => {
    // console.log('parseNodeTree', context,node,parent,root)
    for (let childNode = node.firstChild, nextNode; childNode; childNode = nextNode) {
        nextNode = childNode.nextSibling;

        if (isTextNode(childNode) && childNode.data.trim().length > 0) {
            parent.textNodes.push(new TextContainer(context, childNode, parent.styles));
            if (isElementNode(node) && node.hasAttribute('foreignobjectrendering')) {
                foreignObjectRendererList.push(node);
            }
        } else if (isElementNode(childNode)) {
            if (isSlotElement(childNode) && childNode.assignedNodes) {
                childNode
                    .assignedNodes()
                    .forEach((childNode) => parseNodeTree(context, childNode, parent, root, foreignObjectRendererList));
            } else {
                const container = createContainer(context, childNode);
                // 检查当前节点或其祖先节点是否有foreignobjectrendering属性

                if (container.styles.isVisible()) {
                    if (createsRealStackingContext(childNode, container, root)) {
                        container.flags |= FLAGS.CREATES_REAL_STACKING_CONTEXT;
                    } else if (createsStackingContext(container.styles)) {
                        container.flags |= FLAGS.CREATES_STACKING_CONTEXT;
                    }
                    if (
                        isElementNode(childNode) &&
                        (childNode.hasAttribute('foreignobjectrendering') || parent.foreignobjectrendering)
                    ) {
                        container.foreignobjectrendering = true;
                    }
                    if (
                        isElementNode(childNode) &&
                        (childNode.hasAttribute('divisionDisable') || parent.divisionDisable)
                    ) {
                        container.divisionDisable = true;
                    }
                    if (LIST_OWNERS.indexOf(childNode.tagName) !== -1) {
                        container.flags |= FLAGS.IS_LIST_OWNER;
                    }
                    if (isElementNode(node) && node.hasAttribute('foreignobjectrendering')) {
                        foreignObjectRendererList.push(node);
                    }
                    // if (parent.foreignobjectrendering){
                    //     container.foreignobjectrendering = true;
                    // }
                    parent.elements.push(container);
                    childNode.slot;
                    if (childNode.shadowRoot) {
                        parseNodeTree(context, childNode.shadowRoot, container, root, foreignObjectRendererList);
                    } else if (
                        !isTextareaElement(childNode) &&
                        !isSVGElement(childNode) &&
                        !isSelectElement(childNode)
                    ) {
                        parseNodeTree(context, childNode, container, root, foreignObjectRendererList);
                    }
                }
            }
        }
    }
};

const createContainer = (context: Context, element: Element): ElementContainer => {
    if (isImageElement(element)) {
        return new ImageElementContainer(context, element);
    }

    if (isCanvasElement(element)) {
        return new CanvasElementContainer(context, element);
    }

    if (isSVGElement(element)) {
        return new SVGElementContainer(context, element);
    }

    if (isLIElement(element)) {
        return new LIElementContainer(context, element);
    }

    if (isOLElement(element)) {
        return new OLElementContainer(context, element);
    }

    if (isInputElement(element)) {
        return new InputElementContainer(context, element);
    }

    if (isSelectElement(element)) {
        return new SelectElementContainer(context, element);
    }

    if (isTextareaElement(element)) {
        return new TextareaElementContainer(context, element);
    }

    if (isIFrameElement(element)) {
        return new IFrameElementContainer(context, element);
    }

    return new ElementContainer(context, element);
};

// export const parseTree = (context: Context, element: HTMLElement): ElementContainer => {
//     const container = createContainer(context, element);
//     container.flags |= FLAGS.CREATES_REAL_STACKING_CONTEXT;
//     console.log(element,'nodedom解析')
//     parseNodeTree(context, element, container, container);
//     return container;
// };

const createsRealStackingContext = (node: Element, container: ElementContainer, root: ElementContainer): boolean => {
    return (
        container.styles.isPositionedWithZIndex() ||
        container.styles.opacity < 1 ||
        container.styles.isTransformed() ||
        (isBodyElement(node) && root.styles.isTransparent())
    );
};

// 修复1：移除全局变量，改为局部变量
export const parseTree = async (context: Context, element: HTMLElement): Promise<ElementContainer> => {
    const container = createContainer(context, element);
    container.flags |= FLAGS.CREATES_REAL_STACKING_CONTEXT;
    const foreignObjectRendererList: Element[] = [];
    // 修改 parseNodeTree 调用，传入局部列表
    parseNodeTree(context, element, container, container, foreignObjectRendererList);

    // 去重处理
    const uniqueList = foreignObjectRendererList.filter(
        (item: any, index: any, self: any) =>
            index ===
            self.findIndex((t: any) => {
                return t === item;
            })
    );

    // 并行处理所有截图
    const screenshotPromises = uniqueList.map((item: any) => renderForeignObject(item as HTMLElement));

    const screenshotResults = await Promise.all(screenshotPromises);

    // 添加所有截图到容器
    screenshotResults.forEach((bgImgSrc: {src: string} | null, index: number) => {
        if (bgImgSrc) {
            const itemNode = uniqueList[index] as HTMLElement;
            const width = itemNode.offsetWidth || itemNode.getBoundingClientRect().width || 100;
            const height = itemNode.offsetHeight || itemNode.getBoundingClientRect().height || 100;
            // const rect = itemNode.getBoundingClientRect();
            // const scrollX = window.scrollX || document.documentElement.scrollLeft;
            // const scrollY = window.scrollY || document.documentElement.scrollTop;

            // 创建图片容器
            const bgContainer = document.createElement('div');
            bgContainer.style.width = Math.ceil(width) + 'px';
            bgContainer.style.height = Math.ceil(height) + 'px';
            bgContainer.style.backgroundImage = `url(${bgImgSrc.src})`;
            bgContainer.style.backgroundSize = 'contain';
            bgContainer.style.backgroundPosition = 'center';
            bgContainer.style.backgroundRepeat = 'no-repeat';

            // 创建临时容器获取正确位置
            const tempContainer = document.createElement('div');
            tempContainer.style.position = 'absolute';
            tempContainer.style.left = '-9999px';
            tempContainer.appendChild(bgContainer);
            document.body.appendChild(tempContainer);

            const imageContainer = createContainer(context, bgContainer) as ElementContainer;

            // 设置精确位置（考虑滚动偏移）
            imageContainer.bounds.left = itemNode.offsetLeft;
            imageContainer.bounds.top = itemNode.offsetTop;
            imageContainer.bounds.width = width;
            imageContainer.bounds.height = height;
            imageContainer.flags = 0;

            // 清理临时元素
            document.body.removeChild(tempContainer);

            // 添加到容器（放在最底层）
            container.elements.unshift(imageContainer);
        }
    });

    return container;
};

const makeInvisible = async (element: Element) => {
    if (element.nodeType === Node.TEXT_NODE && element.textContent?.trim() !== '') {
        const span = document.createElement('span');
        span.style.color = 'transparent';
        span.style.backgroundColor = 'transparent';
        span.textContent = element.textContent;
        element.parentNode?.replaceChild(span, element);
    } else {
        element.childNodes.forEach(makeInvisible);
    }
};

const renderForeignObject = async (element: HTMLElement) => {
    // 复制一份node节点
    const captureElement = element as HTMLElement;

    makeInvisible(captureElement);
    // 确保元素有宽高
    const rect = captureElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        console.warn('元素宽度或高度为0，无法截图');
        return;
    }
    const capture = await snapdom(captureElement, {
        // width: Math.ceil(rect.width),
        // height: Math.ceil(rect.height)
    });
    try {
        // 导出PNG格式
        const pngData: any = await capture.toPng({
            quality: 0.1
            // width: Math.ceil(rect.width),
            // height: Math.ceil(rect.height)
        });

        // console.log(pngData, 'pngData');

        if (pngData) {
            return pngData;
        }
    } catch (error) {
        console.error('导出PNG格式失败:', error);
    }
};

// 修复3：安全截图（不修改原始 DOM）
// const renderForeignObject = async (element: HTMLElement) => {
//     // 1. 克隆元素（包括所有子元素）
//     const clone = element.cloneNode(true) as HTMLElement;

//     // 2. 创建临时容器（确保正确计算样式）
//     const container = document.createElement('div');
//     container.style.position = 'absolute';
//     container.style.left = '-9999px';
//     container.appendChild(clone);
//     document.body.appendChild(container);

//     // 3. 应用透明样式到克隆体
//     const applyInvisibleStyle = (el: Element) => {
//         if (el instanceof HTMLElement) {
//             el.style.color = 'transparent';
//             el.style.backgroundColor = 'transparent';
//             Array.from(el.children).forEach(applyInvisibleStyle);
//         }
//     };
//     applyInvisibleStyle(clone);

//     // 4. 获取尺寸
//     const rect = clone.getBoundingClientRect();
//     if (rect.width === 0 || rect.height === 0) {
//         document.body.removeChild(container);
//         return null;
//     }

//     try {
//         // 5. 截图克隆体
//         const capture = await snapdom(clone, {
//             // width: Math.ceil(rect.width),
//             // height: Math.ceil(rect.height)
//         });

//         const pngData = await capture.toPng({
//             quality: 0.9,
//             // width: Math.ceil(rect.width),
//             // height: Math.ceil(rect.height)
//         });

//         return pngData;
//     } catch (error) {
//         console.error('截图失败:', error);
//         return null;
//     } finally {
//         // 6. 确保清理临时元素
//         document.body.removeChild(container);
//     }
// };

// 修复4：移除原有的 makeInvisible 函数
// 不再需要，因为新方法使用克隆体

const createsStackingContext = (styles: CSSParsedDeclaration): boolean => styles.isPositioned() || styles.isFloating();

export const isTextNode = (node: Node): node is Text => node.nodeType === Node.TEXT_NODE;
export const isElementNode = (node: Node): node is Element => node.nodeType === Node.ELEMENT_NODE;
export const isHTMLElementNode = (node: Node): node is HTMLElement =>
    isElementNode(node) && typeof (node as HTMLElement).style !== 'undefined' && !isSVGElementNode(node);
export const isSVGElementNode = (element: Element): element is SVGElement =>
    typeof (element as SVGElement).className === 'object';
export const isLIElement = (node: Element): node is HTMLLIElement => node.tagName === 'LI';
export const isOLElement = (node: Element): node is HTMLOListElement => node.tagName === 'OL';
export const isInputElement = (node: Element): node is HTMLInputElement => node.tagName === 'INPUT';
export const isHTMLElement = (node: Element): node is HTMLHtmlElement => node.tagName === 'HTML';
export const isSVGElement = (node: Element): node is SVGSVGElement => node.tagName === 'svg';
export const isBodyElement = (node: Element): node is HTMLBodyElement => node.tagName === 'BODY';
export const isCanvasElement = (node: Element): node is HTMLCanvasElement => node.tagName === 'CANVAS';
export const isVideoElement = (node: Element): node is HTMLVideoElement => node.tagName === 'VIDEO';
export const isImageElement = (node: Element): node is HTMLImageElement => node.tagName === 'IMG';
export const isIFrameElement = (node: Element): node is HTMLIFrameElement => node.tagName === 'IFRAME';
export const isStyleElement = (node: Element): node is HTMLStyleElement => node.tagName === 'STYLE';
export const isScriptElement = (node: Element): node is HTMLScriptElement => node.tagName === 'SCRIPT';
export const isTextareaElement = (node: Element): node is HTMLTextAreaElement => node.tagName === 'TEXTAREA';
export const isSelectElement = (node: Element): node is HTMLSelectElement => node.tagName === 'SELECT';
export const isSlotElement = (node: Element): node is HTMLSlotElement => node.tagName === 'SLOT';
// https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name
export const isCustomElement = (node: Element): node is HTMLElement => node.tagName.indexOf('-') > 0;
