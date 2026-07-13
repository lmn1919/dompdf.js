# Page Size Reference

The table below lists common page sizes used by `dompdf.js`.

- `pt`: PDF points, where `1pt = 1/72in`
- `px @ 96 DPI`: convenient CSS width/height reference for HTML containers
- For pagination, matching the container width to the target page width in CSS pixels usually gives the most stable result

| Name | Width (pt) | Height (pt) | Width (px @ 96 DPI) | Height (px @ 96 DPI) |
| --- | ---: | ---: | ---: | ---: |
| a4 | 595.5 | 842.25 | 794 | 1123 |
| a3 | 842.25 | 1190.25 | 1123 | 1587 |
| a5 | 419.25 | 595.5 | 559 | 794 |
| letter | 612 | 792 | 816 | 1056 |
| legal | 612 | 1008 | 816 | 1344 |
| tabloid | 792 | 1224 | 1056 | 1632 |

For the full preset list, see [`src/pageSizes.ts`](./src/pageSizes.ts).
