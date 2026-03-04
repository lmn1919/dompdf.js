import {isArray, isObject} from './type-utils';
export interface FontConfig {
    fontFamily: string;
    fontBase64: string;
    fontStyle: string;
    fontWeight: 400 | 700;
    iconFont?: boolean;
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
