import type {ElementContainer} from '../dom/element-container';
import {isArray} from './type-utils';
/**
 * Recursively traverse the nodes and check whether the textNodes of all levels are empty arrays
 * @param {ElementContainer} node
 * @returns {boolean} - If all textNodes are empty, return true; otherwise, return false
 */
export function checkAllTextNodesEmpty(node: ElementContainer): boolean {
    if (!isArray(node.textNodes) || node.textNodes.length > 0) {
        return false;
    }
    if (isArray(node.elements)) {
        for (const child of node.elements) {
            if (!checkAllTextNodesEmpty(child)) {
                return false;
            }
        }
    }
    return true;
}
