export function isEmptyValue(obj: unknown): boolean {
    if (obj === undefined) {
        return true;
    } else if (obj === null) {
        return true;
    } else if (obj === false) {
        return true;
    } else if (obj === '') {
        return true;
    } else if (isArray(obj) && obj.length === 0) {
        return true;
    } else if (isObject(obj) && JSON.stringify(obj) === '{}') {
        return true;
    } else {
        return false;
    }
}

export function isArray(obj: unknown): obj is Array<unknown> {
    return Object.prototype.toString.call(obj) === '[object Array]';
}

export function isObject(obj: unknown): obj is Record<string, unknown> {
    return Object.prototype.toString.call(obj) === '[object Object]';
}
export function isFunction(fn: unknown): fn is (...args: unknown[]) => unknown {
    return typeof fn === 'function';
}
