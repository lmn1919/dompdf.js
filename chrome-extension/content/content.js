/**
 * DomPDF Chrome Extension — Content Script
 * 元素选择引擎 + dompdf 导出逻辑
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__dompdfExtInjected) return;
  window.__dompdfExtInjected = true;

  // ---- 状态 ----
  let selectMode = false;
  let hoveredElement = null;
  let selectedElement = null;
  let childHistory = []; // 记录下级导航路径
  let exportOptions = {};

  // ---- UI 元素引用 ----
  let overlay = null;
  let highlightBox = null;
  let tooltipEl = null;
  let toolbarEl = null;

  // ---- 监听来自 service-worker/popup 的消息 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'do-export') {
      exportOptions = msg.options || {};
      if (msg.mode === 'select') {
        enterSelectMode();
      } else {
        doFullPageExport();
      }
    }
  });

  // ============================================================
  //  模块 1：元素选择引擎
  // ============================================================

  function enterSelectMode() {
    if (selectMode) return;
    selectMode = true;
    selectedElement = null;
    childHistory = [];

    createOverlay();
    createHighlightBox();
    createTooltip();

    document.addEventListener('keydown', onKeyDown, true);
  }

  function exitSelectMode() {
    selectMode = false;
    hoveredElement = null;
    selectedElement = null;
    childHistory = [];

    removeOverlay();
    removeHighlightBox();
    removeTooltip();
    removeToolbar();

    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ---- 覆盖层（拦截点击） ----
  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'dompdf-overlay';
    document.documentElement.appendChild(overlay);

    overlay.addEventListener('mousemove', onOverlayMouseMove, true);
    overlay.addEventListener('click', onOverlayClick, true);
  }

  function removeOverlay() {
    if (overlay) {
      overlay.removeEventListener('mousemove', onOverlayMouseMove, true);
      overlay.removeEventListener('click', onOverlayClick, true);
      overlay.remove();
      overlay = null;
    }
  }

  // ---- 高亮框 ----
  function createHighlightBox() {
    if (highlightBox) return;
    highlightBox = document.createElement('div');
    highlightBox.id = 'dompdf-highlight';
    document.documentElement.appendChild(highlightBox);
  }

  function removeHighlightBox() {
    if (highlightBox) {
      highlightBox.remove();
      highlightBox = null;
    }
  }

  function updateHighlight(el) {
    if (!highlightBox || !el) return;
    const rect = el.getBoundingClientRect();
    highlightBox.style.top = rect.top + 'px';
    highlightBox.style.left = rect.left + 'px';
    highlightBox.style.width = rect.width + 'px';
    highlightBox.style.height = rect.height + 'px';
    highlightBox.style.display = 'block';
  }

  // ---- Tooltip ----
  function createTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'dompdf-tooltip';
    tooltipEl.style.display = 'none';
    document.documentElement.appendChild(tooltipEl);
  }

  function removeTooltip() {
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  }

  function updateTooltip(el, mouseX, mouseY) {
    if (!tooltipEl || !el) return;

    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const classes = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.')
      : '';
    const rect = el.getBoundingClientRect();
    const sizeStr = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

    tooltipEl.innerHTML =
      `<span class="tag-name">${tag}</span>` +
      (id ? `<span class="id-name">${id}</span>` : '') +
      (classes ? `<span class="class-name">${classes}</span>` : '') +
      `<span class="size-info">${sizeStr}</span>`;

    // 定位在元素上方
    let top = rect.top - 28;
    let left = rect.left;

    if (top < 4) top = rect.bottom + 4;
    if (left < 4) left = 4;

    tooltipEl.style.top = top + 'px';
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.display = 'block';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  // ---- 鼠标事件 ----
  function onOverlayMouseMove(e) {
    if (selectedElement) return; // 已选中则不再响应悬停

    // 临时隐藏 overlay 来获取下层元素
    overlay.style.pointerEvents = 'none';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.pointerEvents = 'auto';

    if (!el || el === document.documentElement || el === document.body) {
      hoveredElement = null;
      if (highlightBox) highlightBox.style.display = 'none';
      hideTooltip();
      return;
    }

    // 忽略插件自身创建的元素
    if (isDompdfElement(el)) {
      hoveredElement = null;
      if (highlightBox) highlightBox.style.display = 'none';
      hideTooltip();
      return;
    }

    hoveredElement = el;
    updateHighlight(el);
    updateTooltip(el, e.clientX, e.clientY);
  }

  function onOverlayClick(e) {
    e.preventDefault();
    e.stopPropagation();

    if (selectedElement) return;
    if (!hoveredElement) return;

    selectedElement = hoveredElement;
    childHistory = [];
    highlightBox.classList.add('selected');
    hideTooltip();
    showToolbar(selectedElement);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      exitSelectMode();
    }
  }

  // ---- 判断是否为插件元素 ----
  function isDompdfElement(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      if (node.id && node.id.startsWith('dompdf-')) return true;
      node = node.parentElement;
    }
    return false;
  }

  // ============================================================
  //  模块 2：浮动工具栏
  // ============================================================

  function showToolbar(el) {
    removeToolbar();

    toolbarEl = document.createElement('div');
    toolbarEl.id = 'dompdf-toolbar';

    // 节点信息
    const nodeInfo = document.createElement('span');
    nodeInfo.className = 'tb-node-info';
    nodeInfo.textContent = getNodeLabel(el);
    toolbarEl.appendChild(nodeInfo);

    toolbarEl.appendChild(createSep());

    // ⬆️ 上一层
    const btnUp = createBtn('⬆', '上一层', '', () => {
      if (!selectedElement || !selectedElement.parentElement) return;
      if (selectedElement.parentElement === document.documentElement) return;
      childHistory.push(selectedElement);
      selectedElement = selectedElement.parentElement;
      updateHighlight(selectedElement);
      nodeInfo.textContent = getNodeLabel(selectedElement);
      btnDown.disabled = false;
      // 到顶了禁用
      if (!selectedElement.parentElement || selectedElement.parentElement === document.documentElement) {
        btnUp.disabled = true;
      }
    });
    toolbarEl.appendChild(btnUp);

    // ⬇️ 下一层
    const btnDown = createBtn('⬇', '下一层', '', () => {
      if (childHistory.length === 0) return;
      selectedElement = childHistory.pop();
      updateHighlight(selectedElement);
      nodeInfo.textContent = getNodeLabel(selectedElement);
      btnUp.disabled = false;
      if (childHistory.length === 0) btnDown.disabled = true;
    });
    btnDown.disabled = true; // 初始禁用
    toolbarEl.appendChild(btnDown);

    toolbarEl.appendChild(createSep());

    // ✅ 确认导出
    const btnConfirm = createBtn('', '导出', 'primary', () => {
      const targetEl = selectedElement;
      exitSelectMode();
      doExport(targetEl);
    });
    toolbarEl.appendChild(btnConfirm);

    // 🔄 重新选择
    const btnReselect = createBtn('', '重选', '', () => {
      selectedElement = null;
      childHistory = [];
      highlightBox.classList.remove('selected');
      if (highlightBox) highlightBox.style.display = 'none';
      removeToolbar();
    });
    toolbarEl.appendChild(btnReselect);

    // ❌ 取消
    const btnCancel = createBtn('', '取消', 'danger', () => {
      exitSelectMode();
    });
    toolbarEl.appendChild(btnCancel);

    document.documentElement.appendChild(toolbarEl);
    positionToolbar(el);
  }

  function removeToolbar() {
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
  }

  function createBtn(icon, text, cls, onClick) {
    const btn = document.createElement('button');
    btn.className = 'tb-btn' + (cls ? ' ' + cls : '');
    btn.textContent = (icon ? icon + ' ' : '') + text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function createSep() {
    const sep = document.createElement('span');
    sep.className = 'tb-sep';
    return sep;
  }

  function getNodeLabel(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return `<${tag}${id}${cls}>`;
  }

  function positionToolbar(el) {
    if (!toolbarEl) return;
    const rect = el.getBoundingClientRect();
    const tbRect = toolbarEl.getBoundingClientRect();

    let top = rect.top - tbRect.height - 8;
    let left = rect.left;

    // 如果上方空间不够，放到下方
    if (top < 4) {
      top = rect.bottom + 8;
    }

    // 右侧越界修正
    if (left + tbRect.width > window.innerWidth - 4) {
      left = window.innerWidth - tbRect.width - 4;
    }

    if (left < 4) left = 4;

    toolbarEl.style.top = top + 'px';
    toolbarEl.style.left = left + 'px';
  }

  // ============================================================
  //  模块 3：导出执行（通过 CustomEvent 与主世界桥接）
  // ============================================================

  function doFullPageExport() {
    doExport(document.documentElement);
  }

  async function doExport(targetElement) {
    const progressUI = showProgressOverlay();

    try {
      // 1. 标记目标元素，让主世界桥接脚本能找到它
      targetElement.setAttribute('data-dompdf-export-target', '1');

      // 2. 准备字体信息
      let fontUrl = '';
      if (exportOptions.useBuiltinFont !== false) {
        try {
          fontUrl = chrome.runtime.getURL('fonts/SourceHanSansSC-Regular.ttf');
        } catch (e) {
          console.warn('[DomPDF] Cannot get builtin font URL:', e);
        }
      }

      // 获取用户自定义字体数据
      let customFontsJSON = '[]';
      try {
        const result = await chrome.storage.local.get('customFonts');
        const customFonts = result.customFonts || [];
        // 传递给主世界（只传 base64 和名称，不传 Uint8Array）
        customFontsJSON = JSON.stringify(customFonts.map(f => ({
          familyName: f.familyName,
          base64: f.base64,
        })));
      } catch (e) {
        console.warn('[DomPDF] Failed to load custom fonts:', e);
      }

      // 3. 准备导出选项（移除不可序列化的字段）
      const serializableOptions = { ...exportOptions };
      delete serializableOptions.useBuiltinFont;
      delete serializableOptions.onProgress;
      const optionsJSON = JSON.stringify(serializableOptions);

      // 4. 监听主世界返回的事件
      const cleanup = setupBridgeListeners(progressUI);

      // 5. 发送导出请求到主世界
      document.dispatchEvent(new CustomEvent('dompdf-export-request', {
        detail: {
          optionsJSON,
          fontUrl,
          customFontsJSON,
        },
      }));

    } catch (err) {
      console.error('[DomPDF Extension] Export error:', err);
      targetElement.removeAttribute('data-dompdf-export-target');
      removeProgressOverlay(progressUI);
      showToast('导出失败: ' + err.message);

      chrome.runtime.sendMessage({
        type: 'export-error',
        error: err.message,
      }).catch(() => {});
    }
  }

  // ---- 监听主世界桥接事件 ----
  function setupBridgeListeners(progressUI) {
    function onProgress(e) {
      const { stage, currentPage, totalPages } = e.detail || {};
      updateProgressOverlay(progressUI, { stage, currentPage, totalPages });

      chrome.runtime.sendMessage({
        type: 'export-progress',
        stage, currentPage, totalPages,
      }).catch(() => {});
    }

    function onDone(e) {
      const { dataUrl } = e.detail || {};
      removeProgressOverlay(progressUI);

      if (dataUrl) {
        const title = document.title.replace(/[<>:"/\\|?*]/g, '_').substring(0, 100);
        const filename = (title || 'page') + '.pdf';

        chrome.runtime.sendMessage({
          type: 'download-pdf',
          dataUrl,
          filename,
        });

        chrome.runtime.sendMessage({
          type: 'export-progress',
          stage: 'done',
        }).catch(() => {});

        showToast('PDF 导出成功！');
      }

      cleanup();
    }

    function onError(e) {
      const { error } = e.detail || {};
      removeProgressOverlay(progressUI);
      showToast('导出失败: ' + (error || '未知错误'));

      chrome.runtime.sendMessage({
        type: 'export-error',
        error: error || '未知错误',
      }).catch(() => {});

      cleanup();
    }

    document.addEventListener('dompdf-export-progress', onProgress);
    document.addEventListener('dompdf-export-done', onDone);
    document.addEventListener('dompdf-export-error', onError);

    function cleanup() {
      document.removeEventListener('dompdf-export-progress', onProgress);
      document.removeEventListener('dompdf-export-done', onDone);
      document.removeEventListener('dompdf-export-error', onError);
    }

    return cleanup;
  }

  // ============================================================
  //  模块 4：进度浮层
  // ============================================================

  function showProgressOverlay() {
    const existing = document.getElementById('dompdf-progress-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dompdf-progress-overlay';

    const card = document.createElement('div');
    card.id = 'dompdf-progress-card';
    card.innerHTML = `
      <div class="prog-title">正在生成 PDF</div>
      <div class="prog-bar-track">
        <div class="prog-bar-fill" id="dompdf-prog-fill"></div>
      </div>
      <div class="prog-text" id="dompdf-prog-text">准备中...</div>
    `;

    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);

    return {
      overlay,
      fill: card.querySelector('#dompdf-prog-fill'),
      text: card.querySelector('#dompdf-prog-text'),
    };
  }

  function updateProgressOverlay(ui, progress) {
    if (!ui) return;
    const { stage, currentPage, totalPages } = progress;

    if (stage === 'collecting') {
      ui.fill.style.width = '10%';
      ui.text.textContent = '正在收集页面数据...';
    } else if (stage === 'countingPages') {
      ui.fill.style.width = '30%';
      ui.text.textContent = `正在计算分页 (共 ${totalPages} 页)...`;
    } else if (stage === 'rendering' && totalPages) {
      const pct = 30 + ((currentPage / totalPages) * 60);
      ui.fill.style.width = pct + '%';
      ui.text.textContent = `正在渲染 ${currentPage}/${totalPages}...`;
    } else if (stage === 'done') {
      ui.fill.style.width = '100%';
      ui.text.textContent = '完成！';
    }
  }

  function removeProgressOverlay(ui) {
    if (ui && ui.overlay) {
      ui.overlay.remove();
    }
  }

  // ---- Toast ----
  function showToast(message) {
    const existing = document.getElementById('dompdf-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'dompdf-toast';
    toast.textContent = message;
    document.documentElement.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

})();

