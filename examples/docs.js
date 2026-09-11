(function () {
  var markedApi = window.marked;
  var purifier = window.DOMPurify;
  var hljsApi = window.hljs;

  var refs = {
    menuButton: document.getElementById('docs-menu-btn'),
    overlay: document.querySelector('.docs-overlay'),
    pageNav: document.getElementById('docs-page-nav'),
    sectionNav: document.getElementById('docs-section-nav'),
    outlineNav: document.getElementById('docs-outline-nav'),
    main: document.getElementById('docs-main'),
    content: document.getElementById('docs-content'),
    loading: document.getElementById('docs-loading'),
    loadingText: document.getElementById('docs-loading-text'),
    heroEyebrow: document.getElementById('docs-hero-eyebrow'),
    heroTitle: document.getElementById('docs-hero-title'),
    heroLede: document.getElementById('docs-hero-lede'),
    heroNote: document.getElementById('docs-hero-note'),
    heroHighlights: document.getElementById('docs-hero-highlights'),
    langButtons: Array.prototype.slice.call(
      document.querySelectorAll('.lang-switch-btn'),
    ),
    i18nNodes: Array.prototype.slice.call(document.querySelectorAll('[data-i18n]')),
  };

  if (!markedApi || !purifier || !refs.content) {
    if (refs.content) {
      refs.content.innerHTML =
        '<div class="docs-empty">Unable to load the markdown renderer.</div>';
    }
    return;
  }

  var TEXT = {
    en: {
      navDemo: 'Live Demo',
      sidebarGuide: 'Guide',
      sidebarSections: 'Sections',
      outlineTitle: 'On This Page',
      loading: 'Loading documentation...',
      loadingDoc: 'Loading ${doc}...',
      readError:
        'Unable to load the document. Please run `npm run serve` from the project root and open this page through `http://localhost:8080/examples/docs.html`.',
      untitled: 'Untitled Document',
      heroFallbackLede:
        'A VuePress-style documentation view built from the repository markdown files.',
      heroFallbackNote:
        'The page reads the latest markdown directly, so docs updates in the repo appear here automatically.',
      highlights: [
        {
          label: 'Frontend',
          value: 'Pure browser-side pipeline',
          description:
            'Render vector-first PDFs in the browser without a backend service.',
        },
        {
          label: 'WASM',
          value: 'TypeScript + Worker + Rust',
          description:
            'Use a DOM snapshot on the main thread and keep heavy PDF work inside WASM.',
        },
        {
          label: 'I18N',
          value: 'English and Chinese ready',
          description:
            'Switch between README languages and keep section navigation in sync.',
        },
      ],
      navGroups: [
        {
          title: 'Core Docs',
          items: [
            {
              key: 'overview',
              title: 'Overview',
              meta: 'README and quick start',
              docs: { en: 'README.md', zh: 'README_CN.md' },
            },
            {
              key: 'migration',
              title: 'Migration Notes',
              meta: 'Compatibility and upgrade guide',
              docs: {
                en: 'docs/migration-compat.md',
                zh: 'docs/migration-compat.zh-CN.md',
              },
            },
            {
              key: 'page-sizes',
              title: 'Page Sizes',
              meta: 'Common paper dimensions',
              docs: { en: 'page_sizes.md', zh: 'page_sizes.md' },
            },
            {
              key: 'userscript',
              title: 'Userscript',
              meta: 'Browser export helper',
              docs: { en: 'userscript/README.md', zh: 'userscript/README.md' },
            },
          ],
        },
        {
          title: 'Examples',
          items: [
            {
              key: 'demo',
              title: 'Live Demo',
              meta: 'HTML, Markdown, and export playground',
              href: 'examples/index.html',
            },
            {
              key: 'comparison',
              title: 'Comparison',
              meta: 'Compare PDF approaches',
              href: 'examples/comparison.html',
            },
            {
              key: 'editor',
              title: 'Markdown Editor',
              meta: 'Write and export markdown content',
              href: 'examples/markdown-editor.html',
            },
          ],
        },
      ],
    },
    zh: {
      navDemo: '在线示例',
      sidebarGuide: '文档导航',
      sidebarSections: '本页目录',
      outlineTitle: '页面大纲',
      loading: '正在加载文档...',
      loadingDoc: '正在加载 ${doc}...',
      readError:
        '文档加载失败。请先在项目根目录执行 `npm run serve`，再通过 `http://localhost:8080/examples/docs.html` 打开本页。',
      untitled: '未命名文档',
      heroFallbackLede: '基于仓库 Markdown 实时渲染的 VuePress 风格文档页。',
      heroFallbackNote:
        '页面直接读取仓库中的最新 Markdown，因此 README 或其他文档更新后，这里会同步反映。',
      highlights: [
        {
          label: '前端',
          value: '纯浏览器端导出链路',
          description: '无需后端服务，在浏览器内生成以矢量内容为主的 PDF。',
        },
        {
          label: 'WASM',
          value: 'TypeScript + Worker + Rust',
          description: '主线程负责 DOM 快照采集，WASM 负责分页和 PDF 渲染。',
        },
        {
          label: '多语言',
          value: '中英文一键切换',
          description: 'README 双语版本和页内目录会跟随语言状态同步更新。',
        },
      ],
      navGroups: [
        {
          title: '核心文档',
          items: [
            {
              key: 'overview',
              title: '总览',
              meta: 'README 与快速开始',
              docs: { en: 'README.md', zh: 'README_CN.md' },
            },
            {
              key: 'migration',
              title: '迁移说明',
              meta: '兼容性与升级指南',
              docs: {
                en: 'docs/migration-compat.md',
                zh: 'docs/migration-compat.zh-CN.md',
              },
            },
            {
              key: 'page-sizes',
              title: '纸张尺寸',
              meta: '常用纸张规格速查',
              docs: { en: 'page_sizes.md', zh: 'page_sizes.md' },
            },
            {
              key: 'userscript',
              title: 'Userscript',
              meta: '浏览器导出辅助脚本',
              docs: { en: 'userscript/README.md', zh: 'userscript/README.md' },
            },
          ],
        },
        {
          title: '示例页面',
          items: [
            {
              key: 'demo',
              title: '在线示例',
              meta: 'HTML、Markdown 与导出调试台',
              href: 'examples/index.html',
            },
            {
              key: 'comparison',
              title: '方案对比',
              meta: '查看不同前端 PDF 方案对照',
              href: 'examples/comparison.html',
            },
            {
              key: 'editor',
              title: 'Markdown 编辑器',
              meta: '编写并导出 Markdown 内容',
              href: 'examples/markdown-editor.html',
            },
          ],
        },
      ],
    },
  };

  var state = {
    lang: 'en',
    doc: 'README.md',
    cache: new Map(),
    headings: [],
    currentGroupKey: '',
  };

  markedApi.setOptions({
    gfm: true,
    breaks: false,
    headerIds: false,
    mangle: false,
  });

  bindEvents();
  syncStateFromLocation();
  renderChromeText();
  renderPageNav();
  renderHighlights();
  loadCurrentDocument();

  function bindEvents() {
    refs.langButtons.forEach(function (button) {
      button.addEventListener('click', function () {
        var targetLang = button.getAttribute('data-lang') === 'zh' ? 'zh' : 'en';
        if (targetLang === state.lang) return;

        navigateTo({
          lang: targetLang,
          doc: translateDocForLang(state.doc, targetLang),
        });
      });
    });

    if (refs.menuButton) {
      refs.menuButton.addEventListener('click', function () {
        var isOpen = document.body.classList.toggle('docs-sidebar-open');
        refs.menuButton.setAttribute('aria-expanded', String(isOpen));
      });
    }

    if (refs.overlay) {
      refs.overlay.addEventListener('click', closeSidebar);
    }

    if (refs.main) {
      refs.main.addEventListener('scroll', updateActiveHeading);
    }

    window.addEventListener('scroll', updateActiveHeading, { passive: true });

    window.addEventListener('popstate', function () {
      syncStateFromLocation();
      renderChromeText();
      renderPageNav();
      renderHighlights();
      loadCurrentDocument();
    });
  }

  function syncStateFromLocation() {
    var params = new URLSearchParams(window.location.search);
    state.lang = params.get('lang') === 'zh' ? 'zh' : 'en';
    state.doc = normalizeDocPath(params.get('doc')) || defaultDocForLang(state.lang);
    document.documentElement.lang = state.lang;
    refs.langButtons.forEach(function (button) {
      button.classList.toggle(
        'active',
        button.getAttribute('data-lang') === state.lang,
      );
    });
  }

  function renderChromeText() {
    var text = TEXT[state.lang];

    refs.i18nNodes.forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      if (text[key]) {
        node.textContent = text[key];
      }
    });

    if (refs.loadingText) {
      refs.loadingText.textContent = text.loading;
    }
  }

  function renderPageNav() {
    if (!refs.pageNav) return;

    var text = TEXT[state.lang];
    var html = [];

    text.navGroups.forEach(function (group) {
      html.push('<div class="docs-nav-group">');
      html.push(
        '<div class="docs-sidebar-kicker">' + escapeHtml(group.title) + '</div>',
      );

      group.items.forEach(function (item) {
        if (item.docs) {
          var docPath = docForItem(item, state.lang);
          var href = buildDocHref(docPath, state.lang);
          var active = normalizeDocPath(docPath) === state.doc;

          html.push(
            '<a class="docs-sidebar-link' +
              (active ? ' active' : '') +
              '" href="' +
              href +
              '">' +
              '<span class="docs-sidebar-link-title">' +
              escapeHtml(item.title) +
              '</span>' +
              '<span class="docs-sidebar-link-meta">' +
              escapeHtml(item.meta) +
              '</span>' +
              '</a>',
          );
          return;
        }

        var assetHref = buildAssetHref(item.href);
        html.push(
          '<a class="docs-sidebar-link external" href="' +
            assetHref +
            '">' +
            '<span class="docs-sidebar-link-title">' +
            escapeHtml(item.title) +
            '</span>' +
            '<span class="docs-sidebar-link-meta">' +
            escapeHtml(item.meta) +
            '</span>' +
            '</a>',
        );
      });

      html.push('</div>');
    });

    refs.pageNav.innerHTML = html.join('');
  }

  function renderHighlights() {
    if (!refs.heroHighlights) return;

    var cards = TEXT[state.lang].highlights
      .map(function (item) {
        return (
          '<div class="docs-highlight-card">' +
          '<span class="docs-highlight-label">' +
          escapeHtml(item.label) +
          '</span>' +
          '<p class="docs-highlight-value">' +
          escapeHtml(item.value) +
          '</p>' +
          '<p class="docs-highlight-desc">' +
          escapeHtml(item.description) +
          '</p>' +
          '</div>'
        );
      })
      .join('');

    refs.heroHighlights.innerHTML = cards;
  }

  async function loadCurrentDocument() {
    setLoading(true, TEXT[state.lang].loadingDoc.replace('${doc}', state.doc));

    try {
      var markdown = await fetchDocument(state.doc);
      renderDocument(markdown);
      renderPageNav();
      updateActiveHeading();
      if (window.location.hash) {
        scrollToHash(window.location.hash.slice(1));
      } else {
        scrollToTop();
      }
    } catch (error) {
      console.error(error);
      refs.content.innerHTML =
        '<div class="docs-empty">' +
        escapeHtml(TEXT[state.lang].readError) +
        '</div>';
      refs.sectionNav.innerHTML = '';
      refs.outlineNav.innerHTML = '';
      refs.heroTitle.textContent = 'dompdf.js Docs';
      refs.heroLede.textContent = TEXT[state.lang].heroFallbackLede;
      refs.heroNote.textContent = TEXT[state.lang].heroFallbackNote;
      document.title = 'dompdf.js Docs';
    } finally {
      setLoading(false);
    }
  }

  async function fetchDocument(docPath) {
    if (state.cache.has(docPath)) {
      return state.cache.get(docPath);
    }

    var response = await fetch(buildFetchHref(docPath));
    if (!response.ok) {
      throw new Error('Failed to fetch ' + docPath + ': ' + response.status);
    }

    var markdown = await response.text();
    state.cache.set(docPath, markdown);
    return markdown;
  }

  function renderDocument(markdown) {
    var rawHtml = markedApi.parse(markdown);
    var safeHtml = purifier.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
    });

    refs.content.innerHTML = safeHtml;

    rewriteLinks(refs.content, state.doc);
    decorateTables(refs.content);
    highlightCodeBlocks(refs.content);
    var hero = extractHero(refs.content);
    assignHeadingIds(refs.content);
    state.headings = collectHeadings(refs.content);
    renderSectionNav();
    renderOutline();
    renderHero(hero);
    document.title = hero.title + ' - dompdf.js Docs';
  }

  function rewriteLinks(root, currentDoc) {
    var anchors = root.querySelectorAll('a[href]');

    Array.prototype.forEach.call(anchors, function (anchor) {
      var originalHref = anchor.getAttribute('href');
      if (!originalHref) return;

      if (/^(https?:|mailto:|tel:)/i.test(originalHref)) {
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noreferrer');
        return;
      }

      if (originalHref.charAt(0) === '#') {
        return;
      }

      var resolved = resolveRelativeHref(currentDoc, originalHref);
      if (!resolved) return;

      if (resolved.isMarkdown) {
        anchor.setAttribute(
          'href',
          buildDocHref(resolved.path, state.lang, resolved.hash),
        );
      } else {
        anchor.setAttribute(
          'href',
          buildAssetHref(resolved.path + (resolved.hash ? '#' + resolved.hash : '')),
        );
      }
    });
  }

  function extractHero(root) {
    var text = TEXT[state.lang];
    var hero = {
      eyebrow: state.doc,
      title: text.untitled,
      lede: text.heroFallbackLede,
      note: text.heroFallbackNote,
    };

    var heading = root.querySelector('h1');
    if (heading) {
      hero.title = heading.textContent.trim() || hero.title;
      heading.remove();
    }

    var introParagraphs = [];
    var children = Array.prototype.slice.call(root.children);
    children.some(function (node) {
      if (node.tagName === 'P' && isLanguageSwitchParagraph(node)) {
        node.remove();
        return false;
      }

      if (node.tagName === 'P' && node.textContent.trim()) {
        introParagraphs.push(node.innerHTML);
        node.remove();
        return introParagraphs.length >= 2;
      }

      return introParagraphs.length > 0;
    });

    if (introParagraphs[0]) {
      hero.lede = introParagraphs[0];
    }

    if (introParagraphs[1]) {
      hero.note = introParagraphs[1];
    } else {
      hero.note = text.heroFallbackNote;
    }

    var match = matchCurrentNavItem();
    if (match) {
      hero.eyebrow = match.title;
    }

    return hero;
  }

  function renderHero(hero) {
    refs.heroEyebrow.textContent = hero.eyebrow;
    refs.heroTitle.textContent = hero.title;
    refs.heroLede.innerHTML = hero.lede;
    refs.heroNote.innerHTML = hero.note;
  }

  function assignHeadingIds(root) {
    var seen = Object.create(null);
    var headings = root.querySelectorAll('h1, h2, h3, h4');

    Array.prototype.forEach.call(headings, function (heading) {
      var base = slugify(heading.textContent) || 'section';
      var count = seen[base] || 0;
      seen[base] = count + 1;
      heading.id = count ? base + '-' + count : base;
    });
  }

  function collectHeadings(root) {
    var headings = [];
    var nodes = root.querySelectorAll('h2, h3');

    Array.prototype.forEach.call(nodes, function (node) {
      headings.push({
        id: node.id,
        depth: Number(node.tagName.slice(1)),
        text: node.textContent.trim(),
      });
    });

    return headings;
  }

  function renderSectionNav() {
    renderHeadingNav(refs.sectionNav, false);
  }

  function renderOutline() {
    renderHeadingNav(refs.outlineNav, true);
  }

  function renderHeadingNav(container, compact) {
    if (!container) return;

    if (!state.headings.length) {
      container.innerHTML =
        '<div class="docs-empty">' +
        escapeHtml(TEXT[state.lang].heroFallbackNote) +
        '</div>';
      return;
    }

    container.innerHTML = state.headings
      .map(function (heading) {
        return (
          '<a class="' +
          (compact ? 'docs-outline-link' : 'docs-sidebar-link') +
          ' depth-' +
          heading.depth +
          '" href="#' +
          encodeURIComponent(heading.id) +
          '" data-heading-id="' +
          escapeHtml(heading.id) +
          '">' +
          escapeHtml(heading.text) +
          '</a>'
        );
      })
      .join('');
  }

  function updateActiveHeading() {
    if (!state.headings.length || !refs.main) return;

    var containerTop = refs.main.getBoundingClientRect().top;
    var bestId = state.headings[0].id;

    state.headings.forEach(function (heading) {
      var node = document.getElementById(heading.id);
      if (!node) return;

      var offset = node.getBoundingClientRect().top - containerTop;
      if (offset <= 120) {
        bestId = heading.id;
      }
    });

    syncActiveHeadingLink(bestId);
  }

  function syncActiveHeadingLink(id) {
    [refs.sectionNav, refs.outlineNav].forEach(function (container) {
      if (!container) return;
      var links = container.querySelectorAll('[data-heading-id]');
      Array.prototype.forEach.call(links, function (link) {
        link.classList.toggle('active', link.getAttribute('data-heading-id') === id);
      });
    });
  }

  function scrollToHash(hash) {
    var id = decodeURIComponent(hash);
    var target = document.getElementById(id);
    if (!target) return;

    target.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest',
    });
    syncActiveHeadingLink(id);
    closeSidebar();
  }

  function setLoading(loading, message) {
    if (!refs.loading) return;
    refs.loading.style.display = loading ? 'inline-flex' : 'none';
    if (loading && refs.loadingText) {
      refs.loadingText.textContent = message || TEXT[state.lang].loading;
    }
  }

  function isLanguageSwitchParagraph(node) {
    return /^\s*(English|中文)\s*\|\s*(English|中文)\s*$/i.test(
      node.textContent.trim(),
    );
  }

  function defaultDocForLang(lang) {
    return lang === 'zh' ? 'README_CN.md' : 'README.md';
  }

  function translateDocForLang(docPath, nextLang) {
    var normalized = normalizeDocPath(docPath);
    var text = TEXT[nextLang];
    var result = normalized;

    text.navGroups.some(function (group) {
      return group.items.some(function (item) {
        if (!item.docs) return false;

        var enDoc = normalizeDocPath(docForItem(item, 'en'));
        var zhDoc = normalizeDocPath(docForItem(item, 'zh'));
        if (normalized === enDoc || normalized === zhDoc) {
          result = normalizeDocPath(docForItem(item, nextLang));
          return true;
        }
        return false;
      });
    });

    return result || defaultDocForLang(nextLang);
  }

  function docForItem(item, lang) {
    return item.docs[lang] || item.docs.en;
  }

  function matchCurrentNavItem() {
    var text = TEXT[state.lang];
    var found = null;

    text.navGroups.some(function (group) {
      return group.items.some(function (item) {
        if (!item.docs) return false;
        if (normalizeDocPath(docForItem(item, state.lang)) === state.doc) {
          found = item;
          return true;
        }
        return false;
      });
    });

    return found;
  }

  function buildDocHref(docPath, lang, hash) {
    var url = new URL('./docs.html', window.location.href);
    url.searchParams.set('lang', lang);
    url.searchParams.set('doc', normalizeDocPath(docPath));
    if (hash) {
      url.hash = hash;
    }
    return url.toString();
  }

  function buildFetchHref(docPath) {
    return '../' + normalizeDocPath(docPath);
  }

  function buildAssetHref(assetPath) {
    return '../' + assetPath.replace(/^\.\//, '');
  }

  function resolveRelativeHref(currentDoc, href) {
    var parts = href.split('#');
    var rawPath = parts[0];
    var hash = parts[1] || '';

    if (!rawPath) {
      return { path: normalizeDocPath(currentDoc), hash: hash, isMarkdown: true };
    }

    var resolved = normalizeDocPath(joinPath(dirname(currentDoc), rawPath));
    if (!resolved) return null;

    return {
      path: resolved,
      hash: hash,
      isMarkdown: /\.md$/i.test(resolved),
    };
  }

  function normalizeDocPath(docPath) {
    if (!docPath) return '';

    var normalized = String(docPath).replace(/\\/g, '/').trim();
    if (!normalized) return '';

    normalized = normalized.replace(/^\.\//, '');
    var segments = [];

    normalized.split('/').forEach(function (segment) {
      if (!segment || segment === '.') return;
      if (segment === '..') {
        segments.pop();
        return;
      }
      segments.push(segment);
    });

    return segments.join('/');
  }

  function dirname(filePath) {
    var index = filePath.lastIndexOf('/');
    return index === -1 ? '' : filePath.slice(0, index);
  }

  function joinPath(basePath, targetPath) {
    if (!basePath) return targetPath;
    return basePath + '/' + targetPath;
  }

  function slugify(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/[`~!@#$%^&*()+=[\]{}|\\:;"'<>,.?/]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-');
  }

  function decorateTables(root) {
    var tables = root.querySelectorAll('table');
    Array.prototype.forEach.call(tables, function (table) {
      table.setAttribute('role', 'table');
    });
  }

  function highlightCodeBlocks(root) {
    var codeBlocks = root.querySelectorAll('pre code');

    Array.prototype.forEach.call(codeBlocks, function (codeBlock) {
      if (!hljsApi || typeof hljsApi.highlightElement !== 'function') {
        return;
      }

      hljsApi.highlightElement(codeBlock);
    });
  }

  function navigateTo(options) {
    var lang = options.lang || state.lang;
    var doc = normalizeDocPath(options.doc) || defaultDocForLang(lang);
    var hash = options.hash || '';
    var href = buildDocHref(doc, lang, hash);

    window.history.pushState({}, '', href);
    closeSidebar();
    syncStateFromLocation();
    renderChromeText();
    renderPageNav();
    renderHighlights();
    loadCurrentDocument();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function closeSidebar() {
    document.body.classList.remove('docs-sidebar-open');
    if (refs.menuButton) {
      refs.menuButton.setAttribute('aria-expanded', 'false');
    }
  }

  function scrollToTop() {
    if (refs.main && typeof refs.main.scrollTo === 'function') {
      refs.main.scrollTo({ top: 0, behavior: 'auto' });
    }

    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = 0;
    }

    if (typeof window.scrollTo === 'function') {
      window.scrollTo(0, 0);
    }
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href]');
    if (!link) return;

    var href = link.getAttribute('href');
    if (!href) return;

    if (href.indexOf('/examples/docs.html') !== -1 || href.indexOf('./docs.html') === 0) {
      event.preventDefault();
      var url = new URL(href, window.location.href);
      navigateTo({
        lang: url.searchParams.get('lang') === 'zh' ? 'zh' : 'en',
        doc: url.searchParams.get('doc'),
        hash: url.hash ? url.hash.slice(1) : '',
      });
      return;
    }

    if (href.charAt(0) === '#') {
      event.preventDefault();
      var hash = href.slice(1);
      window.history.replaceState({}, '', buildDocHref(state.doc, state.lang, hash));
      scrollToHash(hash);
    }
  });
})();
