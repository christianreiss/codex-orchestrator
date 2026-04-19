/* Admin online manual — SPA controller.
   Depends on: /admin/assets/vendor/marked.min.js, /admin/assets/vendor/purify.min.js. */
(function () {
  'use strict';

  if (!window.marked || !window.DOMPurify) {
    // If vendored libs failed to load, give up quietly — the manual will just
    // show a load-error banner when the panel activates.
    window.__manual_libs_missing = true;
  }

  const API = {
    manifest: '/admin/manual/manifest',
    article: (slug) => '/admin/manual/article/' + encodeURIComponent(slug),
    search:  '/admin/manual/search',
  };

  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

  const STATE = {
    manifest: null,
    articleCache: new Map(),
    searchIndex: null,
    searchInFlight: null,
    activeSlug: '',
    activeHash: '',
    renderToken: 0,
    booted: false,
  };

  const els = {};

  function qs(id) { return document.getElementById(id); }

  function resolveEls() {
    els.panel     = qs('manualPanel');
    els.body      = qs('manualBody');
    els.title     = qs('manualTitle');
    els.eyebrow   = qs('manualEyebrow');
    els.summary   = qs('manualSummary');
    els.verified  = qs('manualVerified');
    els.toc       = qs('manualToc');
    els.search    = qs('manualSearchInput');
    els.prev      = qs('manualPrev');
    els.next      = qs('manualNext');
    els.sources   = qs('manualSources');
    els.sourcesList = qs('manualSourcesList');
  }

  function isActiveView() {
    return (document.body?.dataset?.viewMode || '') === 'manual';
  }

  function firstSlug() {
    const m = STATE.manifest;
    if (!m || !Array.isArray(m.articles) || m.articles.length === 0) return '';
    return m.articles[0].slug;
  }

  function findArticle(slug) {
    const m = STATE.manifest;
    if (!m || !Array.isArray(m.articles)) return null;
    return m.articles.find((a) => a.slug === slug) || null;
  }

  function siblingArticles(slug) {
    const m = STATE.manifest;
    if (!m || !Array.isArray(m.articles)) return { prev: null, next: null };
    const i = m.articles.findIndex((a) => a.slug === slug);
    if (i < 0) return { prev: null, next: null };
    return {
      prev: i > 0 ? m.articles[i - 1] : null,
      next: i < m.articles.length - 1 ? m.articles[i + 1] : null,
    };
  }

  async function fetchJson(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  async function fetchText(url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'text/plain' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.text();
  }

  async function loadManifest() {
    if (STATE.manifest) return STATE.manifest;
    const data = await fetchJson(API.manifest);
    STATE.manifest = data;
    return data;
  }

  async function loadSearchIndex() {
    if (STATE.searchIndex) return STATE.searchIndex;
    if (STATE.searchInFlight) return STATE.searchInFlight;
    STATE.searchInFlight = fetchJson(API.search).then((idx) => {
      STATE.searchIndex = idx;
      STATE.searchInFlight = null;
      return idx;
    }).catch(() => {
      STATE.searchInFlight = null;
      return null;
    });
    return STATE.searchInFlight;
  }

  async function loadArticleBody(slug) {
    if (STATE.articleCache.has(slug)) return STATE.articleCache.get(slug);
    const raw = await fetchText(API.article(slug));
    const parsed = parseFrontMatter(raw);
    STATE.articleCache.set(slug, parsed);
    return parsed;
  }

  function parseFrontMatter(raw) {
    const s = String(raw || '');
    const m = s.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
    if (!m) return { front: {}, body: s };
    const front = {};
    m[1].split(/\n/).forEach((line) => {
      const idx = line.indexOf(':');
      if (idx < 0) return;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (k) front[k] = v;
    });
    return { front, body: s.slice(m[0].length) };
  }

  function slugifyHeading(text) {
    return String(text || '')
      .toLowerCase()
      .trim()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80) || 'heading';
  }

  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  }

  function renderMarkdown(body) {
    if (!window.marked || !window.DOMPurify) return '';
    const renderer = new window.marked.Renderer();
    const used = Object.create(null);
    renderer.heading = function (text, level) {
      let base = slugifyHeading(String(text || '').replace(/<[^>]*>/g, ''));
      let id = base;
      let n = 2;
      while (used[id]) id = base + '-' + (n++);
      used[id] = 1;
      return '<h' + level + ' id="' + escapeAttr(id) + '">' + text + '</h' + level + '>';
    };
    renderer.link = function (href, title, text) {
      const safeHref = String(href || '');
      const isInternal = safeHref.startsWith('/admin/manual') || safeHref.startsWith('#');
      const attrs = [
        'href="' + escapeAttr(safeHref) + '"',
        title ? 'title="' + escapeAttr(title) + '"' : '',
        isInternal ? '' : 'target="_blank"',
        isInternal ? '' : 'rel="noopener noreferrer"',
      ].filter(Boolean).join(' ');
      return '<a ' + attrs + '>' + text + '</a>';
    };
    const html = window.marked.parse(String(body || ''), {
      renderer,
      gfm: true,
      breaks: false,
      headerIds: false,
      mangle: false,
    });
    return window.DOMPurify.sanitize(html, {
      ADD_ATTR: ['target', 'rel', 'id'],
      ADD_TAGS: ['details', 'summary'],
    });
  }

  function headingsFromHtml(html) {
    if (!html) return [];
    const container = document.createElement('div');
    container.innerHTML = html;
    const nodes = container.querySelectorAll('h2, h3');
    const out = [];
    nodes.forEach((n) => {
      const id = n.getAttribute('id') || '';
      const text = (n.textContent || '').trim();
      if (id && text) out.push({ id, text, level: n.tagName === 'H2' ? 2 : 3 });
    });
    return out;
  }

  function attachCopyButtons(container) {
    if (!container) return;
    const blocks = container.querySelectorAll('pre > code');
    blocks.forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.querySelector('.manual-copy-btn')) return;
      pre.style.position = 'relative';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'manual-copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', async () => {
        const text = code.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'Copied';
          btn.classList.add('is-copied');
          setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('is-copied'); }, 1400);
        } catch (_) {
          btn.textContent = 'Error';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
        }
      });
      pre.appendChild(btn);
    });
  }

  function renderToc(activeSlug) {
    if (!els.toc) return;
    const m = STATE.manifest;
    if (!m || !Array.isArray(m.articles)) {
      els.toc.innerHTML = '<div class="manual-search-empty">Manifest unavailable.</div>';
      return;
    }
    const sections = new Map();
    m.articles.forEach((a) => {
      const key = a.section || 'Manual';
      if (!sections.has(key)) sections.set(key, []);
      sections.get(key).push(a);
    });
    const parts = [];
    sections.forEach((items, section) => {
      parts.push('<div class="manual-toc-section">' + escapeAttr(section) + '</div>');
      items.forEach((a) => {
        const isActive = a.slug === activeSlug;
        parts.push(
          '<a class="manual-toc-link' + (isActive ? ' is-active' : '') + '"'
          + ' href="/admin/manual/' + encodeURIComponent(a.slug) + '"'
          + ' data-manual-link="' + escapeAttr(a.slug) + '">'
          + escapeAttr(a.title || a.slug)
          + (a.summary ? '<span class="manual-toc-summary">' + escapeAttr(a.summary) + '</span>' : '')
          + '</a>'
        );
      });
    });
    els.toc.innerHTML = parts.join('');
  }

  function renderSourcesFooter(front) {
    if (!els.sources || !els.sourcesList) return;
    const sources = (front && front.sources) ? String(front.sources).split(/\s*,\s*/).filter(Boolean) : [];
    if (sources.length === 0) {
      els.sources.hidden = true;
      els.sourcesList.innerHTML = '';
      return;
    }
    els.sources.hidden = false;
    els.sourcesList.innerHTML = sources.map((s) => '<li>' + escapeAttr(s) + '</li>').join('');
  }

  function renderPagination(slug) {
    if (!els.prev || !els.next) return;
    const { prev, next } = siblingArticles(slug);
    if (prev) {
      els.prev.hidden = false;
      els.prev.href = '/admin/manual/' + encodeURIComponent(prev.slug);
      els.prev.dataset.manualLink = prev.slug;
      els.prev.innerHTML = '<span class="manual-pagination-kicker">Previous</span>' + escapeAttr(prev.title || prev.slug);
    } else {
      els.prev.hidden = true;
    }
    if (next) {
      els.next.hidden = false;
      els.next.href = '/admin/manual/' + encodeURIComponent(next.slug);
      els.next.dataset.manualLink = next.slug;
      els.next.innerHTML = '<span class="manual-pagination-kicker">Next</span>' + escapeAttr(next.title || next.slug);
    } else {
      els.next.hidden = true;
    }
  }

  function showError(message) {
    if (els.body) {
      els.body.className = 'manual-body is-error';
      els.body.textContent = message;
    }
    if (els.title) els.title.textContent = 'Unavailable';
    if (els.eyebrow) els.eyebrow.textContent = 'Manual';
    if (els.summary) els.summary.textContent = '';
    if (els.sources) els.sources.hidden = true;
    renderPagination('');
  }

  async function renderArticle(slug, hash) {
    if (!els.body) return;
    const token = ++STATE.renderToken;
    STATE.activeSlug = slug || '';
    STATE.activeHash = hash || '';

    if (window.__manual_libs_missing) {
      showError('Manual renderer failed to load. Check /admin/assets/vendor/marked.min.js and purify.min.js.');
      return;
    }

    if (!slug) {
      const fallback = firstSlug();
      if (fallback) return renderArticle(fallback, '');
      showError('No articles are installed.');
      return;
    }

    const entry = findArticle(slug);
    if (!entry) {
      showError('Article "' + slug + '" is not listed in the manifest.');
      renderToc(slug);
      return;
    }

    els.body.className = 'manual-body is-loading';
    els.body.textContent = 'Loading…';

    let raw;
    try {
      raw = await loadArticleBody(slug);
    } catch (err) {
      if (token !== STATE.renderToken) return;
      showError('Failed to load article: ' + (err && err.message ? err.message : 'unknown error'));
      return;
    }
    if (token !== STATE.renderToken) return;

    if (els.eyebrow) els.eyebrow.textContent = entry.section || 'Manual';
    if (els.title) els.title.textContent = entry.title || slug;
    if (els.summary) els.summary.textContent = entry.summary || '';
    if (els.verified) {
      const d = (raw.front && raw.front.verified) || entry.verified || '';
      if (d) {
        els.verified.hidden = false;
        els.verified.textContent = 'Verified ' + d;
      } else {
        els.verified.hidden = true;
      }
    }

    const html = renderMarkdown(raw.body);
    els.body.className = 'manual-body';
    els.body.innerHTML = html;
    attachCopyButtons(els.body);
    renderSourcesFooter(raw.front);
    renderPagination(slug);
    renderToc(slug);

    const targetHash = String(hash || '').replace(/^#/, '');
    if (targetHash) {
      requestAnimationFrame(() => {
        const target = els.body.querySelector('#' + CSS.escape(targetHash));
        if (target) target.scrollIntoView({ block: 'start', behavior: 'instant' in window ? 'instant' : 'auto' });
      });
    } else {
      els.body.scrollTop = 0;
      try { window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' }); } catch (_) {}
    }
  }

  function slugFromLocation() {
    const raw = document.body?.dataset?.manualSlug || '';
    if (raw && SLUG_RE.test(raw)) return raw;
    return '';
  }

  function hashFromLocation() {
    return String(location.hash || '').replace(/^#/, '');
  }

  async function activate() {
    if (!STATE.booted) {
      STATE.booted = true;
      try { await loadManifest(); }
      catch (err) {
        showError('Manual manifest unavailable: ' + (err && err.message ? err.message : 'unknown error'));
        return;
      }
    }
    const slug = slugFromLocation() || firstSlug();
    await renderArticle(slug, hashFromLocation());
  }

  // Debounced search.
  let searchDebounce = null;
  async function handleSearchInput(value) {
    if (!els.toc) return;
    const query = String(value || '').trim().toLowerCase();
    if (query.length < 2) {
      renderToc(STATE.activeSlug);
      return;
    }
    const idx = await loadSearchIndex();
    if (!idx) {
      // Fallback: naive manifest filter.
      renderFallbackResults(query);
      return;
    }
    renderSearchResults(query, idx);
  }

  function tokenize(s) {
    return String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9+.]+/)
      .filter((t) => t && t.length >= 2);
  }

  function renderSearchResults(query, idx) {
    const tokens = tokenize(query);
    if (tokens.length === 0) { renderToc(STATE.activeSlug); return; }
    const docs = idx.docs || [];
    const index = idx.index || {};
    const scores = new Map();
    tokens.forEach((t) => {
      const ids = index[t] || [];
      ids.forEach((id) => scores.set(id, (scores.get(id) || 0) + 1));
    });
    // Rank: score desc, then title match bonus.
    const ranked = docs
      .map((d, i) => {
        const base = scores.get(i) || 0;
        const titleHit = tokens.some((t) => (d.title || '').toLowerCase().includes(t)) ? 0.5 : 0;
        return { doc: d, score: base + titleHit };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12);

    if (ranked.length === 0) {
      els.toc.innerHTML = '<div class="manual-search-empty">No matches for "' + escapeAttr(query) + '".</div>';
      return;
    }

    const parts = [];
    parts.push('<div class="manual-toc-section">Search results</div>');
    ranked.forEach(({ doc }) => {
      parts.push(
        '<a class="manual-toc-link" href="/admin/manual/' + encodeURIComponent(doc.slug) + '"'
        + ' data-manual-link="' + escapeAttr(doc.slug) + '">'
        + escapeAttr(doc.title || doc.slug)
        + (doc.section ? '<span class="manual-toc-summary">' + escapeAttr(doc.section) + '</span>' : '')
        + '</a>'
      );
      // Best matching anchor inside doc, if any.
      const anchors = Array.isArray(doc.anchors) ? doc.anchors : [];
      anchors.slice(0, 3).forEach((anc) => {
        const text = String(anc.text || '').toLowerCase();
        const hit = tokens.some((t) => text.includes(t));
        if (!hit) return;
        parts.push(
          '<a class="manual-search-hit-anchor" href="/admin/manual/' + encodeURIComponent(doc.slug)
          + '#' + encodeURIComponent(anc.id) + '"'
          + ' data-manual-link="' + escapeAttr(doc.slug) + '"'
          + ' data-manual-hash="' + escapeAttr(anc.id) + '">#'
          + escapeAttr(anc.text)
          + '</a>'
        );
      });
    });
    els.toc.innerHTML = parts.join('');
  }

  function renderFallbackResults(query) {
    const m = STATE.manifest;
    if (!m || !Array.isArray(m.articles)) { renderToc(STATE.activeSlug); return; }
    const hits = m.articles.filter((a) => {
      const s = (a.title + ' ' + (a.summary || '') + ' ' + (a.section || '') + ' ' + ((a.tags || []).join(' '))).toLowerCase();
      return s.includes(query);
    });
    if (hits.length === 0) {
      els.toc.innerHTML = '<div class="manual-search-empty">No matches for "' + escapeAttr(query) + '".</div>';
      return;
    }
    const parts = ['<div class="manual-toc-section">Search results</div>'];
    hits.forEach((a) => {
      parts.push(
        '<a class="manual-toc-link" href="/admin/manual/' + encodeURIComponent(a.slug) + '"'
        + ' data-manual-link="' + escapeAttr(a.slug) + '">'
        + escapeAttr(a.title || a.slug)
        + (a.summary ? '<span class="manual-toc-summary">' + escapeAttr(a.summary) + '</span>' : '')
        + '</a>'
      );
    });
    els.toc.innerHTML = parts.join('');
  }

  // Intercept internal navigation.
  function handleDocumentClick(event) {
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (event.button !== 0) return;
    const a = event.target.closest('a');
    if (!a) return;

    const href = a.getAttribute('href') || '';
    if (!href) return;

    // In-article anchor (#heading).
    if (href.startsWith('#') && isActiveView()) {
      event.preventDefault();
      const hash = href.slice(1);
      const target = els.body?.querySelector('#' + CSS.escape(hash));
      if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
      const slug = STATE.activeSlug || '';
      history.replaceState(history.state, '', '/admin/manual' + (slug ? '/' + slug : '') + '#' + hash);
      return;
    }

    // Same-origin /admin/manual links.
    let url;
    try { url = new URL(href, window.location.origin); }
    catch (_) { return; }
    if (url.origin !== window.location.origin) return;
    if (!url.pathname.startsWith('/admin/manual')) return;

    event.preventDefault();
    const path = url.pathname;
    const hash = url.hash || '';
    history.pushState({ manual: true }, '', path + hash);
    document.body.dataset.manualSlug = path.replace(/^\/admin\/manual\/?/, '') || '';
    document.body.dataset.viewMode = 'manual';
    renderArticle(document.body.dataset.manualSlug || firstSlug(), hash.replace(/^#/, ''));
  }

  function handlePopState() {
    if (!isActiveView()) return;
    const slug = slugFromLocation() || firstSlug();
    renderArticle(slug, hashFromLocation());
  }

  function onViewModeChange() {
    if (!isActiveView()) return;
    activate();
  }

  function wireEvents() {
    if (els.search) {
      els.search.addEventListener('input', (e) => {
        const value = e.target.value;
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => handleSearchInput(value), 220);
      });
      els.search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.target.value = ''; handleSearchInput(''); }
      });
    }
    document.addEventListener('click', handleDocumentClick);
    window.addEventListener('popstate', handlePopState);

    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.attributeName === 'data-view-mode') {
          onViewModeChange();
          return;
        }
      }
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-view-mode', 'data-manual-slug'] });
  }

  function boot() {
    resolveEls();
    if (!els.panel) return;
    wireEvents();
    if (isActiveView()) activate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
