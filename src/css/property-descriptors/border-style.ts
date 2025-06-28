// 导入必要的类型定义
import { Context } from '../../core/context';
import { IPropertyIdentValueDescriptor, PropertyDescriptorParsingType } from '../IPropertyDescriptor';

// 定义边框样式的枚举类型
export const enum BORDER_STYLE {
    NONE = 0,    // 无边框
    SOLID = 1,   // 实线边框
    DASHED = 2,  // 虚线边框
    DOTTED = 3,  // 点线边框
    DOUBLE = 4   // 双线边框
}

// 创建边框样式描述符的工厂函数
const borderStyleForSide = (side: string): IPropertyIdentValueDescriptor<BORDER_STYLE> => ({
    name: `border-${side}-style`,  // 属性名称
    initialValue: 'solid',         // 初始值为实线
    prefix: false,                 // 不需要浏览器前缀
    type: PropertyDescriptorParsingType.IDENT_VALUE,  // 标识符类型的值
    parse: (_context: Context, style: string): BORDER_STYLE => {
        // 解析边框样式字符串为枚举值
        switch (style) {
            case 'none':
                return BORDER_STYLE.NONE;
            case 'dashed':
                return BORDER_STYLE.DASHED;
            case 'dotted':
                return BORDER_STYLE.DOTTED;
            case 'double':
                return BORDER_STYLE.DOUBLE;
        }
        return BORDER_STYLE.SOLID;  // 默认返回实线样式
    }
});

// 导出四个方向的边框样式描述符
export const borderTopStyle: IPropertyIdentValueDescriptor<BORDER_STYLE> = borderStyleForSide('top');
export const borderRightStyle: IPropertyIdentValueDescriptor<BORDER_STYLE> = borderStyleForSide('right');
export const borderBottomStyle: IPropertyIdentValueDescriptor<BORDER_STYLE> = borderStyleForSide('bottom');
export const borderLeftStyle: IPropertyIdentValueDescriptor<BORDER_STYLE> = borderStyleForSide('left');
