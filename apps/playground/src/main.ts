import dom2pdf, { inspect, computePageBreaks, type ExportOptions, type FontConfig } from 'dom2pdf';
import demo1Source from './demo1-source.html?raw';
import interactiveDemoSource from './interactive-demo-source.html?raw';

type TemplateId = 'report' | 'demo1' | 'interactive';

const host = document.getElementById('document-host') as HTMLElement;
const reportTemplate = document.getElementById('tpl-report') as HTMLTemplateElement;
const templateSelect = document.getElementById('template-select') as HTMLSelectElement;
const status = document.getElementById('status') as HTMLElement;

let currentDoc: HTMLElement;

const sharedFontConfig: FontConfig = {
  fontFamily: 'SourceHanSansSC-Regular',
  fontStyle: 'normal',
  fontWeight: 400,
};

async function loadChineseFont() {
  const res = await fetch('/SourceHanSansSC-Regular.ttf');
  if (!res.ok) throw new Error(`failed to load Chinese font: HTTP ${res.status}`);
  sharedFontConfig.fontBytes = new Uint8Array(await res.arrayBuffer());
}

const reportExportOptions: ExportOptions = {
  format: 'a4',
  pagination: true,
  marginPt: 0,
  backgroundColor: '#ffffff',
  useCORS: true,
  fontConfig: sharedFontConfig,
  pageConfig: {
    header: {
      content: 'dom2pdf · 季度产品报告',
      height: 50,
      contentColor: '#333333',
      contentFontSize: 12,
      contentPosition: 'center',
      padding: [0, 0, 0, 0],
    },
    footer: {
      content: '第 ${currentPage} 页 / 共 ${totalPages} 页',
      height: 50,
      contentColor: '#333333',
      contentFontSize: 12,
      contentPosition: 'center',
      padding: [0, 0, 0, 0],
    },
  },
};

const demo1ExportOptions: ExportOptions = {
  format: 'a4',
  pagination: true,
  marginPt: [20, 0, 20, 0],
  backgroundColor: '#ffffff',
  useCORS: true,
  fontConfig: sharedFontConfig,
  pageConfig: (pageNum, totalPages) => {
    if (pageNum === 1) return null;
    return {
      footer: {
        content: 'Page ${currentPage} / ${totalPages}',
        height: 50,
        contentColor: '#333333',
        contentFontSize: 12,
        contentPosition: 'center',
        padding: [0, 0, 0, 0],
      },
      header: {
        content: `dom2pdf · demo1 · ${pageNum}/${totalPages}`,
        height: 50,
        contentColor: '#333333',
        contentFontSize: 12,
        contentPosition: 'center',
        padding: [0, 0, 0, 0],
      },
    };
  },
};

const interactiveDemoExportOptions: ExportOptions = {
  format: 'a4',
  pagination: true,
  marginPt: 0,
  backgroundColor: '#ffffff',
  useCORS: true,
  fontConfig: sharedFontConfig,
  pageConfig: (pageNum, totalPages) => ({
    header: pageNum === 1 ? {
      content: 'dom2pdf · Interactive Demo',
      height: 52,
      contentColor: '#334155',
      contentFontSize: 12,
      contentPosition: 'center',
      padding: [0, 0, 0, 0],
    } : {
      content: `Interactive Demo · ${pageNum}/${totalPages}`,
      height: 44,
      contentColor: '#475569',
      contentFontSize: 11,
      contentPosition: 'center',
      padding: [0, 0, 0, 0],
    },
    footer: {
      content: 'Page ${currentPage} of ${totalPages}',
      height: 42,
      contentColor: '#64748b',
      contentFontSize: 11,
      contentPosition: 'center',
      padding: [0, 0, 0, 0],
    },
  }),
};

function setStatus(text: string) {
  status.textContent = text;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function currentTemplateId(): TemplateId {
  const value = templateSelect.value;
  if (value === 'demo1') return 'demo1';
  if (value === 'interactive') return 'interactive';
  return 'report';
}

function currentOptions(): ExportOptions {
  const templateId = currentTemplateId();
  if (templateId === 'demo1') return demo1ExportOptions;
  if (templateId === 'interactive') return interactiveDemoExportOptions;
  return reportExportOptions;
}

function currentFilename(): string {
  const templateId = currentTemplateId();
  if (templateId === 'demo1') return 'demo1.pdf';
  if (templateId === 'interactive') return 'interactive-demo.pdf';
  return 'report.pdf';
}

function removeOverlay() {
  document.body.classList.remove('dom2pdf-overlay');
  document.querySelectorAll('.dom2pdf-pagebreak').forEach((n) => n.remove());
}

/** Build the long list so the document spans multiple pages. */
function buildList(root: ParentNode) {
  const list = root.querySelector('#long-list');
  if (!(list instanceof HTMLOListElement)) return;
  list.innerHTML = '';
  const items = [
    'Define the snapshot contract before touching PDF bytes, and keep the runtime input deterministic enough that regressions are attributable to layout changes rather than missing metadata.',
    'Collect rects in document space, not viewport space, especially when sticky toolbars and centered preview canvases are involved.',
    'Slice text nodes into line boxes with UTF-8 byte offsets so the renderer can preserve selection order across long bilingual paragraphs.',
    'Convert every image to JPEG on the JS side to avoid PNG flate complexity and to keep the PDF writer focused on deterministic embedding rules.',
    'Push heavy work into a Web Worker; keep the main thread free even when the page includes large gradient panels, tables, and long ordered lists.',
    'Treat each text line as the minimum unsplittable unit, even when one list item wraps into multiple visual rows near a page boundary.',
    'Move straddling lines to the next page and allow whitespace instead of squeezing the following content upward into unreadable spacing.',
    'Clip overflow:hidden subtrees to their box rectangle so overlapping cards and decorative panels do not bleed outside their intended bounds.',
    'Emit a Base14 Helvetica font with WinAnsiEncoding for L0/L1 text while allowing custom CID fonts to handle Chinese copy and mixed-language paragraphs.',
    'Hand-write the PDF object table, xref, and trailer in pure std so the byte structure remains inspectable and independent of third-party PDF libraries.',
    'Use DCTDecode for JPEG XObjects and verify that repeated assets, canvases, and generated charts remain visually stable across pages.',
    'Verify the output opens in Chrome, Acrobat, and Preview, then compare pagination, clipping, and text selection behavior across readers.',
  ];
  for (let i = 0; i < 72; i++) {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${items[i % items.length]}`;
    list.appendChild(li);
  }
}

function createChartDataUrl(title: string): string {
  const W = 440;
  const H = 280;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1e3a8a');
  bg.addColorStop(1, '#0ea5e9');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  for (let y = 40; y < H - 20; y += 40) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(W - 20, y);
    ctx.stroke();
  }

  const data = [40, 75, 55, 90, 65, 110, 85];
  const barW = 36;
  const gap = 16;
  let x = 56;
  ctx.fillStyle = '#fde68a';
  for (const v of data) {
    const bh = v * 1.6;
    ctx.fillRect(x, H - 30 - bh, barW, bh);
    x += barW + gap;
  }

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(40, H - 30);
  ctx.lineTo(W - 20, H - 30);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(title, 40, 24);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function createCardImageDataUrl(label: string, start: string, end: string): string {
  const W = 320;
  const H = 240;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, start);
  bg.addColorStop(1, end);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(20 + i * 34, 20 + (i % 2) * 12, 18, 180 - i * 14);
  }

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 20px sans-serif';
  ctx.fillText(label, 20, 34);
  ctx.font = '14px sans-serif';
  ctx.fillText('Generated locally for PDF acceptance.', 20, 58);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function paintDemoCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const bg = ctx.createLinearGradient(0, 0, canvas.width, 0);
  bg.addColorStop(0, '#60a5fa');
  bg.addColorStop(1, '#2563eb');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '16px sans-serif';
  ctx.fillText('Canvas Rendering Test', 12, 28);
  ctx.fillStyle = '#f97316';
  for (let i = 0; i < 8; i++) {
    ctx.fillRect(12 + i * 48, 100 - i * 8, 32, i * 8);
  }
}

function buildReportDocument(): HTMLElement {
  const fragment = reportTemplate.content.cloneNode(true) as DocumentFragment;
  buildList(fragment);
  const img = fragment.querySelector('#sample-img') as HTMLImageElement | null;
  if (img) img.src = createChartDataUrl('Weekly engagement');
  const doc = fragment.querySelector('#document');
  if (!(doc instanceof HTMLElement)) throw new Error('report template missing #document');
  host.replaceChildren(fragment);
  return host.querySelector('#document') as HTMLElement;
}

function buildDemo1Document(): HTMLElement {
  const parsed = new DOMParser().parseFromString(demo1Source, 'text/html');
  const captureArea = parsed.getElementById('capture-area');
  if (!(captureArea instanceof HTMLElement)) throw new Error('demo1 template missing #capture-area');

  captureArea.id = 'document';
  captureArea.classList.add('demo1-doc');
  captureArea.setAttribute('data-template-id', 'demo1');
  captureArea.style.margin = '0 auto';
  captureArea.style.marginTop = '0';

  const submit = captureArea.querySelector('button.btn');
  if (submit) submit.className = 'demo-btn';

  const docMarkup = document.importNode(captureArea, true) as HTMLElement;
  host.replaceChildren(docMarkup);

  const imgs = host.querySelectorAll('img');
  const imgSources = [
    createCardImageDataUrl('Demo Image A', '#0ea5e9', '#2563eb'),
    createCardImageDataUrl('Demo Image B', '#fb7185', '#f97316'),
  ];
  imgs.forEach((img, index) => {
    img.src = imgSources[index % imgSources.length];
  });

  const canvas = host.querySelector('#demo-canvas');
  if (canvas instanceof HTMLCanvasElement) {
    paintDemoCanvas(canvas);
  }

  return host.querySelector('#document') as HTMLElement;
}

function buildInteractiveDemoDocument(): HTMLElement {
  const parsed = new DOMParser().parseFromString(interactiveDemoSource, 'text/html');
  const root = parsed.getElementById('interactive-demo-root');
  if (!(root instanceof HTMLElement)) throw new Error('interactive demo template missing root');

  root.id = 'document';
  root.classList.add('interactive-demo-doc');
  root.setAttribute('data-template-id', 'interactive');
  root.style.margin = '0 auto';

  const docMarkup = document.importNode(root, true) as HTMLElement;
  host.replaceChildren(docMarkup);

  const palette = [
    ['#1e3a8a', '#0ea5e9'],
    ['#7c3aed', '#2563eb'],
    ['#ef4444', '#f97316'],
    ['#16a34a', '#14b8a6'],
    ['#334155', '#64748b'],
    ['#7c2d12', '#ea580c'],
  ] as const;

  const captions = Array.from(host.querySelectorAll('.image-caption')).map((n) => n.textContent?.trim() || '');
  const images = host.querySelectorAll('img');
  images.forEach((img, index) => {
    if (!(img instanceof HTMLImageElement)) return;
    const label = captions[index] || img.alt || `Scenario ${index + 1}`;
    const [start, end] = palette[index % palette.length];
    if (img.closest('.comparison-grid')) {
      img.src = createCardImageDataUrl(label, start, end);
      return;
    }
    img.src = createChartDataUrl(label);
  });

  return host.querySelector('#document') as HTMLElement;
}

function renderSelectedTemplate() {
  removeOverlay();
  const templateId = currentTemplateId();
  currentDoc = templateId === 'demo1'
    ? buildDemo1Document()
    : templateId === 'interactive'
      ? buildInteractiveDemoDocument()
      : buildReportDocument();
  setStatus(`Template switched to ${currentTemplateId()}.`);
}

function withBusy<T>(fn: () => Promise<T>): Promise<T> {
  const controls = document.querySelectorAll('button, select');
  controls.forEach((el) => ((el as HTMLButtonElement | HTMLSelectElement).disabled = true));
  setStatus('working…');
  return fn().finally(() => {
    controls.forEach((el) => ((el as HTMLButtonElement | HTMLSelectElement).disabled = false));
  });
}

function wireButtons() {
  templateSelect.addEventListener('change', () => {
    renderSelectedTemplate();
  });

  document.getElementById('btn-export')!.addEventListener('click', async () => {
    try {
      const startedAt = performance.now();
      const doc = currentDoc;
      const options = currentOptions();
      const filename = currentFilename();
      await withBusy(async () => {
        const blob = await dom2pdf(doc, options);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      });
      const elapsed = performance.now() - startedAt;
      setStatus(`PDF downloaded in ${formatDuration(elapsed)}.`);
      console.log('pdf download time', elapsed);
    } catch (e) {
      setStatus('error: ' + (e as Error).message);
      console.error(e);
    }
  });

  document.getElementById('btn-inspect')!.addEventListener('click', async () => {
    try {
      const summary = await withBusy(() => inspect(currentDoc, currentOptions()));
      setStatus(summary.split('\n')[0]);
      console.log(summary);
    } catch (e) {
      setStatus('error: ' + (e as Error).message);
      console.error(e);
    }
  });

  document.getElementById('btn-overlay')!.addEventListener('click', () => {
    const body = document.body;
    const on = body.classList.toggle('dom2pdf-overlay');
    document.querySelectorAll('.dom2pdf-pagebreak').forEach((n) => n.remove());
    if (!on) return;
    const prevPos = getComputedStyle(currentDoc).position;
    if (prevPos === 'static') currentDoc.style.position = 'relative';
    const breaks = computePageBreaks(currentDoc, currentOptions());
    for (const y of breaks) {
      const line = document.createElement('div');
      line.className = 'dom2pdf-pagebreak';
      line.style.top = `${y}px`;
      currentDoc.appendChild(line);
    }
    setStatus(`${breaks.length} page breaks drawn.`);
  });
}

loadChineseFont().finally(() => {
  renderSelectedTemplate();
  wireButtons();
});
