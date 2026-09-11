(function () {
  /* ========================= Globals ========================= */
  var api = window.dompdf;
  var markedApi = window.marked;
  var purifier = window.DOMPurify;

  var statusDotEl = document.getElementById('status-dot');
  var statusTextEl = document.getElementById('status-text');
  var topLoadingOverlayEl = document.getElementById('top-loading-overlay');
  var topLoadingTextEl = document.getElementById('top-loading-text');
  var docEl = document.getElementById('document');
  var topbarPageInfo = document.getElementById('topbar-page-info');
  var benchmarkMetaEl = document.getElementById('benchmark-meta');
  var benchmarkCompressLabelEl = document.getElementById('benchmark-compress-label');
  var benchmarkCompressToggleEl = document.getElementById('benchmark-compress-toggle');

  var html2pdfLoader = null;
  var pdfJsLoader = null;
  var pdfJsReady = false;
  var activeTab = 'basic';

  var LOCALE_STORAGE_KEY = 'dompdf-studio-locale';
  var currentLocale = getSavedLocale();
  var benchmarkMode = 'light';
  var benchmarkCompressEnabled = true;
  var benchmarkBuildVersion = 0;
  var benchmarkBuildPromise = Promise.resolve();
  var benchmarkBuildInProgress = false;
  var originalStaticContent = Object.create(null);
  var staticContentCaptured = false;

  /* Font configs */
  var sharedFontConfig = {
    fontFamily: 'SourceHanSansSC-Regular',
    fontStyle: 'normal',
    fontWeight: 400
  };
  var symbolFontConfig = null;

  /* Comparison state */
  var generatedBlobs = { dompdf: null, html2pdf: null };

  /* Markdown editor */
  var vditor = null;
  var vditorCdnBase = './vendor/vditor';
  var mdRenderTimer = 0;
  var activeTheme = 'paper';
  var I18N = {
    en: {
      themeLabels: {
        paper: 'Paper Light',
        midnight: 'Midnight Blue',
        slate: 'Slate Editorial',
        sepia: 'Sepia Notebook'
      },
      mdSample: [
        "# Product Weekly Update",
        "",
        "> This sample verifies live Markdown rendering, theme switching, and copyable paginated text after PDF export.",
        "",
        "## Weekly Summary",
        "",
        "- New-user registration conversion increased by **12.6%**",
        "- First support response time dropped from `7m 24s` to `4m 10s`",
        "- Documentation site migration is complete; export stress testing remains",
        "",
        "## Key Work",
        "",
        "1. Finish field mapping from rich text to Markdown.",
        "2. Unify PDF headers and footers into configurable templates.",
        "3. Validate CJK font export quality under dark themes.",
        "",
        "## Task List",
        "",
        "- [x] Enable live preview",
        "- [x] Support multi-theme switching",
        "- [ ] Add more business templates",
        "",
        "## Code Snippet",
        "",
        "```ts",
        "const blob = await window.dompdf(previewRoot, {",
        "  format: 'a4',",
        "  pagination: true,",
        "  useCORS: true",
        "});",
        "```",
        "",
        "## Comparison Table",
        "",
        "| Metric | Current | Delta |",
        "| --- | ---: | ---: |",
        "| WAU | 124,500 | +8.4% |",
        "| Renewal Rate | 71.2% | +2.1% |",
        "| Average Export Time | 428ms | -16.0% |",
        "",
        "## Notes",
        "",
        "Once Markdown is rendered into HTML, the preview panel on the right becomes the exact DOM exported to PDF."
      ].join("\n"),
      runtime: {
        processing: 'Processing...',
        parsingPage: 'Parsing page...',
        countingPages: function (totalPages) {
          return totalPages ? ('Counting total pages... ' + totalPages + ' pages') : 'Counting total pages...';
        },
        renderingPdf: function (currentPage, totalPages) {
          if (currentPage && totalPages) return 'Rendering PDF... page ' + currentPage + ' / ' + totalPages;
          if (totalPages) return 'Rendering PDF... ' + totalPages + ' pages total';
          return 'Rendering PDF...';
        },
        benchmarkCompressOn: 'On',
        benchmarkCompressOff: 'Off',
        benchmarkMeta: function (mode, compressEnabled, building) {
          var suffix = compressEnabled ? ' · Compression on' : ' · Compression off';
          if (mode === 'light') return 'Current mode: lightweight benchmark · 1 short text group' + suffix;
          if (mode === 'extreme') return (building
            ? 'Current mode: 10,000-page test · generating 8,940 ultra-long text groups'
            : 'Current mode: 10,000-page test · 8,940 ultra-long text groups') + suffix;
          return 'Current mode: heavy benchmark · 440 ultra-long text groups' + suffix;
        },
        fontNotReady: 'Chinese font is still loading. Please try again shortly.',
        markdownLoading: 'Markdown resources are still loading. Please wait...',
        buildExtreme: 'Building the 10,000-page sample...',
        rebuildBenchmark: 'Rebuilding benchmark sample...',
        extremeReady: '10,000-page sample is ready',
        benchmarkReady: 'Benchmark sample updated',
        toolbarDisabledTitle: 'Chinese font is loading. Please wait...',
        dompdfRunning: 'Running dompdf.js...',
        html2pdfRunning: 'Running html2pdf.js...',
        compareDompdf: 'Comparing dompdf.js...',
        compareHtml2pdf: 'Comparing html2pdf.js...',
        dompdfDone: function (duration, size) {
          return 'dompdf.js export complete · ' + duration + ' · ' + size;
        },
        html2pdfDone: function (duration, size, blankPdfSuspected) {
          return 'html2pdf.js export complete · ' + duration + ' · ' + size + (blankPdfSuspected ? ' · suspected blank PDF' : '');
        },
        compareDone: 'Comparison complete',
        compareDoneBlank: 'Comparison complete · html2pdf.js may be blank',
        blankPdfNote: ' (suspected blank PDF)',
        speedFaster: function (ratio) { return 'dompdf.js is ' + ratio.toFixed(1) + 'x faster'; },
        speedSlower: function (ratio) { return 'html2pdf.js is ' + ratio.toFixed(1) + 'x faster'; },
        sizeReduced: function (pct) { return 'dompdf.js reduces file size by ' + pct.toFixed(1) + '%'; },
        sizeIncreased: function (pct) { return 'dompdf.js increases file size by ' + pct.toFixed(1) + '%'; },
        approxDocPages: function (pages) { return 'Approx. ' + pages + ' pages'; },
        markdownDepsFailed: 'Failed to load Markdown dependencies',
        markdownPlaceholder: 'Start typing Markdown here...',
        markdownChars: function (count) { return count + ' chars'; },
        markdownWords: function (count) { return count + ' words'; },
        markdownLines: function (count) { return count + ' lines'; },
        markdownPages: function (count) { return 'Approx. ' + count + ' pages'; },
        missingBuild: 'dist/dompdf.js not found. Run npm run build first.',
        loadingResources: 'Loading fonts and editor assets...',
        ready: 'ready',
        readyWithSymbol: 'ready (symbol font loaded)',
        fontWarning: function (message) { return 'Font loading warning: ' + message; },
        exportHeader: 'dompdf.js Studio Demo',
        exportFooter: 'Page ${currentPage} / ${totalPages}',
        chartTitle: 'Small raster sample',
        chartSubtitle: 'Used only to validate image embedding and compression.'
      },
      tableGroups: [
        {
          group: 'Foundation / Design Tokens',
          statusText: 'Stable',
          statusClass: 'is-good',
          rows: [
            ['92%', '4.8', '96%', '4.9'],
            ['88%', '4.6', '91%', '4.7']
          ]
        },
        {
          group: 'Components / Web',
          statusText: 'Stable',
          statusClass: 'is-good',
          rows: [
            ['85%', '4.5', '89%', '4.6'],
            ['79%', '4.2', '84%', '4.4']
          ]
        },
        {
          group: 'Components / Mobile',
          statusText: 'On Track',
          statusClass: 'is-stable',
          rows: [
            ['74%', '4.1', '81%', '4.3'],
            ['68%', '3.9', '75%', '4.1']
          ]
        },
        {
          group: 'Patterns / Layout',
          statusText: 'Review',
          statusClass: 'is-watch',
          rows: [
            ['65%', '3.8', '72%', '4.0'],
            ['58%', '3.6', '66%', '3.8']
          ]
        }
      ],
      longList: {
        light: 'This lightweight appendix intentionally keeps the list short so you can evaluate raw pagination throughput while keeping text shaping, wrapping, and compression costs moderate.',
        heavy: ('This appendix intentionally repeats a realistic design-system rollout paragraph to stress the PDF pipeline with sustained multilingual text flow, mixed CJK and Latin scripts, repeated clauses, and business-style wording. It helps expose pagination breakpoints, line breaking, glyph mapping, text extraction order, copy and search behavior, and final file size differences across many repeated blocks; the goal is not decorative content but a wall of text that behaves like product specifications, implementation notes, adoption summaries, and design-review minutes merged into one continuous narrative, pushing the layout engine to preserve semantic reading order, stable wrapping, predictable page boundaries, and compact vector-first output instead of falling back to page-sized bitmap capture. ').repeat(3).trim()
      }
    },
    zh: {
      themeLabels: {
        paper: 'Paper Light',
        midnight: 'Midnight Blue',
        slate: 'Slate Editorial',
        sepia: 'Sepia Notebook'
      },
      mdSample: [
        "# 产品周报 / Product Weekly Update",
        "",
        "> 本示例用于验证 Markdown 实时渲染、主题切换，以及导出 PDF 后的文本复制与分页效果。",
        "",
        "## 本周结论",
        "",
        "- 新版本注册转化率提升 **12.6%**",
        "- 客服首响时间从 `7m 24s` 降到 `4m 10s`",
        "- 文档站迁移已完成，剩余导出链路压测",
        "",
        "## 关键事项",
        "",
        "1. 完成富文本转 Markdown 的字段映射。",
        "2. 把 PDF 页眉页脚统一成可配置模板。",
        "3. 校验中文字体在深色主题下的导出表现。",
        "",
        "## 任务列表",
        "",
        "- [x] 接入实时预览",
        "- [x] 支持多主题样式切换",
        "- [ ] 增加更多业务模板",
        "",
        "## 代码片段",
        "",
        "```ts",
        "const blob = await window.dompdf(previewRoot, {",
        "  format: 'a4',",
        "  pagination: true,",
        "  useCORS: true",
        "});",
        "```",
        "",
        "## 对比表",
        "",
        "| 指标 | 当前值 | 环比 |",
        "| --- | ---: | ---: |",
        "| WAU | 124,500 | +8.4% |",
        "| 续费率 | 71.2% | +2.1% |",
        "| 平均导出耗时 | 428ms | -16.0% |",
        "",
        "## 备注",
        "",
        "当 Markdown 被渲染成 HTML 后，右侧预览区就是最终导出的 DOM 来源。"
      ].join("\n"),
      runtime: {
        processing: '正在处理中...',
        parsingPage: '正在解析页面...',
        countingPages: function (totalPages) {
          return totalPages ? ('正在计算总页数... 共 ' + totalPages + ' 页') : '正在计算总页数...';
        },
        renderingPdf: function (currentPage, totalPages) {
          if (currentPage && totalPages) return '正在生成 PDF... 第 ' + currentPage + ' / ' + totalPages + ' 页';
          if (totalPages) return '正在生成 PDF... 共 ' + totalPages + ' 页';
          return '正在生成 PDF...';
        },
        benchmarkCompressOn: '开启',
        benchmarkCompressOff: '关闭',
        benchmarkMeta: function (mode, compressEnabled, building) {
          var suffix = compressEnabled ? ' · 压缩开启' : ' · 压缩关闭';
          if (mode === 'light') return '当前模式：轻量基准 ·1 组短文本' + suffix;
          if (mode === 'extreme') return (building
            ? '当前模式：10000页测试 · 正在生成 8940 组超长文本'
            : '当前模式：10000页测试 · 8940 组超长文本') + suffix;
          return '当前模式：重压测 · 440 组超长文本' + suffix;
        },
        fontNotReady: '中文字体尚未加载完成，请稍后重试',
        markdownLoading: 'Markdown 编辑器资源尚未加载完成，请稍候…',
        buildExtreme: '正在生成 10000 页测试样本...',
        rebuildBenchmark: '正在重建基准样本...',
        extremeReady: '10000 页测试样本已显示',
        benchmarkReady: '基准样本已更新',
        toolbarDisabledTitle: '中文字体加载中，请稍候…',
        dompdfRunning: '运行 dompdf.js...',
        html2pdfRunning: '运行 html2pdf.js...',
        compareDompdf: '正在对比 dompdf.js...',
        compareHtml2pdf: '正在对比 html2pdf.js...',
        dompdfDone: function (duration, size) {
          return 'dompdf.js 导出完成 · ' + duration + ' · ' + size;
        },
        html2pdfDone: function (duration, size, blankPdfSuspected) {
          return 'html2pdf.js 导出完成 · ' + duration + ' · ' + size + (blankPdfSuspected ? ' · 疑似空白PDF' : '');
        },
        compareDone: '对比完成',
        compareDoneBlank: '对比完成 · html2pdf.js 疑似空白PDF',
        blankPdfNote: '（疑似空白PDF）',
        speedFaster: function (ratio) { return '⚡ dompdf.js 快了 ' + ratio.toFixed(1) + ' 倍'; },
        speedSlower: function (ratio) { return 'html2pdf 快了 ' + ratio.toFixed(1) + ' 倍'; },
        sizeReduced: function (pct) { return '📉 dompdf.js 体积缩减 ' + pct.toFixed(1) + '%'; },
        sizeIncreased: function (pct) { return '📈 dompdf.js 体积增加 ' + pct.toFixed(1) + '%'; },
        approxDocPages: function (pages) { return '总计约 ' + pages + ' 页'; },
        markdownDepsFailed: 'Markdown 依赖加载失败',
        markdownPlaceholder: '在此开始输入 Markdown 内容...',
        markdownChars: function (count) { return count + ' 字符'; },
        markdownWords: function (count) { return count + ' 词'; },
        markdownLines: function (count) { return count + ' 行'; },
        markdownPages: function (count) { return '约 ' + count + ' 页'; },
        missingBuild: 'dist/dompdf.js 未找到，请先执行 npm run build。',
        loadingResources: '正在加载字体与编辑器资源...',
        ready: '就绪',
        readyWithSymbol: '就绪（符号字体已加载）',
        fontWarning: function (message) { return '字体加载警告: ' + message; },
        exportHeader: 'dompdf.js Studio Demo',
        exportFooter: '第 ${currentPage} 页 / 共 ${totalPages} 页',
        chartTitle: '小位图保留样本',
        chartSubtitle: '用于验证图片嵌入与压缩链路。',
      },
      tableGroups: [
        {
          group: '基础 / 设计令牌',
          statusText: '已稳定',
          statusClass: 'is-good',
          rows: [
            ['92%', '4.8', '96%', '4.9'],
            ['88%', '4.6', '91%', '4.7']
          ]
        },
        {
          group: '组件 / Web',
          statusText: '已稳定',
          statusClass: 'is-good',
          rows: [
            ['85%', '4.5', '89%', '4.6'],
            ['79%', '4.2', '84%', '4.4']
          ]
        },
        {
          group: '组件 / 移动端',
          statusText: '推进中',
          statusClass: 'is-stable',
          rows: [
            ['74%', '4.1', '81%', '4.3'],
            ['68%', '3.9', '75%', '4.1']
          ]
        },
        {
          group: '模式 / 布局',
          statusText: '需评审',
          statusClass: 'is-watch',
          rows: [
            ['65%', '3.8', '72%', '4.0'],
            ['58%', '3.6', '66%', '3.8']
          ]
        }
      ],
      longList: {
        light: '这个轻量附录会把列表控制得较短，方便你评估原始分页吞吐，同时不会过度放大文本塑形、换行和压缩成本。',
        heavy: ('这段附录会故意重复一段贴近设计系统落地的正文，持续向 PDF 管线施加多语言文本流压力：它包含中英混排、重复从句、密集标点和业务化措辞，用来观察分页切点、换行、字形映射、文本提取顺序、复制检索行为以及最终文件体积差异；目标不是装饰性的内容，而是一堵接近产品规范、实施备注、采用总结和设计评审记录的文字墙，推动排版引擎保持语义阅读顺序、稳定换行、可预测页边界和紧凑矢量输出，而不是退化为更容易随文档长度暴涨的整页位图捕获。 ').repeat(5).trim()
      }
    }
  };
  var themeLabels = I18N[currentLocale].themeLabels;
  var mdSamples = { default: I18N[currentLocale].mdSample };
  var STATIC_TRANSLATIONS = [
    { key: 'title', type: 'title', en: 'dompdf.js Studio - Pure JavaScript DOM-to-PDF Engine | Live Demo' },
    { key: 'meta-description', selector: 'meta[name="description"]', type: 'attr', attr: 'content', en: 'dompdf.js is a pure JavaScript DOM-to-PDF renderer with no backend required. This live demo supports HTML and Markdown editing, real-time PDF preview, and high-fidelity multilingual export.' },
    { key: 'meta-keywords', selector: 'meta[name="keywords"]', type: 'attr', attr: 'content', en: 'dompdf.js, DOM to PDF, JavaScript PDF, frontend PDF generation, HTML to PDF, live PDF editor' },
    { key: 'og-title', selector: 'meta[property="og:title"]', type: 'attr', attr: 'content', en: 'dompdf.js Studio - Pure JavaScript DOM-to-PDF Engine' },
    { key: 'og-description', selector: 'meta[property="og:description"]', type: 'attr', attr: 'content', en: 'A browser-side DOM-to-PDF rendering engine with HTML and Markdown editing plus real-time PDF preview.' },
    { key: 'twitter-title', selector: 'meta[name="twitter:title"]', type: 'attr', attr: 'content', en: 'dompdf.js Studio - Pure JavaScript DOM-to-PDF Engine' },
    { key: 'twitter-description', selector: 'meta[name="twitter:description"]', type: 'attr', attr: 'content', en: 'A browser-side DOM-to-PDF rendering engine with HTML and Markdown editing plus real-time PDF preview.' },
    {
      key: 'schema', selector: 'script[type="application/ld+json"]', type: 'text', en: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'dompdf.js',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Web',
        description: 'Pure JavaScript DOM-to-PDF rendering engine',
        url: 'https://dompdfjs.lisky.com.cn/'
      }, null, 2)
    },
    { key: 'github-aria', selector: '.sidebar-github-link', type: 'attr', attr: 'aria-label', en: 'View the dompdf.js GitHub repository' },
    { key: 'export-dompdf', selector: '#btn-export-dompdf .btn-label', type: 'text', en: 'Export dompdf.js' },
    { key: 'export-html2pdf', selector: '#btn-export-html2pdf .btn-label', type: 'text', en: 'Export html2pdf.js' },
    { key: 'compare-btn', selector: '#btn-compare .btn-label', type: 'text', en: 'Run Performance Comparison' },
    { key: 'section-benchmark-title', selector: '#sidebar-benchmark-section .sidebar-section-title', type: 'text', en: 'Page Count' },
    { key: 'compare-result-title', selector: '.sidebar-section:nth-of-type(3) .sidebar-section-title', type: 'text', en: 'Comparison Results' },
    { key: 'benchmark-compress-strong', selector: '.benchmark-toggle-copy strong', type: 'text', en: 'dompdf Compression' },
    { key: 'speed-dompdf-label', selector: '#speed-dompdf', type: 'attr', attr: 'data-placeholder', en: '--' },
    { key: 'metric-time-dompdf', selector: '#label-speed-dompdf', type: 'text', en: 'dompdf.js Time' },
    { key: 'metric-time-html2pdf', selector: '#label-speed-html2pdf', type: 'text', en: 'html2pdf.js Time' },
    { key: 'metric-size-dompdf', selector: '#label-size-dompdf', type: 'text', en: 'dompdf.js Size' },
    { key: 'metric-size-html2pdf', selector: '#label-size-html2pdf', type: 'text', en: 'html2pdf.js Size' },
    { key: 'footer-tab-specs', selector: '#footer-tab-specs', type: 'text', en: 'Engine Specs' },
    { key: 'footer-tab-code', selector: '#footer-tab-code', type: 'text', en: 'Quick Start Code' },
    { key: 'specs-head-1', selector: '.specs-mini-table thead th:nth-child(1)', type: 'text', en: 'Category' },
    { key: 'specs-head-2', selector: '.specs-mini-table thead th:nth-child(2)', type: 'text', en: 'dompdf.js' },
    { key: 'specs-head-3', selector: '.specs-mini-table thead th:nth-child(3)', type: 'text', en: 'html2pdf' },
    { key: 'specs-row-1-1', selector: '.specs-mini-table tbody tr:nth-child(1) td:nth-child(1)', type: 'text', en: 'Engine' },
    { key: 'specs-row-1-2', selector: '.specs-mini-table tbody tr:nth-child(1) td:nth-child(2)', type: 'text', en: 'Rust + WASM' },
    { key: 'specs-row-1-3', selector: '.specs-mini-table tbody tr:nth-child(1) td:nth-child(3)', type: 'text', en: 'html2canvas' },
    { key: 'specs-row-2-1', selector: '.specs-mini-table tbody tr:nth-child(2) td:nth-child(1)', type: 'text', en: 'Output' },
    { key: 'specs-row-2-2', selector: '.specs-mini-table tbody tr:nth-child(2) td:nth-child(2)', type: 'text', en: 'Native vector PDF instructions' },
    { key: 'specs-row-2-3', selector: '.specs-mini-table tbody tr:nth-child(2) td:nth-child(3)', type: 'text', en: 'Embedded bitmap canvases' },
    { key: 'specs-row-3-1', selector: '.specs-mini-table tbody tr:nth-child(3) td:nth-child(1)', type: 'text', en: 'Text Search' },
    { key: 'specs-row-3-2', selector: '.specs-mini-table tbody tr:nth-child(3) td:nth-child(2)', type: 'text', en: 'Selectable, copyable, searchable' },
    { key: 'specs-row-3-3', selector: '.specs-mini-table tbody tr:nth-child(3) td:nth-child(3)', type: 'text', en: 'Not selectable at all' },
    { key: 'specs-row-4-1', selector: '.specs-mini-table tbody tr:nth-child(4) td:nth-child(1)', type: 'text', en: 'Scaling Quality' },
    { key: 'specs-row-4-2', selector: '.specs-mini-table tbody tr:nth-child(4) td:nth-child(2)', type: 'text', en: 'Lossless vector scaling' },
    { key: 'specs-row-4-3', selector: '.specs-mini-table tbody tr:nth-child(4) td:nth-child(3)', type: 'text', en: 'Blurred bitmap stretching' },
    { key: 'specs-row-5-1', selector: '.specs-mini-table tbody tr:nth-child(5) td:nth-child(1)', type: 'text', en: 'Pagination' },
    { key: 'specs-row-5-2', selector: '.specs-mini-table tbody tr:nth-child(5) td:nth-child(2)', type: 'text', en: 'Native pagination (line-height aware)' },
    { key: 'specs-row-5-3', selector: '.specs-mini-table tbody tr:nth-child(5) td:nth-child(3)', type: 'text', en: 'Canvas slicing and stitching' },
    { key: 'specs-row-6-1', selector: '.specs-mini-table tbody tr:nth-child(6) td:nth-child(1)', type: 'text', en: 'First Render Cost' },
    { key: 'specs-row-6-2', selector: '.specs-mini-table tbody tr:nth-child(6) td:nth-child(2)', type: 'text', en: 'Includes WASM startup cost' },
    { key: 'specs-row-6-3', selector: '.specs-mini-table tbody tr:nth-child(6) td:nth-child(3)', type: 'text', en: 'Runs directly on the main thread' },
    { key: 'specs-row-7-1', selector: '.specs-mini-table tbody tr:nth-child(7) td:nth-child(1)', type: 'text', en: 'Performance Bottleneck' },
    { key: 'specs-row-7-2', selector: '.specs-mini-table tbody tr:nth-child(7) td:nth-child(2)', type: 'text', en: 'Bound by WASM compute throughput' },
    { key: 'specs-row-7-3', selector: '.specs-mini-table tbody tr:nth-child(7) td:nth-child(3)', type: 'text', en: 'Large image-heavy DOMs fail easily' },
    { key: 'tab-basic', selector: '#tab-btn-basic', type: 'text', en: 'Capability Report' },
    { key: 'tab-markdown', selector: '#tab-btn-markdown', type: 'text', en: 'Markdown Editor' },
    { key: 'header-a4', selector: '.header-info span:first-child', type: 'text', en: 'A4 Page Simulation (794px \u00d7 1123px)' },
    { key: 'header-zoom', selector: '.header-info span:last-child', type: 'text', en: 'Zoom 100%' },
    { key: 'top-loading-aria', selector: '.top-loading-card', type: 'attr', attr: 'aria-label', en: 'Export progress' },

    /* Hero */
    { key: 'hero-eyebrow', selector: '#hero-eyebrow', type: 'text', en: 'Global Product Design Spec' },
    { key: 'hero-title', selector: '#hero-title', type: 'text', en: 'Orbit Design System International Delivery Spec' },
    { key: 'hero-lede', selector: '#hero-lede', type: 'text', en: 'This example uses a fictional global product design spec to cover real document scenarios such as mixed Chinese and English text, color systems, SVG icons, component states, structured tables, form controls, code formulas, and pagination protection. It fully verifies dompdf.js vector rendering, text copyability, and multilingual typesetting when converting front-end DOM to PDF.' },
    { key: 'hero-pill-1', selector: '#hero-pills .ds-pill:nth-child(1)', type: 'text', en: 'Chinese-English Mix' },
    { key: 'hero-pill-2', selector: '#hero-pills .ds-pill:nth-child(2)', type: 'text', en: 'Vector SVG' },
    { key: 'hero-pill-3', selector: '#hero-pills .ds-pill:nth-child(3)', type: 'text', en: 'Structured Tables' },
    { key: 'hero-pill-4', selector: '#hero-pills .ds-pill:nth-child(4)', type: 'text', en: 'Form Controls' },
    { key: 'hero-pill-5', selector: '#hero-pills .ds-pill:nth-child(5)', type: 'text', en: 'Math Formulas' },
    { key: 'hero-pill-6', selector: '#hero-pills .ds-pill:nth-child(6)', type: 'text', en: 'Pagination Guard' },
    { key: 'meta-doc-label', selector: '#meta-doc-label', type: 'text', en: 'Document ID' },
    { key: 'meta-version-label', selector: '#meta-version-label', type: 'text', en: 'Version' },
    { key: 'meta-owner-label', selector: '#meta-owner-label', type: 'text', en: 'Owner' },
    { key: 'meta-scope-label', selector: '#meta-scope-label', type: 'text', en: 'Scope' },

    /* KPI */
    { key: 'kpi-1-label', selector: '#kpi-1-label', type: 'text', en: 'Components' },
    { key: 'kpi-1-desc', selector: '#kpi-1-desc', type: 'text', en: 'Covers buttons, inputs, feedback, navigation, and data display categories.' },
    { key: 'kpi-2-label', selector: '#kpi-2-label', type: 'text', en: 'Design Tokens' },
    { key: 'kpi-2-desc', selector: '#kpi-2-desc', type: 'text', en: 'Colors, spacing, typography, radii, and shadows are fully parameterized.' },
    { key: 'kpi-3-label', selector: '#kpi-3-label', type: 'text', en: 'Languages' },
    { key: 'kpi-3-desc', selector: '#kpi-3-desc', type: 'text', en: 'Includes Chinese, English, and RTL layout experiments.' },
    { key: 'kpi-4-label', selector: '#kpi-4-label', type: 'text', en: 'Export Mode' },
    { key: 'kpi-4-desc', selector: '#kpi-4-desc', type: 'text', en: 'Text and SVG are output as vectors, supporting scaling and search.' },

    /* Section 01 - Typography & i18n */
    { key: 'sec-01-kicker', selector: '#sec-01-kicker', type: 'text', en: 'Typography & i18n' },
    { key: 'sec-01-title', selector: '#sec-01-title', type: 'text', en: 'Multilingual Typesetting and Text Layer' },
    { key: 'sec-01-summary', selector: '#sec-01-summary', type: 'text', en: 'Global documents must handle mixed Chinese and English text plus numbers. This section verifies how different scripts behave in pagination, line height, letter spacing, and copy order, ensuring every character in the final PDF remains a selectable text object.' },
    { key: 'sec-01-card-1-title', selector: '#sec-01-card-1-title', type: 'text', en: 'Multilingual Samples' },
    { key: 'sec-01-card-2-title', selector: '#sec-01-card-2-title', type: 'text', en: 'Typesetting Checklist' },
    { key: 'sec-01-check-1', selector: '#sec-01-check-1', type: 'text', en: 'CJK characters and Latin letters maintain natural letter spacing.' },
    { key: 'sec-01-check-2', selector: '#sec-01-check-2', type: 'text', en: 'Bold, italic, and inline code do not lose styling at line breaks.' },
    { key: 'sec-01-check-3', selector: '#sec-01-check-3', type: 'text', en: 'Line height and first-line indentation remain consistent when paragraphs span pages.' },
    { key: 'sec-01-check-4', selector: '#sec-01-check-4', type: 'text', en: 'Exported text can be searched for "DesignOps" or "\u8bbe\u8ba1\u7cfb\u7edf" directly.' },
    { key: 'sec-01-check-5', selector: '#sec-01-check-5', type: 'text', en: 'Blockquotes use pseudo-elements to render decorative quotation marks.' },
    { key: 'sec-01-quote', selector: '#sec-01-quote', type: 'text', en: 'Good typography is invisible: readers notice only the content, not the complex calculations behind fonts, spacing, and pagination.' },

    /* Section 02 - Color System */
    { key: 'sec-02-kicker', selector: '#sec-02-kicker', type: 'text', en: 'Color System' },
    { key: 'sec-02-title', selector: '#sec-02-title', type: 'text', en: 'Color System and Gradients' },
    { key: 'sec-02-summary', selector: '#sec-02-summary', type: 'text', en: 'Modern interfaces rely on precise color delivery. This section shows standardized definitions of brand, functional, and neutral colors, plus the reproduction of linear gradients in PDF vector output.' },
    { key: 'sec-02-card-1-title', selector: '#sec-02-card-1-title', type: 'text', en: 'Brand & Functional Swatches' },
    { key: 'sec-02-card-2-title', selector: '#sec-02-card-2-title', type: 'text', en: 'Gradients and Neutral Steps' },
    { key: 'sec-02-swatch-1-name', selector: '#sec-02-swatch-1-name', type: 'text', en: 'Primary Blue' },
    { key: 'sec-02-swatch-1-desc', selector: '#sec-02-swatch-1-desc', type: 'text', en: '#2563eb \u00b7 Used for primary buttons, links, and key icons.' },
    { key: 'sec-02-swatch-2-name', selector: '#sec-02-swatch-2-name', type: 'text', en: 'Success Green' },
    { key: 'sec-02-swatch-2-desc', selector: '#sec-02-swatch-2-desc', type: 'text', en: '#10b981 \u00b7 Used for completion states and positive feedback.' },
    { key: 'sec-02-swatch-3-name', selector: '#sec-02-swatch-3-name', type: 'text', en: 'Warning Amber' },
    { key: 'sec-02-swatch-3-desc', selector: '#sec-02-swatch-3-desc', type: 'text', en: '#f59e0b \u00b7 Used for warnings and attention states.' },
    { key: 'sec-02-swatch-4-name', selector: '#sec-02-swatch-4-name', type: 'text', en: 'Error Red' },
    { key: 'sec-02-swatch-4-desc', selector: '#sec-02-swatch-4-desc', type: 'text', en: '#ef4444 \u00b7 Used for error messages and destructive actions.' },
    { key: 'sec-02-note-strong', selector: '#sec-02-note-strong', type: 'text', en: 'Vector gradient note:' },
    { key: 'sec-02-note-text', selector: '#sec-02-note-text', type: 'text', en: 'dompdf.js parses CSS gradients into PDF gradient shaders, keeping transitions smooth when zoomed without the jaggies or banding typical of bitmap stretching.' },

    /* Section 03 - Iconography & SVG */
    { key: 'sec-03-kicker', selector: '#sec-03-kicker', type: 'text', en: 'Iconography & SVG' },
    { key: 'sec-03-title', selector: '#sec-03-title', type: 'text', en: 'Icon System and Vector Graphics' },
    { key: 'sec-03-summary', selector: '#sec-03-summary', type: 'text', en: 'Icons are the most frequently used graphic elements in interfaces. This section verifies the clarity and scalability of inline SVG icon grids, trend charts, and raster samples after export.' },
    { key: 'sec-03-card-1-title', selector: '#sec-03-card-1-title', type: 'text', en: 'SVG Icon Grid' },
    { key: 'sec-03-card-2-title', selector: '#sec-03-card-2-title', type: 'text', en: 'Vector Trend Chart' },
    { key: 'sec-03-icon-1', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(1) span', type: 'text', en: 'Home' },
    { key: 'sec-03-icon-2', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(2) span', type: 'text', en: 'Mail' },
    { key: 'sec-03-icon-3', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(3) span', type: 'text', en: 'Settings' },
    { key: 'sec-03-icon-4', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(4) span', type: 'text', en: 'Shield' },
    { key: 'sec-03-icon-5', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(5) span', type: 'text', en: 'Download' },
    { key: 'sec-03-icon-6', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(6) span', type: 'text', en: 'Clock' },
    { key: 'sec-03-icon-7', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(7) span', type: 'text', en: 'Users' },
    { key: 'sec-03-icon-8', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(8) span', type: 'text', en: 'Layout' },
    { key: 'sec-03-icon-9', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(9) span', type: 'text', en: 'Chart' },
    { key: 'sec-03-icon-10', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(10) span', type: 'text', en: 'File' },
    { key: 'sec-03-icon-11', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(11) span', type: 'text', en: 'Layers' },
    { key: 'sec-03-icon-12', selector: '#document > .report-section:nth-of-type(3) .ds-icon-grid .ds-icon-cell:nth-child(12) span', type: 'text', en: 'Info' },
    { key: 'sec-03-caption', selector: '#sec-03-caption', type: 'text', en: 'Text, polylines, and filled areas in the chart are all vector objects. After export they can be selected and searched individually, avoiding the pixelation common in screenshot engines.' },

    /* Section 04 - Layout & Components */
    { key: 'sec-04-kicker', selector: '#sec-04-kicker', type: 'text', en: 'Layout & Components' },
    { key: 'sec-04-title', selector: '#sec-04-title', type: 'text', en: 'Layout, Components, and Visual States' },
    { key: 'sec-04-summary', selector: '#sec-04-summary', type: 'text', en: 'Real interface documents include badges, alerts, buttons, clipped containers, and transparent overlays. This section verifies the stability of these common visual patterns during PDF pagination and rendering.' },
    { key: 'sec-04-card-1-title', selector: '#sec-04-card-1-title', type: 'text', en: 'Component State Showcase' },
    { key: 'sec-04-card-2-title', selector: '#sec-04-card-2-title', type: 'text', en: 'Layout Feature Verification' },
    { key: 'sec-04-mini-1-title', selector: '#document > .report-section:nth-of-type(4) .report-mini-card:nth-child(1) h4', type: 'text', en: 'Overflow Clipping' },
    { key: 'sec-04-mini-2-title', selector: '#document > .report-section:nth-of-type(4) .report-mini-card:nth-child(2) h4', type: 'text', en: 'Opacity Stacking' },
    { key: 'sec-04-alert-info', selector: '#sec-04-alert-info', type: 'text', en: 'Info: This component has passed accessibility review and is ready for production.' },
    { key: 'sec-04-alert-warn', selector: '#sec-04-alert-warn', type: 'text', en: 'Caution: Legacy APIs will be removed in the next major version; please migrate soon.' },
    { key: 'sec-04-note', selector: '#sec-04-note', type: 'html', en: 'The component card on the left carries the <code>divisionDisable</code> attribute, so it should move as a whole block across pages and avoid cutting buttons or badges in half.' },

    /* Section 05 - Structured Data */
    { key: 'sec-05-kicker', selector: '#sec-05-kicker', type: 'text', en: 'Structured Data' },
    { key: 'sec-05-title', selector: '#sec-05-title', type: 'text', en: 'Structured Data Tables' },
    { key: 'sec-05-summary', selector: '#sec-05-summary', type: 'text', en: 'Design system adoption must be measured with data. The table below is generated dynamically to verify column width distribution, numeric alignment, grouped rows, status chips, and mixed Chinese-English fields in PDF.' },
    { key: 'sec-05-table-title', selector: '#sec-05-table-title', type: 'text', en: 'Component Adoption Matrix' },
    { key: 'sec-05-table-subtle', selector: '#sec-05-table-subtle', type: 'text', en: 'Covers component name, owning team, adoption rate, performance score, and SLA status.' },
    { key: 'sec-05-chip', selector: '#sec-05-chip', type: 'text', en: 'Dynamically generated' },
    { key: 'sec-05-th-1', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(1) th:nth-child(1)', type: 'text', en: 'Team' },
    { key: 'sec-05-th-2', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(1) th:nth-child(2)', type: 'text', en: 'H1' },
    { key: 'sec-05-th-3', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(1) th:nth-child(3)', type: 'text', en: 'H2' },
    { key: 'sec-05-th-4', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(1) th:nth-child(4)', type: 'text', en: 'SLA' },
    { key: 'sec-05-th-5', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(2) th:nth-child(1)', type: 'text', en: 'Adoption' },
    { key: 'sec-05-th-6', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(2) th:nth-child(2)', type: 'text', en: 'Satisfaction' },
    { key: 'sec-05-th-7', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(2) th:nth-child(3)', type: 'text', en: 'Adoption' },
    { key: 'sec-05-th-8', selector: '#document > .report-section:nth-of-type(5) .report-table thead tr:nth-child(2) th:nth-child(4)', type: 'text', en: 'Satisfaction' },
    { key: 'sec-05-callout', selector: '#sec-05-callout', type: 'text', en: 'If after export you can still select numbers by column, search team names, and copy status labels completely, then table structure, glyph mapping, and text objects are all correct.' },

    /* Section 06 - Forms */
    { key: 'sec-06-kicker', selector: '#sec-06-kicker', type: 'text', en: 'Forms' },
    { key: 'sec-06-title', selector: '#sec-06-title', type: 'text', en: 'Form Controls and Field Export' },
    { key: 'sec-06-summary', selector: '#sec-06-summary', type: 'text', en: 'Business documents commonly contain form fields that need to keep current values and visual states in PDF. This section covers text, choice, date, range, color, and progress controls to verify static and interactive export paths.' },
    { key: 'sec-06-card-1-title', selector: '#sec-06-card-1-title', type: 'text', en: 'Text and Choice' },
    { key: 'sec-06-card-2-title', selector: '#sec-06-card-2-title', type: 'text', en: 'State and Static-only Controls' },
    { key: 'form-label-project', selector: '#form-label-project', type: 'text', en: 'Component Name' },
    { key: 'form-label-owner', selector: '#form-label-owner', type: 'text', en: 'Owner' },
    { key: 'form-label-email', selector: '#form-label-email', type: 'text', en: 'Contact Email' },
    { key: 'form-label-password', selector: '#form-label-password', type: 'text', en: 'Access Token' },
    { key: 'form-label-stage', selector: '#form-label-stage', type: 'text', en: 'Design Stage' },
    { key: 'form-stage-option-1', selector: '#form-stage-option-1', type: 'text', en: 'Draft' },
    { key: 'form-stage-option-2', selector: '#form-stage-option-2', type: 'text', en: 'In Review' },
    { key: 'form-stage-option-3', selector: '#form-stage-option-3', type: 'text', en: 'Released' },
    { key: 'form-label-tags', selector: '#form-label-tags', type: 'text', en: 'Platforms' },
    { key: 'form-tag-option-1', selector: '#form-tag-option-1', type: 'text', en: 'Web' },
    { key: 'form-tag-option-2', selector: '#form-tag-option-2', type: 'text', en: 'iOS' },
    { key: 'form-tag-option-3', selector: '#form-tag-option-3', type: 'text', en: 'Android' },
    { key: 'form-tag-option-4', selector: '#form-tag-option-4', type: 'text', en: 'Desktop' },
    { key: 'form-label-notes', selector: '#form-label-notes', type: 'text', en: 'Notes' },
    { key: 'form-row-checks', selector: '#form-row-checks', type: 'text', en: 'Checklist' },
    { key: 'form-checkbox-1', selector: '#form-checkbox-1', type: 'text', en: 'Design aligned' },
    { key: 'form-checkbox-2', selector: '#form-checkbox-2', type: 'text', en: 'Needs second review' },
    { key: 'form-row-radio', selector: '#form-row-radio', type: 'text', en: 'Release Track' },
    { key: 'form-radio-1', selector: '#form-radio-1', type: 'text', en: 'Canary' },
    { key: 'form-radio-2', selector: '#form-radio-2', type: 'text', en: 'Stable' },
    { key: 'form-label-date', selector: '#form-label-date', type: 'text', en: 'Review Date' },
    { key: 'form-label-time', selector: '#form-label-time', type: 'text', en: 'Review Time' },
    { key: 'form-label-month', selector: '#form-label-month', type: 'text', en: 'Archive Month' },
    { key: 'form-label-week', selector: '#form-label-week', type: 'text', en: 'Schedule Week' },
    { key: 'form-label-range', selector: '#form-label-range', type: 'text', en: 'Completion' },
    { key: 'form-label-color', selector: '#form-label-color', type: 'text', en: 'Theme Color' },
    { key: 'form-label-progress', selector: '#form-label-progress', type: 'text', en: 'Document Progress' },
    { key: 'form-label-meter', selector: '#form-label-meter', type: 'text', en: 'Quality Score' },

    /* Section 07 - Code & Math */
    { key: 'sec-07-kicker', selector: '#sec-07-kicker', type: 'text', en: 'Code & Math' },
    { key: 'sec-07-title', selector: '#sec-07-title', type: 'text', en: 'Code Blocks and Math Formulas' },
    { key: 'sec-07-summary', selector: '#sec-07-summary', type: 'text', en: 'Technical documents often contain preformatted text and formulas that require monospace fonts, superscripts, subscripts, and piecewise structures. This section verifies the readability of these rich-text elements after pagination.' },
    { key: 'sec-07-code-title-1', selector: '#sec-07-code-title-1', type: 'text', en: 'Design Token JSON' },
    { key: 'sec-07-code-title-2', selector: '#sec-07-code-title-2', type: 'text', en: 'Render Pipeline' },
    { key: 'sec-07-math-title', selector: '#sec-07-math-title', type: 'text', en: 'Math and Symbol Samples' },
    { key: 'sec-07-math-1', selector: '#sec-07-math-1', type: 'text', en: 'Euler identity:' },
    { key: 'sec-07-math-2', selector: '#sec-07-math-2', type: 'text', en: 'Gaussian integral:' },
    { key: 'sec-07-math-3', selector: '#sec-07-math-3', type: 'text', en: 'Bayes theorem:' },
    { key: 'sec-07-math-4', selector: '#sec-07-math-4', type: 'text', en: 'Piecewise function:' },

    /* Section 08 - Pagination */
    { key: 'sec-08-kicker', selector: '#sec-08-kicker', type: 'text', en: 'Pagination' },
    { key: 'sec-08-title', selector: '#sec-08-title', type: 'text', en: 'Pagination Stress and Document Integrity' },
    { key: 'sec-08-summary', selector: '#sec-08-summary', type: 'text', en: 'Real documents usually span multiple pages. This section verifies dompdf.js behavior at pagination cut points, continuous copying, and complex block relocation through repeated entries, forced page breaks, and cross-page protected containers.' },
    { key: 'sec-08-appendix-note', selector: '#sec-08-appendix-note', type: 'text', en: 'The items below are generated dynamically to verify long-list pagination behavior and text continuity.' },
    { key: 'sec-08-timeline-title', selector: '#sec-08-timeline-title', type: 'text', en: 'Release Milestones' },
    { key: 'sec-08-timeline-phase-1-title', selector: '#sec-08-timeline-phase-1-title', type: 'text', en: 'Phase 1 \u00b7 Design Spec Freeze' },
    { key: 'sec-08-timeline-phase-1-text', selector: '#sec-08-timeline-phase-1-text', type: 'text', en: 'Finalize and lock the version of design tokens such as colors, typography, spacing, and radii.' },
    { key: 'sec-08-timeline-phase-2-title', selector: '#sec-08-timeline-phase-2-title', type: 'text', en: 'Phase 2 \u00b7 Component Implementation and Testing' },
    { key: 'sec-08-timeline-phase-2-text', selector: '#sec-08-timeline-phase-2-text', type: 'text', en: 'Complete core component development on Web, iOS, and Android, and pass visual regression testing.' },
    { key: 'sec-08-timeline-phase-3-title', selector: '#sec-08-timeline-phase-3-title', type: 'text', en: 'Phase 3 \u00b7 Documentation and Delivery' },
    { key: 'sec-08-timeline-phase-3-text', selector: '#sec-08-timeline-phase-3-text', type: 'text', en: 'Generate PDF spec documents for design and engineering, confirming pagination, table of contents, bookmarks, and search availability.' },
    { key: 'sec-08-guard-title', selector: '#sec-08-guard-title', type: 'text', en: 'Cross-page Protection Sample' },
    { key: 'sec-08-guard-text', selector: '#sec-08-guard-text', type: 'html', en: 'This module carries the <code>divisionDisable</code> attribute. When content nears the bottom of a page, it should move to the next page as a whole block instead of being cut in half. Real-world scenarios such as signature areas, approval notes, and invoice covers need similar protection.' },

    /* Section 09 - Raster Sample */
    { key: 'sec-09-kicker', selector: '#sec-09-kicker', type: 'text', en: 'Raster Sample' },
    { key: 'sec-09-title', selector: '#sec-09-title', type: 'text', en: 'Raster Image Embedding' },
    { key: 'sec-09-summary', selector: '#sec-09-summary', type: 'text', en: 'Although dompdf.js excels at vector text, real businesses still need bitmaps. This section keeps one Canvas-generated sample image to verify compression, sizing, and embedding stability.' },
    { key: 'sec-09-caption', selector: '#sec-09-caption', type: 'text', en: 'This image is a JPEG bitmap sample used to confirm color, sizing, and compression behavior after export.' },

    /* Markdown panel */
    { key: 'md-input-title', selector: '#panel-markdown .md-editor-panel .md-panel-title span', type: 'text', en: 'Markdown Input' },
    { key: 'md-preview-title', selector: '#panel-markdown .md-preview-panel .md-panel-title span', type: 'text', en: 'Typeset Preview (A4)' },
    { key: 'md-empty-state', selector: '.md-empty-state p', type: 'text', en: 'Type Markdown on the left and it will automatically render into an A4 layout on the right' },

    /* Section 10 - PR Verification (list-style / hyperlink / composite glyphs) */
    { key: 'sec-10-bullet-1', selector: '#sec-10-bullet-1', type: 'text', en: 'Bullet list item 1' },
    { key: 'sec-10-bullet-2', selector: '#sec-10-bullet-2', type: 'text', en: 'Bullet list item 2' },
    { key: 'sec-10-num-1', selector: '#sec-10-num-1', type: 'text', en: 'Numbered list item 1' },
    { key: 'sec-10-num-2', selector: '#sec-10-num-2', type: 'text', en: 'Numbered list item 2' },
    { key: 'sec-10-square-1', selector: '#sec-10-square-1', type: 'text', en: 'Square marker item' },
    { key: 'sec-10-checked', selector: '#sec-10-checked', type: 'html', en: '<input type="checkbox" checked /> Checked checkbox' },
    { key: 'sec-10-unchecked', selector: '#sec-10-unchecked', type: 'html', en: '<input type="checkbox" /> Unchecked checkbox' },
    { key: 'sec-10-radio', selector: '#sec-10-radio', type: 'html', en: '<input type="radio" name="g" checked /> Option one <input type="radio" name="g" /> Option two' },
    { key: 'sec-10-hyperlink-title', selector: '#sec-10-hyperlink-title', type: 'text', en: 'Hyperlink Test' },
    { key: 'sec-10-hyperlink-p1', selector: '#sec-10-hyperlink-p1', type: 'html', en: 'Regular text with an inline <a href="https://example.com">clickable link</a> in the middle.' },
    { key: 'sec-10-hyperlink-p2', selector: '#sec-10-hyperlink-p2', type: 'html', en: '<a href="https://developer.mozilla.org">External documentation link</a> followed by more text.' },
    { key: 'sec-10-compound-1', selector: '#sec-10-compound-1', type: 'text', en: 'Composite glyph test: \u00e1 \u00e9 \u00ef \u00f1 \u00fc \u00e4 \u00f6 mixed into a Chinese paragraph' },
    { key: 'sec-10-compound-2', selector: '#sec-10-compound-2', type: 'text', en: 'Chinese text after leading composite glyphs: \u4e2d\u534e\u4eba\u6c11\u5171\u548c\u56fd\uff0cabcdefghijklmnopqrstuvwxyz' }
  ];

  function getSavedLocale() {
    try {
      return window.localStorage.getItem(LOCALE_STORAGE_KEY) === 'zh' ? 'zh' : 'en';
    } catch (err) {
      return 'en';
    }
  }

  function getLocalePack() {
    return I18N[currentLocale];
  }

  function getRuntimeStrings() {
    return getLocalePack().runtime;
  }

  function captureStaticContent() {
    if (staticContentCaptured) return;
    for (var i = 0; i < STATIC_TRANSLATIONS.length; i++) {
      var entry = STATIC_TRANSLATIONS[i];
      if (entry.type === 'title') {
        originalStaticContent[entry.key] = document.title;
        continue;
      }
      var el = document.querySelector(entry.selector);
      if (!el) continue;
      if (entry.type === 'attr') {
        originalStaticContent[entry.key] = el.getAttribute(entry.attr);
      } else if (entry.type === 'html') {
        originalStaticContent[entry.key] = el.innerHTML;
      } else {
        originalStaticContent[entry.key] = el.textContent;
      }
    }
    staticContentCaptured = true;
  }

  function applyStaticTranslations(locale) {
    captureStaticContent();
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';

    for (var i = 0; i < STATIC_TRANSLATIONS.length; i++) {
      var entry = STATIC_TRANSLATIONS[i];
      var value = locale === 'en' ? entry.en : originalStaticContent[entry.key];
      if (typeof value === 'undefined') continue;

      if (entry.type === 'title') {
        document.title = value;
        continue;
      }

      var el = document.querySelector(entry.selector);
      if (!el) continue;

      if (entry.type === 'attr') {
        if (value === null) el.removeAttribute(entry.attr);
        else el.setAttribute(entry.attr, value);
      } else if (entry.type === 'html') {
        el.innerHTML = value;
      } else {
        el.textContent = value;
      }
    }
  }

  function renderLanguageSwitch() {
    var enBtn = document.getElementById('lang-btn-en');
    var zhBtn = document.getElementById('lang-btn-zh');
    if (enBtn) enBtn.classList.toggle('active', currentLocale === 'en');
    if (zhBtn) zhBtn.classList.toggle('active', currentLocale === 'zh');
  }

  function syncStatusTextForLocale() {
    var runtime = getRuntimeStrings();
    if (!statusTextEl || !statusDotEl) return;
    if (statusDotEl.className.indexOf('error') !== -1) return;

    if (statusDotEl.className.indexOf('loading') !== -1) {
      statusTextEl.textContent = runtime.processing;
      if (topLoadingOverlayEl && !topLoadingOverlayEl.hidden && topLoadingTextEl) {
        topLoadingTextEl.textContent = runtime.processing;
      }
      return;
    }

    statusTextEl.textContent = symbolFontConfig ? runtime.readyWithSymbol : runtime.ready;
  }

  function syncMarkdownForLocale(previousLocale) {
    if (!vditor) return;
    var currentValue = vditor.getValue();
    if (previousLocale && currentValue === I18N[previousLocale].mdSample) {
      vditor.setValue(I18N[currentLocale].mdSample);
      return;
    }
    updateMdStats(currentValue);
  }

  function applyLocale(previousLocale) {
    themeLabels = I18N[currentLocale].themeLabels;
    mdSamples.default = I18N[currentLocale].mdSample;
    applyStaticTranslations(currentLocale);
    renderLanguageSwitch();
    syncStatusTextForLocale();
    updateBenchmarkUi();
    buildRecordsTable();
    buildLongList(benchmarkBuildVersion);
    updateDocPageInfo();
    var sampleImg = document.getElementById('sample-img');
    if (sampleImg) sampleImg.src = createChartDataUrl();
    syncMarkdownForLocale(previousLocale);
  }

  window.setLanguage = function (locale) {
    var nextLocale = locale === 'zh' ? 'zh' : 'en';
    if (nextLocale === currentLocale) return;
    var previousLocale = currentLocale;
    currentLocale = nextLocale;
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, currentLocale);
    } catch (err) { /* ignore */ }
    applyLocale(previousLocale);
  };

  /* ========================= Status ========================= */
  function showTopLoading(text) {
    if (!topLoadingOverlayEl || !topLoadingTextEl) return;
    topLoadingTextEl.textContent = text || getRuntimeStrings().processing;
    topLoadingOverlayEl.hidden = false;
  }

  function hideTopLoading() {
    if (!topLoadingOverlayEl) return;
    topLoadingOverlayEl.hidden = true;
  }

  function setStatus(text, isError) {
    statusTextEl.textContent = text;
    statusDotEl.className = isError ? 'status-dot error' : 'status-dot success';
    hideTopLoading();
  }

  function setStatusLoading(text) {
    statusTextEl.textContent = text;
    statusDotEl.className = 'status-dot loading';
    showTopLoading(text);
  }

  function updateDompdfProgressStatus(progress) {
    var runtime = getRuntimeStrings();
    if (!progress || !progress.stage) return;
    if (progress.stage === 'collecting') {
      console.info('[dompdf] collecting document');
      setStatusLoading(runtime.parsingPage);
      return;
    }
    if (progress.stage === 'countingPages') {
      console.info(progress.totalPages
        ? ('[dompdf] counting pages: ' + progress.totalPages)
        : '[dompdf] counting pages');
      setStatusLoading(runtime.countingPages(progress.totalPages));
      return;
    }
    if (progress.stage === 'rendering') {
      if (progress.currentPage && progress.totalPages) {
        console.info('[dompdf] rendering page ' + progress.currentPage + ' / ' + progress.totalPages);
        setStatusLoading(runtime.renderingPdf(progress.currentPage, progress.totalPages));
        return;
      }
      if (progress.totalPages) {
        console.info('[dompdf] rendering started, total pages: ' + progress.totalPages);
        setStatusLoading(runtime.renderingPdf(null, progress.totalPages));
        return;
      }
      console.info('[dompdf] rendering');
      setStatusLoading(runtime.renderingPdf());
    }
  }

  function updateBenchmarkUi() {
    document.getElementById('benchmark-mode-light').classList.toggle('active', benchmarkMode === 'light');
    document.getElementById('benchmark-mode-heavy').classList.toggle('active', benchmarkMode === 'heavy');
    document.getElementById('benchmark-mode-extreme').classList.toggle('active', benchmarkMode === 'extreme');
    document.getElementById('benchmark-mode-light').textContent = currentLocale === 'zh' ? '基准测试' : 'Benchmark';
    document.getElementById('benchmark-mode-heavy').textContent = currentLocale === 'zh' ? '500页' : '500 Pages';
    document.getElementById('benchmark-mode-extreme').textContent = currentLocale === 'zh' ? '10000页' : '10k Pages';
    document.querySelector('.benchmark-mode-switch').setAttribute('aria-label', currentLocale === 'zh' ? '生成页数' : 'Generated pages');
    if (benchmarkCompressToggleEl) benchmarkCompressToggleEl.checked = benchmarkCompressEnabled;
    if (benchmarkCompressLabelEl) {
      benchmarkCompressLabelEl.textContent = benchmarkCompressEnabled
        ? getRuntimeStrings().benchmarkCompressOn
        : getRuntimeStrings().benchmarkCompressOff;
    }
    if (benchmarkMetaEl) {
      benchmarkMetaEl.textContent = getRuntimeStrings().benchmarkMeta(
        benchmarkMode,
        benchmarkCompressEnabled,
        benchmarkBuildInProgress
      );
    }
  }

  function rebuildBenchmarkSample() {
    buildRecordsTable();
    benchmarkBuildVersion += 1;
    benchmarkBuildInProgress = true;
    updateBenchmarkUi();

    var buildVersion = benchmarkBuildVersion;
    benchmarkBuildPromise = buildLongList(buildVersion)
      .then(function () {
        if (buildVersion !== benchmarkBuildVersion) return;
        benchmarkBuildInProgress = false;
        updateDocPageInfo();
        resetMetrics();
        updateBenchmarkUi();
      })
      .catch(function (err) {
        if (buildVersion !== benchmarkBuildVersion) return;
        benchmarkBuildInProgress = false;
        updateBenchmarkUi();
        throw err;
      });

    return benchmarkBuildPromise;
  }

  function ensureBenchmarkSampleReady() {
    if (activeTab !== 'basic' || !benchmarkBuildInProgress) {
      return Promise.resolve();
    }
    return benchmarkBuildPromise;
  }

  function ensureDemoReady() {
    return readyPromise.then(function () {
      if (!sharedFontConfig.fontBytes) {
        throw new Error(getRuntimeStrings().fontNotReady);
      }
    });
  }

  /* ========================= Tab Switching ========================= */
  // Markdown 编辑器依赖 CDN 资源(Vditor / marked / DOMPurify)，判断是否都已就绪
  function markdownDepsReady() {
    return !!(window.Vditor && window.marked && window.DOMPurify);
  }

  // 轻量提示条(侧栏状态条被隐藏，改用居中 toast 反馈)
  var miniToastTimer = null;
  function showMiniToast(text) {
    var el = document.getElementById('mini-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mini-toast';
      el.className = 'mini-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    // 强制回流后再加类，保证过渡动画生效
    void el.offsetWidth;
    el.classList.add('is-visible');
    if (miniToastTimer) clearTimeout(miniToastTimer);
    miniToastTimer = setTimeout(function () {
      el.classList.remove('is-visible');
    }, 2600);
  }

  window.switchTab = function (tab) {
    // Markdown 资源未加载完成时不跳转，给出提示
    if (tab === 'markdown' && !markdownDepsReady()) {
      showMiniToast(getRuntimeStrings().markdownLoading);
      return;
    }

    activeTab = tab;
    document.getElementById('tab-btn-basic').classList.toggle('active', tab === 'basic');
    document.getElementById('tab-btn-markdown').classList.toggle('active', tab === 'markdown');
    document.getElementById('panel-basic').classList.toggle('active', tab === 'basic');
    document.getElementById('panel-markdown').classList.toggle('active', tab === 'markdown');

    // "生成页数" 基准控制仅对综合测试页有意义，Markdown 编辑器下隐藏
    var benchSection = document.getElementById('sidebar-benchmark-section');
    if (benchSection) {
      benchSection.style.display = tab === 'basic' ? '' : 'none';
    }

    if (tab === 'markdown' && !vditor) {
      initMarkdownEditor();
    }

    if (tab === 'basic') {
      updateDocPageInfo();
    }
  };

  /* ========================= Sidebar Footer Tabs ========================= */
  window.switchFooterTab = function (tab) {
    document.getElementById('footer-tab-specs').classList.toggle('active', tab === 'specs');
    document.getElementById('footer-tab-code').classList.toggle('active', tab === 'code');
    document.getElementById('footer-panel-specs').classList.toggle('active', tab === 'specs');
    document.getElementById('footer-panel-code').classList.toggle('active', tab === 'code');
  };

  window.setBenchmarkMode = function (mode) {
    benchmarkMode = mode === 'light' || mode === 'extreme' ? mode : 'heavy';
    updateBenchmarkUi();
    setStatusLoading(benchmarkMode === 'extreme'
      ? getRuntimeStrings().buildExtreme
      : getRuntimeStrings().rebuildBenchmark);
    rebuildBenchmarkSample()
      .then(function () {
        setStatus(benchmarkMode === 'extreme'
          ? getRuntimeStrings().extremeReady
          : getRuntimeStrings().benchmarkReady);
      })
      .catch(function (err) {
        setStatus('error: ' + err.message, true);
        console.error(err);
      });
  };

  window.toggleBenchmarkCompress = function (checked) {
    benchmarkCompressEnabled = !!checked;
    updateBenchmarkUi();
    resetMetrics();
  };

  /* ========================= Formatters ========================= */
  function formatDuration(ms) {
    if (ms < 1000) return ms.toFixed(1) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /* ========================= Font Loading ========================= */
  function loadFont() {
    return fetch('./SourceHanSansSC-Regular.ttf')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        sharedFontConfig.fontBytes = new Uint8Array(buf);
      });
  }

  function loadSymbolFont() {
    return fetch('../assets/symbol-fallback.ttf')
      .then(function (res) {
        if (!res.ok) return null;
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (!buf) return;
        symbolFontConfig = {
          fontFamily: 'SymbolFallback',
          fontStyle: 'normal',
          fontWeight: 400,
          fontBytes: new Uint8Array(buf)
        };
      })
      .catch(function () { /* optional */ });
  }

  /* ========================= html2pdf lazy load ========================= */
  function ensureHtml2Pdf() {
    if (window.html2pdf) return Promise.resolve(window.html2pdf);
    if (html2pdfLoader) return html2pdfLoader;
    html2pdfLoader = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
      script.async = true;
      script.onload = function () {
        if (window.html2pdf) resolve(window.html2pdf);
        else reject(new Error('html2pdf.js loaded but global missing'));
      };
      script.onerror = function () { reject(new Error('failed to load html2pdf.js')); };
      document.head.appendChild(script);
    }).catch(function (err) { html2pdfLoader = null; throw err; });
    return html2pdfLoader;
  }

  function ensurePdfJs() {
    if (pdfJsReady && window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsLoader) return pdfJsLoader;
    pdfJsLoader = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      script.onload = function () {
        if (!window.pdfjsLib) {
          reject(new Error('pdf.js loaded but global missing'));
          return;
        }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        pdfJsReady = true;
        resolve(window.pdfjsLib);
      };
      script.onerror = function () { reject(new Error('failed to load pdf.js')); };
      document.head.appendChild(script);
    }).catch(function (err) {
      pdfJsLoader = null;
      console.warn('pdf.js failed to load; blank PDF detection is unavailable.', err);
      throw err;
    });
    return pdfJsLoader;
  }

  function detectBlankPdf(blob) {
    return ensurePdfJs()
      .then(function (pdfjsLib) {
        return blob.arrayBuffer().then(function (buffer) {
          var loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
          return loadingTask.promise.then(function (pdf) {
            if (!pdf.numPages) return true;
            return pdf.getPage(1).then(function (page) {
              var viewport = page.getViewport({ scale: 1.25 });
              var canvas = document.createElement('canvas');
              canvas.width = Math.max(1, Math.ceil(viewport.width));
              canvas.height = Math.max(1, Math.ceil(viewport.height));
              var ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (!ctx) return false;

              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvas.width, canvas.height);

              return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
                var imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                var nonWhitePixels = 0;
                for (var i = 0; i < imageData.length; i += 4) {
                  var r = imageData[i];
                  var g = imageData[i + 1];
                  var b = imageData[i + 2];
                  var a = imageData[i + 3];
                  var maxDiff = Math.max(
                    Math.abs(255 - r),
                    Math.abs(255 - g),
                    Math.abs(255 - b)
                  );
                  if (a > 8 && maxDiff > 12) nonWhitePixels++;
                }

                var totalPixels = canvas.width * canvas.height;
                var nonWhiteRatio = totalPixels > 0 ? nonWhitePixels / totalPixels : 0;
                return nonWhitePixels < 600 || nonWhiteRatio < 0.0008;
              });
            });
          });
        });
      })
      .catch(function (err) {
        console.warn('Blank PDF detection failed:', err);
        return false;
      });
  }

  /* ========================= Export Target ========================= */
  function getExportTarget() {
    if (activeTab === 'markdown') {
      var sheet = document.getElementById('preview-sheet');
      // Clone to strip watermark layers
      var clone = sheet.cloneNode(true);
      var under = clone.querySelector('#watermark-under-layer');
      var over = clone.querySelector('#watermark-over-layer');
      if (under) under.remove();
      if (over) over.remove();
      clone.style.position = 'absolute';
      clone.style.left = '-9999px';
      clone.style.top = '-9999px';
      clone.style.display = 'block';
      clone.style.margin = '0';
      document.body.appendChild(clone);
      return { element: clone, isClone: true };
    }
    return { element: docEl, isClone: false };
  }

  function cleanupTarget(target) {
    if (target.isClone && target.element.parentNode) {
      target.element.parentNode.removeChild(target.element);
    }
  }

  function getHtml2PdfTarget() {
    var cleanupFns = [];
    var element = activeTab === 'markdown'
      ? document.getElementById('preview-sheet')
      : docEl;

    if (activeTab === 'markdown' && element) {
      ['#watermark-under-layer', '#watermark-over-layer'].forEach(function (selector) {
        var layer = element.querySelector(selector);
        if (!layer) return;
        var prevDisplay = layer.style.display;
        layer.style.display = 'none';
        cleanupFns.push(function () { layer.style.display = prevDisplay; });
      });
    }

    return {
      element: element,
      cleanup: function () {
        cleanupFns.forEach(function (fn) { fn(); });
      }
    };
  }

  /* ========================= Export Options ========================= */
  function currentDompdfOptions() {
    var opts = {
      format: 'a4',
      pagination: true,
      compress: benchmarkCompressEnabled,
      form: { mode: 'hybrid' },
      marginPt: 0,
      backgroundColor: '#ffffff',
      useCORS: true,
      fontConfig: symbolFontConfig
        ? [sharedFontConfig, symbolFontConfig]
        : sharedFontConfig,
      pageConfig: {
        excludePages: [1],
        header: {
          height: 50,
          padding: [10, 24, 0, 24],
          slots: [
            {
              content: getRuntimeStrings().exportHeader,
              position: 'leftTop',
              color: '#334155',
              fontSize: 12
            },
            {
              content: 'Page ${currentPage}/${totalPages}',
              position: { x: '100%', y: 0, anchor: 'rightTop' },
              color: '#475569',
              fontSize: 11
            }
          ],
        },
        footer: {
          height: 48,
          padding: [0, 24, 10, 24],
          slots: [
            {
              content: getRuntimeStrings().exportFooter,
              position: 'leftBottom',
              color: '#475569',
              fontSize: 11
            },
            {
              content: 'Prepared by dompdf.js',
              position: { x: '100%-24', y: '100%-10', anchor: 'rightBottom' },
              color: '#94a3b8',
              fontSize: 10
            }
          ]
        }
      }
    };

    // For markdown tab, use preview background
    if (activeTab === 'markdown') {
      var sheet = document.getElementById('preview-sheet');
      if (sheet) {
        var style = window.getComputedStyle(sheet);
        opts.backgroundColor = style.backgroundColor || '#ffffff';
      }
    }

    return opts;
  }

  function currentViewportWidthPx() {
    var rect = docEl.getBoundingClientRect();
    return Math.max(
      window.innerWidth || 0,
      document.documentElement.clientWidth || 0,
      Math.ceil(rect.right)
    );
  }

  /* ========================= Render Engines ========================= */
  function renderWithDompdf(target) {
    var options = currentDompdfOptions();
    options.onProgress = updateDompdfProgressStatus;
    return api(target.element, options);
  }

  function renderWithHtml2Pdf(target) {
    return ensureHtml2Pdf().then(function (html2pdf) {
      return html2pdf()
        .set({
          margin: 0,
          filename: 'html2pdf-export.pdf',
          image: { type: 'jpeg', quality: 0.95 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            backgroundColor: '#ffffff',
            logging: false,
            windowWidth: currentViewportWidthPx(),
            scrollY: 0,
            scrollX: 0
          },
          jsPDF: { unit: 'pt', format: 'a4', orientation: 'portrait', compress: false },
          pagebreak: {
            mode: ['css', 'legacy'],
            avoid: ['tr', 'h1', 'h2', 'h3', '.report-stat-card', '.report-chart-container', '.invoice-details-grid > div', '[divisionDisable]']
          }
        })
        .from(target.element)
        .output('blob');
    });
  }

  /* ========================= Download ========================= */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  /* ========================= Measure Engine ========================= */
  function measureEngine(engine, runner) {
    var startedAt = performance.now();
    return runner()
      .then(function (blob) {
        var duration = performance.now() - startedAt;
        if (engine === 'html2pdf') {
          return detectBlankPdf(blob).then(function (blankPdfSuspected) {
            generatedBlobs[engine] = {
              blob: blob,
              time: duration,
              size: blob.size,
              blankPdfSuspected: blankPdfSuspected
            };
            return {
              blob: blob,
              durationMs: duration,
              sizeBytes: blob.size,
              blankPdfSuspected: blankPdfSuspected
            };
          });
        }
        generatedBlobs[engine] = {
          blob: blob,
          time: duration,
          size: blob.size,
          blankPdfSuspected: false
        };
        return { blob: blob, durationMs: duration, sizeBytes: blob.size, blankPdfSuspected: false };
      });
  }

  /* ========================= Update Metrics UI ========================= */
  function updateMetricsUI(engine) {
    var data = generatedBlobs[engine];
    if (!data) return;
    if (engine === 'dompdf') {
      document.getElementById('speed-dompdf').innerText = formatDuration(data.time);
      document.getElementById('size-dompdf').innerText = formatBytes(data.size);
    } else {
      var sizeHtml2PdfEl = document.getElementById('size-html2pdf');
      document.getElementById('speed-html2pdf').innerText = formatDuration(data.time);
      sizeHtml2PdfEl.innerText = data.blankPdfSuspected
        ? (formatBytes(data.size) + getRuntimeStrings().blankPdfNote)
        : formatBytes(data.size);
      sizeHtml2PdfEl.classList.toggle('error', !!data.blankPdfSuspected);
    }
    if (generatedBlobs.dompdf && generatedBlobs.html2pdf) {
      calculateDeltas();
    }
  }

  function calculateDeltas() {
    var d = generatedBlobs.dompdf;
    var h = generatedBlobs.html2pdf;

    // Speed
    var speedRatio = h.time / d.time;
    var speedDelta = document.getElementById('speed-delta');
    if (speedRatio > 1) {
      speedDelta.className = 'metric-delta positive';
      speedDelta.innerText = getRuntimeStrings().speedFaster(speedRatio);
    } else {
      speedDelta.className = 'metric-delta';
      speedDelta.innerText = getRuntimeStrings().speedSlower(1 / speedRatio);
    }

    var totalTime = d.time + h.time;
    var dSpeedPct = Math.max(10, Math.min(90, (d.time / totalTime) * 100));
    document.getElementById('speed-bar-dompdf').style.width = dSpeedPct + '%';
    document.getElementById('speed-bar-html2pdf').style.width = (100 - dSpeedPct) + '%';

    // Size
    var sizeDiffPct = ((h.size - d.size) / h.size) * 100;
    var sizeDelta = document.getElementById('size-delta');
    if (sizeDiffPct > 0) {
      sizeDelta.className = 'metric-delta positive';
      sizeDelta.innerText = getRuntimeStrings().sizeReduced(sizeDiffPct);
    } else {
      sizeDelta.className = 'metric-delta';
      sizeDelta.innerText = getRuntimeStrings().sizeIncreased(-sizeDiffPct);
    }

    var totalSize = d.size + h.size;
    var dSizePct = Math.max(10, Math.min(90, (d.size / totalSize) * 100));
    document.getElementById('size-bar-dompdf').style.width = dSizePct + '%';
    document.getElementById('size-bar-html2pdf').style.width = (100 - dSizePct) + '%';
  }

  function resetMetrics() {
    ['speed-dompdf', 'speed-html2pdf', 'size-dompdf', 'size-html2pdf'].forEach(function (id) {
      document.getElementById(id).innerText = '--';
    });
    document.getElementById('size-html2pdf').classList.remove('error');
    ['speed-bar-dompdf', 'speed-bar-html2pdf', 'size-bar-dompdf', 'size-bar-html2pdf'].forEach(function (id) {
      document.getElementById(id).style.width = '0%';
    });
    document.getElementById('speed-delta').innerText = '';
    document.getElementById('size-delta').innerText = '';
    generatedBlobs = { dompdf: null, html2pdf: null };
  }

  /* ========================= Busy State ========================= */
  // PDF 生成/对比按钮：字体就绪前禁用，避免在字体未加载时触发导出
  var EXPORT_BTN_IDS = ['btn-export-dompdf', 'btn-export-html2pdf', 'btn-compare'];
  function setExportButtonsEnabled(enabled) {
    for (var i = 0; i < EXPORT_BTN_IDS.length; i++) {
      var btn = document.getElementById(EXPORT_BTN_IDS[i]);
      if (!btn) continue;
      btn.disabled = !enabled;
      if (enabled) {
        btn.removeAttribute('title');
      } else {
        btn.title = getRuntimeStrings().toolbarDisabledTitle;
      }
    }
  }

  function withBusy(fn) {
    var btns = document.querySelectorAll('.action-btn');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    return fn().finally(function () {
      for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
    });
  }

  /* ========================= Export Handlers ========================= */
  window.exportDompdf = function () {
    withBusy(function () {
      setStatusLoading(getRuntimeStrings().dompdfRunning);
      var target = null;
      return ensureDemoReady()
        .then(function () { return ensureBenchmarkSampleReady(); })
        .then(function () {
          setStatusLoading(getRuntimeStrings().dompdfRunning);
          target = getExportTarget();
          return measureEngine('dompdf', function () { return renderWithDompdf(target); });
        })
        .then(function (result) {
          downloadBlob(result.blob, 'dompdf-studio-demo.pdf');
          updateMetricsUI('dompdf');
          setStatus(getRuntimeStrings().dompdfDone(
            formatDuration(result.durationMs),
            formatBytes(result.sizeBytes)
          ));
        })
        .catch(function (err) {
          setStatus('error: ' + err.message, true);
          console.error(err);
        })
        .finally(function () { if (target) cleanupTarget(target); });
    });
  };

  window.exportHtml2pdf = function () {
    withBusy(function () {
      setStatusLoading(getRuntimeStrings().html2pdfRunning);
      var target = null;
      return ensureDemoReady()
        .then(function () { return ensureBenchmarkSampleReady(); })
        .then(function () {
          setStatusLoading(getRuntimeStrings().html2pdfRunning);
          target = getHtml2PdfTarget();
          return measureEngine('html2pdf', function () { return renderWithHtml2Pdf(target); });
        })
        .then(function (result) {
          downloadBlob(result.blob, 'html2pdf-studio-demo.pdf');
          updateMetricsUI('html2pdf');
          setStatus(getRuntimeStrings().html2pdfDone(
            formatDuration(result.durationMs),
            formatBytes(result.sizeBytes),
            result.blankPdfSuspected
          ));
        })
        .catch(function (err) {
          setStatus('error: ' + err.message, true);
          console.error(err);
        })
        .finally(function () {
          if (target && typeof target.cleanup === 'function') target.cleanup();
          else if (target) cleanupTarget(target);
        });
    });
  };

  window.runCompare = function () {
    resetMetrics();
    withBusy(function () {
      setStatusLoading(getRuntimeStrings().compareDompdf);
      var target = null;
      var htmlTarget = null;
      return ensureDemoReady()
        .then(function () { return ensureBenchmarkSampleReady(); })
        .then(function () {
          setStatusLoading(getRuntimeStrings().compareDompdf);
          target = getExportTarget();
          return measureEngine('dompdf', function () { return renderWithDompdf(target); });
        })
        .then(function () {
          updateMetricsUI('dompdf');
          setStatusLoading(getRuntimeStrings().compareHtml2pdf);
          // Need a fresh target for html2pdf
          cleanupTarget(target);
          target = null;
          htmlTarget = getHtml2PdfTarget();
          return measureEngine('html2pdf', function () { return renderWithHtml2Pdf(htmlTarget); })
            .then(function () {
              updateMetricsUI('html2pdf');
              setStatus(
                generatedBlobs.html2pdf && generatedBlobs.html2pdf.blankPdfSuspected
                  ? getRuntimeStrings().compareDoneBlank
                  : getRuntimeStrings().compareDone
              );
              if (typeof htmlTarget.cleanup === 'function') htmlTarget.cleanup();
              else cleanupTarget(htmlTarget);
              htmlTarget = null;
            });
        })
        .catch(function (err) {
          setStatus('error: ' + err.message, true);
          console.error(err);
          if (target) cleanupTarget(target);
          if (htmlTarget && typeof htmlTarget.cleanup === 'function') htmlTarget.cleanup();
          else if (htmlTarget) cleanupTarget(htmlTarget);
        });
    });
  };

  /* ========================= Chart Generator ========================= */
  function createChartDataUrl() {
    var width = 440, height = 280;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var bg = ctx.createLinearGradient(0, 0, width, height);
    var data = [84, 92, 118, 104, 132, 126];
    var barWidth = 34, gap = 22, x = 68;

    bg.addColorStop(0, '#f8fafc');
    bg.addColorStop(1, '#edf2f7');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#d8e1eb';
    ctx.lineWidth = 1;
    for (var y = 40; y < height - 20; y += 40) {
      ctx.beginPath();
      ctx.moveTo(40, y);
      ctx.lineTo(width - 20, y);
      ctx.stroke();
    }

    ctx.fillStyle = '#7891b2';
    for (var i = 0; i < data.length; i++) {
      var barHeight = data[i] * 1.2;
      ctx.fillRect(x, height - 30 - barHeight, barWidth, barHeight);
      ctx.fillStyle = '#60758d';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'][i], x + 2, height - 10);
      ctx.fillStyle = '#7891b2';
      x += barWidth + gap;
    }

    ctx.strokeStyle = '#24384f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(40, height - 30);
    ctx.lineTo(width - 20, height - 30);
    ctx.stroke();

    ctx.strokeStyle = '#24384f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(85, 142);
    ctx.lineTo(141, 130);
    ctx.lineTo(197, 110);
    ctx.lineTo(253, 116);
    ctx.lineTo(309, 88);
    ctx.lineTo(365, 94);
    ctx.stroke();

    ctx.fillStyle = '#24384f';
    var points = [[85, 142], [141, 130], [197, 110], [253, 116], [309, 88], [365, 94]];
    for (var j = 0; j < points.length; j++) {
      ctx.beginPath();
      ctx.arc(points[j][0], points[j][1], 4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#0f172a';
    ctx.font = '700 16px Inter, sans-serif';
    ctx.fillText(getRuntimeStrings().chartTitle, 40, 26);
    ctx.fillStyle = '#60758d';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText(getRuntimeStrings().chartSubtitle, 40, 46);
    return canvas.toDataURL('image/jpeg', 0.86);
  }

  /* ========================= Appendix Builders ========================= */
  function buildRecordsTable() {
    var body = document.getElementById('records-body');
    if (!body) return;
    body.innerHTML = '';

    var baseGroups = getLocalePack().tableGroups;

    var groups = benchmarkMode === 'light'
      ? baseGroups.slice(0, 2)
      : baseGroups;

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];

      for (var j = 0; j < group.rows.length; j++) {
        var row = group.rows[j];
        var tr = document.createElement('tr');
        // tr.setAttribute('divisionDisable', '');

        if (j === 0) {
          tr.innerHTML =
            '<td class="report-cell-group cn-copy" rowspan="' + group.rows.length + '">' + group.group + '</td>' +
            '<td class="report-cell-metric">' + row[0] + '</td>' +
            '<td class="report-cell-metric ' + (parseFloat(row[1]) >= 20 ? 'report-cell-positive' : 'report-cell-warning') + '">' + row[1] + '</td>' +
            '<td class="report-cell-metric">' + row[2] + '</td>' +
            '<td class="report-cell-metric ' + (parseFloat(row[3]) >= 20 ? 'report-cell-positive' : 'report-cell-warning') + '">' + row[3] + '</td>' +
            '<td class="report-cell-status ' + group.statusClass + '" rowspan="' + group.rows.length + '">' + group.statusText + '</td>';
        } else {
          tr.innerHTML =
            '<td class="report-cell-metric">' + row[0] + '</td>' +
            '<td class="report-cell-metric ' + (parseFloat(row[1]) >= 20 ? 'report-cell-positive' : 'report-cell-warning') + '">' + row[1] + '</td>' +
            '<td class="report-cell-metric">' + row[2] + '</td>' +
            '<td class="report-cell-metric ' + (parseFloat(row[3]) >= 20 ? 'report-cell-positive' : 'report-cell-warning') + '">' + row[3] + '</td>';
        }

        body.appendChild(tr);
      }
    }
  }

  function buildLongList(buildVersion) {
    var list = document.getElementById('long-list');
    if (!list) return Promise.resolve();
    list.innerHTML = '';
    if (typeof buildVersion !== 'number') buildVersion = benchmarkBuildVersion;

    var localeLongList = getLocalePack().longList;
    var entries = benchmarkMode === 'light' ? localeLongList.light : localeLongList.heavy;
    var repeatCount = benchmarkMode === 'light' ? 1 : benchmarkMode === 'extreme' ? 22350 : 985;
    var batchSize = benchmarkMode === 'extreme' ? 120 : repeatCount;

    return new Promise(function (resolve) {
      var index = 0;
      var buildStartedAt = performance.now();
      var lastLoggedStep = -1;

      console.info('[benchmark] start building sample:', benchmarkMode, 'items:', repeatCount);

      function appendBatch() {
        if (buildVersion !== benchmarkBuildVersion) {
          console.info('[benchmark] build canceled');
          resolve();
          return;
        }

        var fragment = document.createDocumentFragment();
        var end = Math.min(index + batchSize, repeatCount);

        for (; index < end; index++) {
          var li = document.createElement('li');
          li.className = 'cn-copy';
          li.appendChild(document.createTextNode(entries));
          fragment.appendChild(li);
        }

        list.appendChild(fragment);

        var percent = Math.min(100, Math.round((index / repeatCount) * 100));
        var step = Math.floor(percent / 5);
        if (step > lastLoggedStep || index === repeatCount) {
          lastLoggedStep = step;
          console.info(
            '[benchmark] building sample ' +
            percent + '% (' + index + '/' + repeatCount + '), elapsed ' +
            ((performance.now() - buildStartedAt) / 1000).toFixed(2) + 's'
          );
        }

        if (index < repeatCount) {
          setTimeout(appendBatch, 0);
          return;
        }

        console.info('[benchmark] sample build completed in ' + ((performance.now() - buildStartedAt) / 1000).toFixed(2) + 's');
        resolve();
      }

      appendBatch();
    });
  }

  function updateDocPageInfo() {
    if (!topbarPageInfo || !docEl) return;
    topbarPageInfo.textContent = getRuntimeStrings().approxDocPages(
      Math.max(1, docEl.scrollHeight / 1123).toFixed(1)
    );
  }

  /* ========================= Markdown Editor ========================= */
  function initMarkdownEditor() {
    if (vditor) return;
    if (!markedApi || typeof markedApi.parse !== 'function' || !purifier) {
      setStatus(getRuntimeStrings().markdownDepsFailed, true);
      return;
    }

    markedApi.setOptions({ gfm: true, breaks: true });

    vditor = new Vditor('vditor-container', {
      cdn: vditorCdnBase,
      mode: 'ir',
      height: '100%',
      placeholder: getRuntimeStrings().markdownPlaceholder,
      cache: { enable: false },
      preview: {
        theme: {
          current: 'light',
          path: vditorCdnBase + '/dist/css/content-theme'
        }
      },
      hint: {
        emojiPath: vditorCdnBase + '/dist/images/emoji'
      },
      theme: 'classic',
      resize: { enable: false },
      toolbar: [
        'emoji', 'headings', 'bold', 'italic', 'strike', 'link', '|',
        'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
        'quote', 'line', 'code', 'inline-code', '|',
        'table', 'undo', 'redo'
      ],
      input: function () { scheduleMdRender(); },
      after: function () {
        vditor.setValue(mdSamples.default);
        renderMarkdownNow();
      }
    });
  }

  function renderMarkdownNow() {
    if (!vditor) return;
    var markdown = vditor.getValue();
    var html = markdown.trim() ? markedApi.parse(markdown) : '';
    var previewEl = document.getElementById('markdown-preview');
    var sheetEl = document.getElementById('preview-sheet');
    previewEl.innerHTML = purifier.sanitize(html, { USE_PROFILES: { html: true } });
    sheetEl.classList.toggle('is-empty', !markdown.trim());
    updateMdStats(markdown);
  }

  function scheduleMdRender() {
    clearTimeout(mdRenderTimer);
    mdRenderTimer = setTimeout(renderMarkdownNow, 90);
  }

  function updateMdStats(text) {
    var s = text || '';
    document.getElementById('md-char-count').textContent = getRuntimeStrings().markdownChars(s.length);
    document.getElementById('md-word-count').textContent = getRuntimeStrings().markdownWords((s.trim().match(/[A-Za-z0-9_]+/g) || []).length);
    document.getElementById('md-line-count').textContent = getRuntimeStrings().markdownLines(s.split(/\r?\n/).length);
    var sheet = document.getElementById('preview-sheet');
    document.getElementById('md-page-count').textContent = getRuntimeStrings().markdownPages(
      Math.max(1, sheet.scrollHeight / 1123).toFixed(1)
    );
    document.getElementById('md-theme-indicator').textContent = themeLabels[activeTheme];
  }

  // Theme switcher for markdown
  var themeSelect = document.getElementById('md-theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', function () {
      activeTheme = themeSelect.value;
      document.getElementById('preview-sheet').setAttribute('data-theme', activeTheme);
      document.getElementById('md-theme-indicator').textContent = themeLabels[activeTheme];
    });
  }

  /* ========================= Automation API ========================= */
  var readyResolve;
  var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

  function encodeBase64(uint8) {
    var binary = '';
    var chunkSize = 32768;
    for (var i = 0; i < uint8.length; i += chunkSize) {
      var chunk = uint8.subarray(i, Math.min(i + chunkSize, uint8.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  window.__DOMPDF_AUTOMATION__ = {
    ready: function () { return readyPromise; },
    getMeta: function (override) {
      var options = Object.assign({}, currentDompdfOptions(), override || {});
      var rect = docEl.getBoundingClientRect();
      return {
        selector: '#document',
        rootWidthPx: rect.width,
        rootHeightPx: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1,
        pageBreaks: api.computePageBreaks(docEl, options),
        options: options
      };
    },
    inspect: function (override) {
      var options = Object.assign({}, currentDompdfOptions(), override || {});
      return readyPromise.then(function () { return api.inspect(docEl, options); });
    },
    exportPdf: function (override) {
      var options = Object.assign({}, currentDompdfOptions(), override || {});
      return readyPromise.then(function () {
        return api(docEl, options).then(function (blob) {
          return blob.arrayBuffer().then(function (buf) {
            return { pdfBase64: encodeBase64(new Uint8Array(buf)), meta: {} };
          });
        });
      });
    }
  };

  /* ========================= Init ========================= */
  if (!api) {
    setStatus(getRuntimeStrings().missingBuild, true);
    return;
  }

  captureStaticContent();
  renderLanguageSwitch();
  setStatusLoading(getRuntimeStrings().loadingResources);
  setExportButtonsEnabled(false); // 字体就绪前禁用导出/对比按钮
  updateBenchmarkUi();
  buildRecordsTable();
  buildLongList();
  updateDocPageInfo();
  var sampleImageUrl = createChartDataUrl();
  document.getElementById('sample-img').src = sampleImageUrl;
  Array.prototype.forEach.call(document.querySelectorAll('[data-raster-sample]'), function (img) {
    img.src = sampleImageUrl;
  });
  applyStaticTranslations(currentLocale);
  window.addEventListener('resize', updateDocPageInfo);

  // Preload html2pdf
  ensureHtml2Pdf().catch(function () { });
  ensurePdfJs().catch(function () { });

  // Load fonts
  Promise.all([loadFont(), loadSymbolFont()])
    .then(function () {
      setStatus(symbolFontConfig ? getRuntimeStrings().readyWithSymbol : getRuntimeStrings().ready);
    })
    .catch(function (err) {
      setStatus(getRuntimeStrings().fontWarning(err.message), true);
    })
    .finally(function () {
      // 字体字节就绪才放开导出按钮；失败则保持禁用
      setExportButtonsEnabled(!!sharedFontConfig.fontBytes);
      readyResolve({
        status: statusTextEl.textContent,
        hasFontBytes: !!sharedFontConfig.fontBytes
      });
    });
})();
