/**
 * docs.html behaviour.
 *
 * Responsibilities:
 *   - bilingual switching (flips `data-lang` on <html>; docs.css owns visibility)
 *   - syntax highlighting for every code block
 *   - quick-start tabs with per-language code snippets
 *   - copy-to-clipboard, theme toggle, scroll spy, mobile navigation drawer
 *
 * Translatable page content lives in the markup as `data-lang-block="zh|en"`
 * elements. Code samples are authored as plain text and coloured at load time,
 * so the markup stays editable; a block can pin its mode with
 * `data-code="code|shell|html"` on the <pre>.
 */

const STORAGE_KEYS = { lang: 'dompdf-docs-lang', theme: 'dompdf-docs-theme' };
const DEFAULT_LANG = 'zh';

/** Strings that can only be applied through attributes or JS-owned text. */
const UI = {
  zh: {
    htmlLang: 'zh-CN',
    menu: '打开菜单',
    theme: '切换主题',
    copy: '复制代码',
    copied: '已复制 ✓',
  },
  en: {
    htmlLang: 'en',
    menu: 'Open navigation',
    theme: 'Toggle theme',
    copy: 'Copy code',
    copied: 'Copied ✓',
  },
};

// #region syntax highlighting
// Pure string -> HTML functions (no DOM access) so they can be exercised offline.

const TOKEN_CLASS = {
  comment: 'tok-c',
  string: 'tok-s',
  number: 'tok-n',
  keyword: 'tok-k',
  call: 'tok-f',
  type: 'tok-t',
  attribute: 'tok-a',
};

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally',
  'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'of', 'return', 'set', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield',
]);

const SHELL_COMMAND = /^(?:npm|npx|pnpm|yarn|rustup|cargo|git|node)\b/;
const CODE_MODES = new Set(['code', 'shell', 'html']);

/** Ordered token patterns; alternation order is significant. */
const CODE_TOKENS = new RegExp(
  [
    /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.source,
    /(?<string>'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`)/.source,
    /(?<number>\b0[xX][0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/.source,
    /(?<word>[A-Za-z_$][\w$]*)/.source,
  ].join('|'),
  'g',
);

const SHELL_TOKENS = new RegExp(
  [
    /(?<comment>#[^\n]*)/.source,
    /(?<string>'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/.source,
    /(?<number>\b\d+\b)/.source,
    /(?<word>[A-Za-z_$][\w$.-]*)/.source,
  ].join('|'),
  'g',
);

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tokenSpan(kind, text) {
  return `<span class="${TOKEN_CLASS[kind]}">${escapeHtml(text)}</span>`;
}

/** Walk `source`, emitting escaped text plus `classify(match, source)` for tokens. */
function scanTokens(source, pattern, classify) {
  let html = '';
  let cursor = 0;
  let match;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(source)) !== null) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    if (match.index > cursor) html += escapeHtml(source.slice(cursor, match.index));
    html += classify(match, source);
    cursor = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(cursor));
}

function tokenizeCode(source) {
  return scanTokens(source, CODE_TOKENS, (match, full) => {
    const groups = match.groups;
    if (groups.comment) return tokenSpan('comment', groups.comment);
    if (groups.string) return tokenSpan('string', groups.string);
    if (groups.number) return tokenSpan('number', groups.number);
    const word = groups.word;
    if (KEYWORDS.has(word)) return tokenSpan('keyword', word);
    if (/^\s*\(/.test(full.slice(match.index + word.length))) return tokenSpan('call', word);
    if (/^[A-Z]/.test(word)) return tokenSpan('type', word);
    return escapeHtml(word);
  });
}

function tokenizeShell(source) {
  return scanTokens(source, SHELL_TOKENS, (match, full) => {
    const groups = match.groups;
    if (groups.comment) return tokenSpan('comment', groups.comment);
    if (groups.string) return tokenSpan('string', groups.string);
    if (groups.number) return tokenSpan('number', groups.number);
    // The first word on a line reads as the command / tree entry.
    const lineStart = full.lastIndexOf('\n', match.index) + 1;
    const seen = /[A-Za-z_$]/.test(full.slice(lineStart, match.index));
    return seen ? escapeHtml(groups.word) : tokenSpan('call', groups.word);
  });
}

function tokenizeHtml(source) {
  let html = '';
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4);
      const stop = end === -1 ? source.length : end + 3;
      html += tokenSpan('comment', source.slice(index, stop));
      index = stop;
      continue;
    }
    if (source[index] === '<' && /[A-Za-z/]/.test(source[index + 1] ?? '')) {
      let cursor = index + 1;
      let tag = '&lt;';
      if (source[cursor] === '/') {
        tag += '/';
        cursor += 1;
      }
      const name = /^[A-Za-z][\w-]*/.exec(source.slice(cursor));
      if (name) {
        tag += tokenSpan('type', name[0]);
        cursor += name[0].length;
      }
      while (cursor < source.length && source[cursor] !== '>') {
        const rest = source.slice(cursor);
        const space = /^\s+/.exec(rest);
        if (space) {
          tag += space[0];
          cursor += space[0].length;
          continue;
        }
        const attribute = /^[A-Za-z_:][\w:.-]*/.exec(rest);
        if (attribute) {
          tag += tokenSpan('attribute', attribute[0]);
          cursor += attribute[0].length;
          continue;
        }
        const value = /^(?:"[^"]*"|'[^']*')/.exec(rest);
        if (value) {
          tag += tokenSpan('string', value[0]);
          cursor += value[0].length;
          continue;
        }
        tag += escapeHtml(source[cursor]);
        cursor += 1;
      }
      if (cursor < source.length) {
        tag += '&gt;';
        cursor += 1;
      }
      html += tag;
      index = cursor;
      continue;
    }
    // Text between tags still gets code colouring (covers markup in JS samples).
    const nextTag = source.indexOf('<', index + 1);
    const stop = nextTag === -1 ? source.length : nextTag;
    html += tokenizeCode(source.slice(index, stop));
    index = stop;
  }
  return html;
}

function pickCodeMode(source, explicit) {
  if (CODE_MODES.has(explicit)) return explicit;
  const firstLine = source.trim().split('\n', 1)[0] ?? '';
  if (/^<!--/.test(firstLine) || /^<\/?[A-Za-z]/.test(firstLine)) return 'html';
  if (SHELL_COMMAND.test(firstLine)) return 'shell';
  return 'code';
}

// #endregion syntax highlighting

/** Colour one `<code>` element, refusing to commit output that would alter its text. */
function highlightCodeBlock(codeEl) {
  const source = codeEl.textContent ?? '';
  if (source.trim() === '') return;
  const mode = pickCodeMode(source, codeEl.closest('[data-code]')?.dataset.code);
  const html =
    mode === 'html'
      ? tokenizeHtml(source)
      : mode === 'shell'
        ? tokenizeShell(source)
        : tokenizeCode(source);
  const probe = document.createElement('code');
  probe.innerHTML = html;
  if (probe.textContent !== source) return;
  codeEl.innerHTML = html;
}

/** Quick-start snippets, authored as plain text and coloured at render time. */
const SNIPPETS = {
  zh: {
    blob: `import dompdf from 'dompdf.js';

const element = document.querySelector&lt;HTMLElement&gt;('#capture');
if (!element) throw new Error('没有找到 #capture');

const blob = await dompdf(element, {
  format: 'a4',
  pagination: true,
  backgroundColor: '#ffffff',
});

const url = URL.createObjectURL(blob);
window.open(url, '_blank');

// 预览窗口加载后再释放；不要在 window.open 后立即 revoke。
setTimeout(() => URL.revokeObjectURL(url), 30_000);`,
    download: `import { downloadPDF } from 'dompdf.js';

const element = document.querySelector('#capture');
if (element) {
  await downloadPDF(element, {
    format: 'a4',
    pagination: true,
    compress: true,
  }, 'report.pdf');
}`,
    cdn: `&lt;!-- 通过 CDN 引入 --&gt;
&lt;button id="export"&gt;导出 PDF&lt;/button&gt;
&lt;section id="capture"&gt;需要导出的内容&lt;/section&gt;

&lt;script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"&gt;&lt;/script&gt;
&lt;script&gt;
  document.querySelector('#export').addEventListener('click', async () => {
    await dompdf.downloadPDF(
      document.querySelector('#capture'),
      { format: 'a4', pagination: true },
      'example.pdf',
    );
  });
&lt;/script&gt;`,
  },
  en: {
    blob: `import dompdf from 'dompdf.js';

const element = document.querySelector&lt;HTMLElement&gt;('#capture');
if (!element) throw new Error('Could not find #capture');

const blob = await dompdf(element, {
  format: 'a4',
  pagination: true,
  backgroundColor: '#ffffff',
});

const url = URL.createObjectURL(blob);
window.open(url, '_blank');

// Revoke the URL after the preview has had time to load.
setTimeout(() => URL.revokeObjectURL(url), 30_000);`,
    download: `import { downloadPDF } from 'dompdf.js';

const element = document.querySelector('#capture');
if (element) {
  await downloadPDF(element, {
    format: 'a4',
    pagination: true,
    compress: true,
  }, 'report.pdf');
}`,
    cdn: `&lt;!-- Load dompdf.js from the CDN --&gt;
&lt;button id="export"&gt;Export PDF&lt;/button&gt;
&lt;section id="capture"&gt;Content to export&lt;/section&gt;

&lt;script src="https://cdn.jsdelivr.net/npm/dompdf.js@latest/dist/dompdf.min.js"&gt;&lt;/script&gt;
&lt;script&gt;
  document.querySelector('#export').addEventListener('click', async () => {
    await dompdf.downloadPDF(
      document.querySelector('#capture'),
      { format: 'a4', pagination: true },
      'example.pdf',
    );
  });
&lt;/script&gt;`,
  },
};

const langButtons = Array.from(document.querySelectorAll('.lang-switch button[data-lang]'));
const tabs = Array.from(document.querySelectorAll('.tab[data-tab]'));
const codeBlock = document.querySelector('#codeBlock');
const codeTarget = codeBlock ? codeBlock.querySelector('code') ?? codeBlock : null;
const copyBtn = document.querySelector('#copyBtn');
const menuBtn = document.querySelector('#menuBtn');
const themeBtn = document.querySelector('#themeBtn');
const sidebar = document.querySelector('#docs-sidebar');

function readStored(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Storage can be unavailable (private mode, sandboxed file://); use defaults.
    return null;
  }
}

function writeStored(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Non-fatal: the page still works, the preference is just not remembered.
  }
}

const state = {
  lang: readStored(STORAGE_KEYS.lang) === 'en' ? 'en' : DEFAULT_LANG,
  tab: tabs.find((tab) => tab.classList.contains('active'))?.dataset.tab ?? 'blob',
};

function renderSnippet() {
  if (!codeTarget) return;
  codeTarget.innerHTML = SNIPPETS[state.lang]?.[state.tab] ?? '';
  highlightCodeBlock(codeTarget);
}

function applyLang(next) {
  state.lang = next === 'en' ? 'en' : DEFAULT_LANG;
  const ui = UI[state.lang];

  document.documentElement.dataset.lang = state.lang;
  document.documentElement.lang = ui.htmlLang;

  for (const button of langButtons) {
    button.classList.toggle('active', button.dataset.lang === state.lang);
  }
  if (menuBtn) menuBtn.setAttribute('aria-label', ui.menu);
  if (themeBtn) themeBtn.setAttribute('aria-label', ui.theme);
  refreshCopyLabels();

  renderSnippet();
  writeStored(STORAGE_KEYS.lang, state.lang);
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  writeStored(STORAGE_KEYS.theme, dark ? 'dark' : 'light');
}

/** Copy text, preferring the async Clipboard API with a legacy fallback. */
async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Rejected outside a secure/authorised context; try the legacy path.
    }
  }
  try {
    const scratch = document.createElement('textarea');
    scratch.value = text;
    scratch.setAttribute('readonly', '');
    scratch.style.position = 'fixed';
    scratch.style.top = '-1000px';
    document.body.appendChild(scratch);
    scratch.select();
    const ok = document.execCommand('copy');
    scratch.remove();
    return ok;
  } catch {
    return false;
  }
}

function setNavOpen(open) {
  document.body.classList.toggle('nav-open', open);
  if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

for (const button of langButtons) {
  button.addEventListener('click', () => applyLang(button.dataset.lang));
}

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    for (const other of tabs) other.classList.toggle('active', other === tab);
    renderSnippet();
  });
}

/** Copy `text`, flash a "copied" label on `button`, then restore it. */
async function copyWithFeedback(button, text) {
  const ok = await copyText(text);
  button.textContent = ok ? UI[state.lang].copied : UI[state.lang].copy;
  if (!ok) return;
  window.setTimeout(() => {
    // Re-read the language: it may have switched while the label was showing.
    if (button.textContent === UI[state.lang].copied) button.textContent = UI[state.lang].copy;
  }, 1200);
}

/** Give every plain code block its own copy button; the tabbed card has one already. */
function enhanceCodeBlocks() {
  for (const card of document.querySelectorAll('main .code-card')) {
    if (card.dataset.copyReady === 'true' || card.querySelector('.copy')) continue;
    const codeEl = card.querySelector('pre > code');
    if (!codeEl) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'code-copy';
    button.textContent = UI[state.lang].copy;
    button.addEventListener('click', () => copyWithFeedback(button, codeEl.innerText));
    card.append(button);
    card.dataset.copyReady = 'true';
  }
}

/** Keep every copy control's idle label in sync with the active language. */
function refreshCopyLabels() {
  if (copyBtn) copyBtn.textContent = UI[state.lang].copy;
  for (const button of document.querySelectorAll('.code-copy')) {
    button.textContent = UI[state.lang].copy;
  }
}

if (copyBtn && codeTarget) {
  copyBtn.addEventListener('click', () => copyWithFeedback(copyBtn, codeTarget.innerText));
}

if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    applyTheme(dark ? 'light' : 'dark');
  });
}

if (menuBtn) {
  menuBtn.addEventListener('click', () => {
    setNavOpen(!document.body.classList.contains('nav-open'));
  });
}

if (sidebar) {
  // Close the mobile drawer once a destination has been chosen.
  sidebar.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('a')) setNavOpen(false);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setNavOpen(false);
});

const navLinks = Array.from(document.querySelectorAll('.sidebar .nav-link[href^="#"]'));
const sections = navLinks
  .map((link) => document.querySelector(link.getAttribute('href')))
  .filter(Boolean);

if (sections.length > 0 && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const link of navLinks) {
          link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`);
        }
      }
    },
    { rootMargin: '-25% 0px -65% 0px' },
  );
  for (const section of sections) observer.observe(section);
}

// Colour the static code blocks and add their copy buttons, then let applyLang
// render (and colour) the quick-start snippet on the way in.
for (const codeEl of document.querySelectorAll('main pre > code')) highlightCodeBlock(codeEl);
enhanceCodeBlocks();

if (readStored(STORAGE_KEYS.theme) === 'dark') applyTheme('dark');
applyLang(state.lang);
