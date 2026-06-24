/**
 * Page size presets. Width/height in pt (1/72 inch).
 *
 * Values are derived from dompdf.js page_sizes.md (which lists px at 96 dpi):
 * px * 0.75 = pt. Portrait orientation; [width, height].
 */
/** [widthPt, heightPt] for each named page size. */
export const PAGE_SIZES = {
    a0: [2384.25, 3370.5],
    a1: [1683.75, 2384.25],
    a2: [1190.25, 1683.75],
    a3: [842.25, 1190.25],
    a4: [595.5, 842.25],
    a5: [419.25, 595.5],
    a6: [297.75, 419.25],
    a7: [210, 297.75],
    a8: [147.75, 210],
    a9: [105, 147.75],
    a10: [73.5, 105],
    b0: [2835, 4008],
    b1: [2004, 2835],
    b2: [1417.5, 2004],
    b3: [1000.5, 1417.5],
    b4: [708.75, 1000.5],
    b5: [498.75, 708.75],
    b6: [354, 498.75],
    b7: [249.75, 354],
    b8: [175.5, 249.75],
    b9: [124.5, 175.5],
    b10: [87.75, 124.5],
    c0: [2599.5, 3676.5],
    c1: [1836.75, 2599.5],
    c2: [1298.25, 1836.75],
    c3: [918.75, 1298.25],
    c4: [648.75, 918.75],
    c5: [459, 648.75],
    c6: [323.25, 459],
    c7: [229.5, 323.25],
    c8: [161.25, 229.5],
    c9: [113.25, 161.25],
    c10: [79.5, 113.25],
    letter: [612, 792],
    'government-letter': [576, 756],
    legal: [612, 1008],
    'junior-legal': [360, 576],
    tabloid: [792, 1224],
    ledger: [1224, 792],
    'government-legal': [612, 936],
};
/** Resolve a format name (or [w,h] array) to [widthPt, heightPt]. Default a4. */
export function resolvePageSize(format) {
    if (Array.isArray(format) && format.length === 2) {
        return [format[0], format[1]];
    }
    if (typeof format === 'string') {
        const key = format.toLowerCase();
        if (PAGE_SIZES[key])
            return PAGE_SIZES[key];
    }
    return PAGE_SIZES.a4;
}
//# sourceMappingURL=pageSizes.js.map