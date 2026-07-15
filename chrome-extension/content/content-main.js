/**
 * DomPDF Chrome Extension — Main World Bridge
 * 运行在页面主世界 (MAIN world)，负责调用 window.dompdf()
 * 与 content.js (CONTENT/隔离世界) 通过 CustomEvent 通信
 */

(function () {
  'use strict';

  if (window.__dompdfMainBridge) return;
  window.__dompdfMainBridge = true;

  // ---- 加载 dompdf 库 ----
  function loadDompdfLib() {
    return new Promise((resolve, reject) => {
      if (window.dompdf) {
        resolve();
      } else {
        reject(new Error('Local dompdf.min.js not loaded on page'));
      }
    });
  }

  // ---- 监听导出请求 (来自 content.js CONTENT world) ----
  document.addEventListener('dompdf-export-request', async (e) => {
    let options;
    try {
      options = JSON.parse(e.detail.optionsJSON);
    } catch {
      options = {};
    }

    const fontUrl = e.detail.fontUrl || '';
    let customFontsData;
    try {
      customFontsData = JSON.parse(e.detail.customFontsJSON || '[]');
    } catch {
      customFontsData = [];
    }

    // 1. 找到标记的目标元素
    const targetEl = document.querySelector('[data-dompdf-export-target]');
    if (!targetEl) {
      sendEvent('dompdf-export-error', { error: '未找到目标元素' });
      return;
    }

    try {
      // 2. 确保 dompdf 已加载
      sendEvent('dompdf-export-progress', { stage: 'collecting' });
      await loadDompdfLib();

      // 3. 准备字体配置
      const fontConfigs = [];

      if (fontUrl) {
        try {
          const resp = await fetch(fontUrl);
          const buffer = await resp.arrayBuffer();
          fontConfigs.push({
            fontFamily: 'SourceHanSansSC-Regular',
            fontBytes: new Uint8Array(buffer),
            fontStyle: 'normal',
            fontWeight: 400,
          });
        } catch (err) {
          console.warn('[DomPDF] Failed to load builtin font:', err);
        }
      }

      for (const font of customFontsData) {
        if (font.base64) {
          try {
            const binary = atob(font.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            fontConfigs.push({
              fontFamily: font.familyName,
              fontBytes: bytes,
              fontStyle: 'normal',
              fontWeight: 400,
            });
          } catch (err) {
            console.warn('[DomPDF] Failed to decode custom font:', font.familyName, err);
          }
        }
      }

      if (fontConfigs.length > 0) {
        fontConfigs.forEach(f => {
          f.isDefault = true;
        });
        options.fontConfig = fontConfigs;
        options.langFontConfig = fontConfigs;
      }

      // 4. 进度回调
      options.onProgress = (progress) => {
        sendEvent('dompdf-export-progress', {
          stage: progress.stage,
          currentPage: progress.currentPage,
          totalPages: progress.totalPages,
        });
      };

      // 5. 调用 dompdf
      const blob = await window.dompdf(targetEl, options);

      // 6. 转为 data URL
      const reader = new FileReader();
      reader.onload = () => {
        sendEvent('dompdf-export-done', { dataUrl: reader.result });
      };
      reader.onerror = () => {
        sendEvent('dompdf-export-error', { error: 'Failed to convert PDF to data URL' });
      };
      reader.readAsDataURL(blob);

    } catch (err) {
      console.error('[DomPDF Main] Export error:', err);
      sendEvent('dompdf-export-error', { error: err.message || String(err) });
    } finally {
      targetEl.removeAttribute('data-dompdf-export-target');
    }
  });

  function sendEvent(name, detail) {
    document.dispatchEvent(new CustomEvent(name, { detail }));
  }

})();
