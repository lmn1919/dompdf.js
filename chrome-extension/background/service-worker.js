/**
 * DomPDF Chrome Extension — Service Worker
 * 消息路由 + 动态注入 + 下载管理
 *
 * 注入策略：
 *   1. content-main.js → MAIN world（加载 CDN dompdf + 调用 dompdf API）
 *   2. content.css → 样式
 *   3. content.js → CONTENT world（选择 UI + chrome.runtime 通信）
 *   两个世界通过 CustomEvent 在 DOM 上通信。
 */

// ---- 消息路由 ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start-export') {
    handleStartExport(msg);
  } else if (msg.type === 'start-select-mode') {
    handleSelectMode(msg);
  } else if (msg.type === 'download-pdf') {
    handleDownload(msg, sender);
  } else if (msg.type === 'export-progress' || msg.type === 'export-error') {
    // 转发给 popup
    chrome.runtime.sendMessage(msg).catch(() => { });
  }
  return true;
});

// ---- 注入所有脚本 ----
async function injectAllScripts(tabId) {
  // 1. 注入本地 dompdf.min.js 到主世界
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['lib/dompdf.min.js'],
  });

  // 2. 注入主世界桥接脚本（执行导出）
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content/content-main.js'],
  });

  // 3. 注入样式
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content/content.css'],
  });

  // 4. 注入内容脚本（隔离世界，用于 chrome API 和 UI）
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content.js'],
  });
}

// ---- 整页导出 ----
async function handleStartExport(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    await injectAllScripts(tab.id);

    chrome.tabs.sendMessage(tab.id, {
      type: 'do-export',
      mode: 'fullpage',
      options: msg.options,
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'export-error',
      error: err.message,
    }).catch(() => { });
  }
}

// ---- 选择元素模式 ----
async function handleSelectMode(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    await injectAllScripts(tab.id);

    chrome.tabs.sendMessage(tab.id, {
      type: 'do-export',
      mode: 'select',
      options: msg.options,
    });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: 'export-error',
      error: err.message,
    }).catch(() => { });
  }
}

// ---- 下载 PDF ----
async function handleDownload(msg, sender) {
  const { dataUrl, filename } = msg;

  try {
    await chrome.downloads.download({
      url: dataUrl,
      filename: filename || 'page.pdf',
      saveAs: true,
    });

    // 记录到历史
    const result = await chrome.storage.local.get('exportHistory');
    const history = result.exportHistory || [];
    history.unshift({
      filename: filename || 'page.pdf',
      timestamp: Date.now(),
      url: sender.tab ? sender.tab.url : '',
      title: sender.tab ? sender.tab.title : '',
    });
    if (history.length > 20) history.length = 20;
    await chrome.storage.local.set({ exportHistory: history });
  } catch (err) {
    console.error('Download failed:', err);
  }
}
