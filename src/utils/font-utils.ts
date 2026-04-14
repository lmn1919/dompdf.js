import {isArray, isObject} from './type-utils';
export interface FontConfig {
    fontFamily: string;
    fontBase64: string;
    fontStyle: string;
    fontWeight: 400 | 700;
    iconFont?: boolean;
    // 字符 Unicode 范围，指定该字体负责哪些字符区间
    // 例如 [[0x4E00, 0x9FFF]] 表示中文 CJK 区间
    charRange?: [number, number][];
    // 标记为默认字体，用于不匹配任何 charRange 的字符
    isDefault?: boolean;
}

// check fontConfig object structure and types
export function validateFontConfig(fontConfig: FontConfig | FontConfig[] | undefined): boolean {
    if (fontConfig === undefined) {
        return false;
    }

    const configList: FontConfig[] = isArray(fontConfig) ? fontConfig : [fontConfig as FontConfig];

    for (const config of configList) {
        if (!isObject(config) || config === null) {
            return false;
        }

        const requiredFields: Array<{key: keyof FontConfig; type: string}> = [
            {key: 'fontFamily', type: 'string'},
            {key: 'fontBase64', type: 'string'},
            {key: 'fontStyle', type: 'string'},
            {key: 'fontWeight', type: 'number'}
        ];

        for (const {key, type} of requiredFields) {
            if (!(key in config)) {
                console.error(`The font configuration is missing required fields: ${key}`);
                return false;
            }

            if (typeof config[key] !== type) {
                console.error(
                    `The field ${key} has a type error. Expected ${type}, but received ${typeof config[key]}`
                );
                return false;
            }
        }

        // check：fontWeight is only 400 or 700
        if (![400, 700].includes(config.fontWeight)) {
            console.error(
                `The fontWeight value is invalid. It can only be 400 or 700. Actual value:${config.fontWeight}`
            );
            return false;
        }
        if (config.iconFont !== undefined && typeof config.iconFont !== 'boolean') {
            console.error(
                `The field iconFont has a type error. Expected boolean, but received ${typeof config.iconFont}`
            );
            return false;
        }

        // check: charRange must be array of [start, end] tuples
        if (config.charRange !== undefined) {
            if (!isArray(config.charRange)) {
                console.error(`The field charRange must be an array. Actual type: ${typeof config.charRange}`);
                return false;
            }
            for (const range of config.charRange) {
                if (!isArray(range) || range.length !== 2) {
                    console.error(`Each charRange item must be [start, end] tuple. Actual: ${JSON.stringify(range)}`);
                    return false;
                }
                if (typeof range[0] !== 'number' || typeof range[1] !== 'number') {
                    console.error(`charRange values must be numbers. Actual: ${JSON.stringify(range)}`);
                    return false;
                }
                if (range[0] > range[1]) {
                    console.error(`charRange start must be <= end. Actual: ${JSON.stringify(range)}`);
                    return false;
                }
            }
        }

        // check: default must be boolean
        if (config.default !== undefined && typeof config.default !== 'boolean') {
            console.error(
                `The field default has a type error. Expected boolean, but received ${typeof config.default}`
            );
            return false;
        }
    }

    return true;
}

// The core function for handling configuration and populating default values
export function setOptionFontConfig(rawConfig: FontConfig | FontConfig[] | undefined): FontConfig[] | undefined {
    if (!validateFontConfig(rawConfig)) {
        return undefined;
    }

    const configList: FontConfig[] = isArray(rawConfig) ? rawConfig : [rawConfig as FontConfig];

    const processedList = configList.map((config) => ({
        ...config,
        iconFont: config.iconFont ?? false
    }));
    return processedList;
}
