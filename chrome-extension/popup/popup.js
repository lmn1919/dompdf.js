/**
 * DomPDF Chrome Extension — Popup Logic
 * 配置管理 + 消息通信
 */

(function () {
  'use strict';

  // ---- 状态 ----
  let currentMode = 'fullpage'; // 'fullpage' | 'select'
  let isExporting = false;

  // ---- DOM 引用 ----
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const modeTabs = $$('.mode-tab');
  const formatSelect = $('#format');
  const customSizeGroup = $('#customSizeGroup');
  const btnExport = $('#btnExport');
  const btnExportText = $('#btnExportText');
  const progressArea = $('#progressArea');
  const progressFill = $('#progressFill');
  const progressText = $('#progressText');

  // ---- 折叠面板 ----
  $$('.collapse-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const target = document.getElementById(toggle.dataset.target);
      const isExpanded = target.classList.contains('show');
      target.classList.toggle('show', !isExpanded);
      toggle.classList.toggle('expanded', !isExpanded);
    });
  });

  // ---- Toggle → 子面板显隐 ----
  const togglePanelMap = {
    headerEnabled: 'headerConfig',
    footerEnabled: 'footerConfig',
    watermarkEnabled: 'watermarkConfig',
    encryptionEnabled: 'encryptionConfig',
  };

  Object.entries(togglePanelMap).forEach(([toggleId, panelId]) => {
    const toggle = $(`#${toggleId}`);
    const panel = $(`#${panelId}`);
    if (toggle && panel) {
      toggle.addEventListener('change', () => {
        panel.classList.toggle('hidden', !toggle.checked);
      });
    }
  });

  // ---- 纸张大小 ---- 
  formatSelect.addEventListener('change', () => {
    customSizeGroup.classList.toggle('hidden', formatSelect.value !== 'custom');
  });

  // ---- 模式切换 ----
  modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      modeTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentMode = tab.dataset.mode;

      // 选择元素模式下修改按钮文案
      if (currentMode === 'select') {
        btnExportText.textContent = '选择元素';
      } else {
        btnExportText.textContent = '生成 PDF';
      }
    });
  });

  // ---- 字体管理 ----
  const fontUploadInput = $('#fontUpload');
  const customFontsList = $('#customFontsList');

  // 加载已上传的字体列表
  async function loadCustomFonts() {
    const result = await chrome.storage.local.get('customFonts');
    const fonts = result.customFonts || [];
    renderCustomFonts(fonts);
  }

  function renderCustomFonts(fonts) {
    customFontsList.innerHTML = '';
    fonts.forEach((font, index) => {
      const item = document.createElement('div');
      item.className = 'custom-font-item';
      item.innerHTML = `
        <div class="font-info">
          <span class="font-name">${font.name}</span>
          <span class="font-hint">${formatFileSize(font.size)}</span>
        </div>
        <button class="font-delete-btn" data-index="${index}" title="删除">×</button>
      `;
      customFontsList.appendChild(item);
    });

    // 删除按钮
    customFontsList.querySelectorAll('.font-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.index, 10);
        const result = await chrome.storage.local.get('customFonts');
        const fonts = result.customFonts || [];
        fonts.splice(idx, 1);
        await chrome.storage.local.set({ customFonts: fonts });
        renderCustomFonts(fonts);
      });
    });
  }

  fontUploadInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buffer);

    const result = await chrome.storage.local.get('customFonts');
    const fonts = result.customFonts || [];

    // 避免重复
    if (fonts.some((f) => f.name === file.name)) {
      fontUploadInput.value = '';
      return;
    }

    fonts.push({
      name: file.name,
      familyName: file.name.replace(/\.(ttf|otf)$/i, ''),
      base64: base64,
      size: file.size,
    });

    await chrome.storage.local.set({ customFonts: fonts });
    renderCustomFonts(fonts);
    fontUploadInput.value = '';
  });

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---- 收集导出选项 ----
  function collectOptions() {
    const format = formatSelect.value;
    const options = {
      pagination: $('#pagination').checked,
      compress: $('#compress').checked,
      orientation: $('#orientation').value,
      marginPt: [
        parseInt($('#marginTop').value) || 0,
        parseInt($('#marginRight').value) || 0,
        parseInt($('#marginBottom').value) || 0,
        parseInt($('#marginLeft').value) || 0,
      ],
      useCORS: true,
    };

    // 纸张
    if (format === 'custom') {
      const w = parseFloat($('#customWidth').value) || 210;
      const h = parseFloat($('#customHeight').value) || 297;
      // mm to pt: 1mm = 2.83465pt
      options.format = [w * 2.83465, h * 2.83465];
    } else {
      options.format = format;
    }

    // 页眉
    if ($('#headerEnabled').checked) {
      options.pageConfig = options.pageConfig || {};
      options.pageConfig.header = {
        content: $('#headerContent').value || '',
        height: parseInt($('#headerHeight').value) || 40,
        contentFontSize: parseInt($('#headerFontSize').value) || 10,
        contentPosition: $('#headerPosition').value,
      };
    }

    // 页脚
    if ($('#footerEnabled').checked) {
      options.pageConfig = options.pageConfig || {};
      options.pageConfig.footer = {
        content: $('#footerContent').value || 'Page ${currentPage} / ${totalPages}',
        height: parseInt($('#footerHeight').value) || 40,
        contentFontSize: parseInt($('#footerFontSize').value) || 10,
        contentPosition: $('#footerPosition').value,
      };
    }

    // 水印
    if ($('#watermarkEnabled').checked) {
      options.watermark = {
        text: $('#watermarkText').value || '',
        fontSize: parseInt($('#watermarkFontSize').value) || 48,
        angle: parseInt($('#watermarkAngle').value) || -45,
        color: $('#watermarkColor').value || 'rgba(0,0,0,0.08)',
      };
    }

    // 加密
    if ($('#encryptionEnabled').checked) {
      options.encryption = {};
      const userPwd = $('#userPassword').value;
      const ownerPwd = $('#ownerPassword').value;
      if (userPwd) options.encryption.userPassword = userPwd;
      if (ownerPwd) options.encryption.ownerPassword = ownerPwd;
    }

    // 字体
    options.useBuiltinFont = $('#useBuiltinFont').checked;

    return options;
  }

  // ---- 保存/加载设置 ----
  async function saveSettings() {
    const settings = {
      mode: currentMode,
      format: formatSelect.value,
      orientation: $('#orientation').value,
      pagination: $('#pagination').checked,
      compress: $('#compress').checked,
      customWidth: $('#customWidth').value,
      customHeight: $('#customHeight').value,
      marginTop: $('#marginTop').value,
      marginRight: $('#marginRight').value,
      marginBottom: $('#marginBottom').value,
      marginLeft: $('#marginLeft').value,
      useBuiltinFont: $('#useBuiltinFont').checked,
    };
    await chrome.storage.sync.set({ dompdfSettings: settings });
  }

  async function loadSettings() {
    const result = await chrome.storage.sync.get('dompdfSettings');
    const s = result.dompdfSettings;
    if (!s) return;

    if (s.mode) {
      currentMode = s.mode;
      modeTabs.forEach((t) => {
        t.classList.toggle('active', t.dataset.mode === currentMode);
      });
      btnExportText.textContent = currentMode === 'select' ? '选择元素' : '生成 PDF';
    }

    if (s.format) formatSelect.value = s.format;
    if (s.orientation) $('#orientation').value = s.orientation;
    if (s.pagination !== undefined) $('#pagination').checked = s.pagination;
    if (s.compress !== undefined) $('#compress').checked = s.compress;
    if (s.customWidth) $('#customWidth').value = s.customWidth;
    if (s.customHeight) $('#customHeight').value = s.customHeight;
    if (s.marginTop) $('#marginTop').value = s.marginTop;
    if (s.marginRight) $('#marginRight').value = s.marginRight;
    if (s.marginBottom) $('#marginBottom').value = s.marginBottom;
    if (s.marginLeft) $('#marginLeft').value = s.marginLeft;
    if (s.useBuiltinFont !== undefined) $('#useBuiltinFont').checked = s.useBuiltinFont;

    customSizeGroup.classList.toggle('hidden', formatSelect.value !== 'custom');
  }

  // ---- 进度更新 ----
  function showProgress(text, percent) {
    progressArea.classList.remove('hidden');
    progressFill.style.width = percent + '%';
    progressText.textContent = text;
  }

  function hideProgress() {
    progressArea.classList.add('hidden');
    progressFill.style.width = '0%';
  }

  function setExporting(state) {
    isExporting = state;
    btnExport.disabled = state;
    if (state) {
      btnExportText.textContent = '导出中...';
    } else {
      btnExportText.textContent = currentMode === 'select' ? '选择元素' : '生成 PDF';
    }
  }

  // ---- 监听来自 content/service-worker 的消息 ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'export-progress') {
      const { stage, currentPage, totalPages } = msg;
      if (stage === 'collecting') {
        showProgress('正在收集页面数据...', 10);
      } else if (stage === 'countingPages') {
        showProgress(`共 ${totalPages} 页`, 30);
      } else if (stage === 'rendering') {
        const pct = 30 + ((currentPage / totalPages) * 60);
        showProgress(`正在渲染 ${currentPage}/${totalPages}...`, pct);
      } else if (stage === 'done') {
        showProgress('导出完成！', 100);
        setTimeout(() => {
          hideProgress();
          setExporting(false);
        }, 1500);
      }
    } else if (msg.type === 'export-error') {
      showProgress('导出失败: ' + msg.error, 0);
      setTimeout(() => {
        hideProgress();
        setExporting(false);
      }, 3000);
    } else if (msg.type === 'select-mode-done') {
      // 选择模式结束 (元素已选中并导出)
      // popup 可能已关闭，忽略
    }
  });

  // ---- 导出按钮 ----
  btnExport.addEventListener('click', async () => {
    if (isExporting) return;

    await saveSettings();
    const options = collectOptions();

    if (currentMode === 'select') {
      // 发消息给 service-worker，注入 content script 进入选择模式
      chrome.runtime.sendMessage({
        type: 'start-select-mode',
        options: options,
      });
      // 关闭 popup
      window.close();
    } else {
      // 整页导出
      setExporting(true);
      showProgress('正在初始化...', 5);

      chrome.runtime.sendMessage({
        type: 'start-export',
        mode: 'fullpage',
        options: options,
      });
    }
  });

  // ---- 初始化 ----
  loadSettings();
  loadCustomFonts();
})();
