﻿﻿(function () {
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
  var overlayOn = false;
  var activeTab = 'basic';
  var benchmarkMode = 'light';
  var benchmarkCompressEnabled = true;
  var benchmarkBuildVersion = 0;
  var benchmarkBuildPromise = Promise.resolve();
  var benchmarkBuildInProgress = false;

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
  var mdRenderTimer = 0;
  var activeTheme = 'paper';
  var themeLabels = {
    paper: 'Paper Light',
    midnight: 'Midnight Blue',
    slate: 'Slate Editorial',
    sepia: 'Sepia Notebook'
  };

  var mdSamples = {
    default: [
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
    ].join("\n")
  };

  /* ========================= Status ========================= */
  function showTopLoading(text) {
    if (!topLoadingOverlayEl || !topLoadingTextEl) return;
    topLoadingTextEl.textContent = text || '正在处理中...';
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
    if (!progress || !progress.stage) return;
    if (progress.stage === 'collecting') {
      console.info('[dompdf] collecting document');
      setStatusLoading('正在解析页面...');
      return;
    }
    if (progress.stage === 'countingPages') {
      console.info(progress.totalPages
        ? ('[dompdf] counting pages: ' + progress.totalPages)
        : '[dompdf] counting pages');
      setStatusLoading(progress.totalPages
        ? ('正在计算总页数... 共 ' + progress.totalPages + ' 页')
        : '正在计算总页数...');
      return;
    }
    if (progress.stage === 'rendering') {
      if (progress.currentPage && progress.totalPages) {
        console.info('[dompdf] rendering page ' + progress.currentPage + ' / ' + progress.totalPages);
        setStatusLoading('正在生成 PDF... 第 ' + progress.currentPage + ' / ' + progress.totalPages + ' 页');
        return;
      }
      if (progress.totalPages) {
        console.info('[dompdf] rendering started, total pages: ' + progress.totalPages);
        setStatusLoading('正在生成 PDF... 共 ' + progress.totalPages + ' 页');
        return;
      }
      console.info('[dompdf] rendering');
      setStatusLoading('正在生成 PDF...');
    }
  }

  function updateBenchmarkUi() {
    document.getElementById('benchmark-mode-light').classList.toggle('active', benchmarkMode === 'light');
    document.getElementById('benchmark-mode-heavy').classList.toggle('active', benchmarkMode === 'heavy');
    document.getElementById('benchmark-mode-extreme').classList.toggle('active', benchmarkMode === 'extreme');
    if (benchmarkCompressToggleEl) benchmarkCompressToggleEl.checked = benchmarkCompressEnabled;
    if (benchmarkCompressLabelEl) {
      benchmarkCompressLabelEl.textContent = benchmarkCompressEnabled ? '开启' : '关闭';
    }
    if (benchmarkMetaEl) {
      benchmarkMetaEl.textContent = benchmarkMode === 'light'
        ? ('当前模式：轻量基准 ·1 组短文本' + (benchmarkCompressEnabled ? ' · 压缩开启' : ' · 压缩关闭'))
        : benchmarkMode === 'extreme'
          ? (benchmarkBuildInProgress
            ? '当前模式：10000页测试 · 正在生成 8940 组超长文本'
            : '当前模式：10000页测试 · 8940 组超长文本') + (benchmarkCompressEnabled ? ' · 压缩开启' : ' · 压缩关闭')
          : ('当前模式：重压测 · 440 组超长文本' + (benchmarkCompressEnabled ? ' · 压缩开启' : ' · 压缩关闭'));
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
        throw new Error('中文字体尚未加载完成，请稍后重试');
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
      showMiniToast('Markdown 编辑器资源尚未加载完成，请稍候…');
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
    setStatusLoading(benchmarkMode === 'extreme' ? '正在生成 10000 页测试样本...' : '正在重建基准样本...');
    rebuildBenchmarkSample()
      .then(function () {
        setStatus(benchmarkMode === 'extreme' ? '10000 页测试样本已显示' : '基准样本已更新');
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
      marginPt: 0,
      backgroundColor: '#ffffff',
      useCORS: true,
      fontConfig: symbolFontConfig
        ? [sharedFontConfig, symbolFontConfig]
        : sharedFontConfig,
      pageConfig: {
        excludePages: [1],
        header: {
          content: 'dompdf.js Studio Demo',
          height: 50,
          contentColor: '#334155',
          contentFontSize: 12,
          contentPosition: 'center',
          padding: [0, 0, 0, 0]
        },
        footer: {
          content: '第 ${currentPage} 页 / 共 ${totalPages} 页',
          height: 48,
          contentColor: '#475569',
          contentFontSize: 11,
          contentPosition: 'center',
          padding: [0, 0, 0, 0]
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
        ? (formatBytes(data.size) + '（疑似空白PDF）')
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
      speedDelta.innerText = '⚡ dompdf.js 快了 ' + speedRatio.toFixed(1) + ' 倍';
    } else {
      speedDelta.className = 'metric-delta';
      speedDelta.innerText = 'html2pdf 快了 ' + (1 / speedRatio).toFixed(1) + ' 倍';
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
      sizeDelta.innerText = '📉 dompdf.js 体积缩减 ' + sizeDiffPct.toFixed(1) + '%';
    } else {
      sizeDelta.className = 'metric-delta';
      sizeDelta.innerText = '📈 dompdf.js 体积增加 ' + (-sizeDiffPct).toFixed(1) + '%';
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
        btn.title = '中文字体加载中，请稍候…';
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
      setStatusLoading('运行 dompdf.js...');
      var target = null;
      return ensureDemoReady()
        .then(function () { return ensureBenchmarkSampleReady(); })
        .then(function () {
          setStatusLoading('运行 dompdf.js...');
          target = getExportTarget();
          return measureEngine('dompdf', function () { return renderWithDompdf(target); });
        })
        .then(function (result) {
          downloadBlob(result.blob, 'dompdf-studio-demo.pdf');
          updateMetricsUI('dompdf');
          setStatus('dompdf.js 导出完成 · ' + formatDuration(result.durationMs) + ' · ' + formatBytes(result.sizeBytes));
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
      setStatusLoading('运行 html2pdf.js...');
      var target = null;
      return ensureDemoReady()
        .then(function () { return ensureBenchmarkSampleReady(); })
        .then(function () {
          setStatusLoading('运行 html2pdf.js...');
          target = getHtml2PdfTarget();
          return measureEngine('html2pdf', function () { return renderWithHtml2Pdf(target); });
        })
        .then(function (result) {
          downloadBlob(result.blob, 'html2pdf-studio-demo.pdf');
          updateMetricsUI('html2pdf');
          setStatus(
            'html2pdf.js 导出完成 · ' +
            formatDuration(result.durationMs) + ' · ' +
            formatBytes(result.sizeBytes) +
            (result.blankPdfSuspected ? ' · 疑似空白PDF' : '')
          );
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
      setStatusLoading('正在对比 dompdf.js...');
      var target = null;
      var htmlTarget = null;
      return ensureDemoReady()
        .then(function () { return ensureBenchmarkSampleReady(); })
        .then(function () {
          setStatusLoading('正在对比 dompdf.js...');
          target = getExportTarget();
          return measureEngine('dompdf', function () { return renderWithDompdf(target); });
        })
        .then(function () {
          updateMetricsUI('dompdf');
          setStatusLoading('正在对比 html2pdf.js...');
          // Need a fresh target for html2pdf
          cleanupTarget(target);
          target = null;
          htmlTarget = getHtml2PdfTarget();
          return measureEngine('html2pdf', function () { return renderWithHtml2Pdf(htmlTarget); })
            .then(function () {
              updateMetricsUI('html2pdf');
              setStatus(
                generatedBlobs.html2pdf && generatedBlobs.html2pdf.blankPdfSuspected
                  ? '对比完成 · html2pdf.js 疑似空白PDF'
                  : '对比完成'
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
    ctx.fillText('Small raster sample', 40, 26);
    ctx.fillStyle = '#60758d';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('Used only to validate image embedding and compression.', 40, 46);
    return canvas.toDataURL('image/jpeg', 0.86);
  }

  /* ========================= Appendix Builders ========================= */
  function buildRecordsTable() {
    var body = document.getElementById('records-body');
    if (!body) return;
    body.innerHTML = '';

    var baseGroups = [
      {
        group: 'North Region / Urban Renewal',
        statusText: 'Exceeded',
        statusClass: 'is-good',
        rows: [
          ['$12.4M', '36.2%', '$14.8M', '38.0%'],
          ['$8.2M', '28.5%', '$9.5M', '30.2%']
        ]
      },
      {
        group: 'Asia-Pacific / Procurement',
        statusText: 'On Target',
        statusClass: 'is-stable',
        rows: [
          ['$14.1M', '32.8%', '$16.5M', '34.5%'],
          ['$5.6M', '14.3%', '$6.2M', '15.1%']
        ]
      },
      {
        group: 'Europe / Compliance Archive',
        statusText: 'Watch',
        statusClass: 'is-watch',
        rows: [
          ['$9.7M', '24.8%', '$10.9M', '26.1%'],
          ['$4.4M', '11.6%', '$4.9M', '12.2%']
        ]
      },
      {
        group: 'Public Sector / Delivery Ops',
        statusText: 'Exceeded',
        statusClass: 'is-good',
        rows: [
          ['$11.3M', '34.7%', '$13.2M', '35.8%'],
          ['$6.8M', '19.4%', '$7.6M', '20.6%']
        ]
      }
    ];

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

    var entries = benchmarkMode === 'light'
      ? 'This lightweight benchmark keeps the appendix intentionally short so you can focus on raw pagination throughput without amplifying text shaping, wrapping, and compression costs too aggressively.'
      : ('This appendix intentionally uses a single extra-long English paragraph to stress the PDF pipeline with sustained text flow, repeated clauses, dense punctuation, and business-style wording so that pagination, line breaking, glyph mapping, text extraction order, copy and search behavior, and final file size differences become easier to observe across many repeated blocks; the goal is not decorative content but a realistic wall of text that behaves like procurement documentation, compliance reports, technical specifications, audit notes, migration guidance, implementation summaries, delivery constraints, and appendix remarks merged into one uninterrupted narrative where every sentence keeps pushing the layout engine to preserve semantic reading order, stable wrapping, predictable page boundaries, and compact vector-first output instead of falling back to page-sized bitmap capture that tends to grow much faster as document length increases. ').repeat(5).trim();
    var repeatCount = benchmarkMode === 'light' ? 1 : benchmarkMode === 'extreme' ? 8940 : 440;
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
    topbarPageInfo.textContent = '总计约 ' + Math.max(1, docEl.scrollHeight / 1123).toFixed(1) + ' 页';
  }

  /* ========================= Markdown Editor ========================= */
  function initMarkdownEditor() {
    if (vditor) return;
    if (!markedApi || typeof markedApi.parse !== 'function' || !purifier) {
      setStatus('Markdown 依赖加载失败', true);
      return;
    }

    markedApi.setOptions({ gfm: true, breaks: true });

    vditor = new Vditor('vditor-container', {
      mode: 'ir',
      height: '100%',
      placeholder: '在此开始输入 Markdown 内容...',
      cache: { enable: false },
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
    document.getElementById('md-char-count').textContent = s.length + ' 字符';
    document.getElementById('md-word-count').textContent = ((s.trim().match(/[A-Za-z0-9_]+/g) || []).length) + ' 词';
    document.getElementById('md-line-count').textContent = s.split(/\r?\n/).length + ' 行';
    var sheet = document.getElementById('preview-sheet');
    document.getElementById('md-page-count').textContent = '约 ' + Math.max(1, sheet.scrollHeight / 1123).toFixed(1) + ' 页';
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
    setStatus('dist/dompdf.js 未找到，请先执行 npm run build。', true);
    return;
  }

  setStatusLoading('正在加载字体与编辑器资源...');
  setExportButtonsEnabled(false); // 字体就绪前禁用导出/对比按钮
  updateBenchmarkUi();
  buildRecordsTable();
  buildLongList();
  updateDocPageInfo();
  document.getElementById('sample-img').src = createChartDataUrl();
  window.addEventListener('resize', updateDocPageInfo);

  // Preload html2pdf
  ensureHtml2Pdf().catch(function () { });
  ensurePdfJs().catch(function () { });

  // Load fonts
  Promise.all([loadFont(), loadSymbolFont()])
    .then(function () {
      setStatus(symbolFontConfig ? 'ready (symbol font loaded)' : 'ready');
    })
    .catch(function (err) {
      setStatus('字体加载警告: ' + err.message, true);
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

