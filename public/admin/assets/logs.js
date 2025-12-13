(() => {
  // Shared debounce so we don't rely on dashboard.js helpers
  function debounce(fn, wait = 300) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // Client logs
  function initClientLogs() {
    const tableBody = document.querySelector('#log-table tbody');
    const searchInput = document.getElementById('log-search');
    const pageSizeSelect = document.getElementById('log-page-size');
    const statusEl = document.getElementById('log-status');
    const pageIndicator = document.getElementById('page-indicator');
    const prevBtn = document.getElementById('page-prev');
    const nextBtn = document.getElementById('page-next');
    const refreshBtn = document.getElementById('log-refresh');
    const sortableHeaders = document.querySelectorAll('#log-table th.sortable');

    if (!tableBody) return;

    const state = {
      page: 1,
      perPage: Number(pageSizeSelect?.value || 50),
      q: '',
      sort: 'created_at',
      direction: 'desc',
      total: 0,
      pages: 1,
      loading: false,
      currency: 'USD',
    };

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function parseTimestamp(value) {
      if (!value) return null;
      const raw = String(value).trim();
      const normalized = raw.replace(/\.(\d{3})\d*(Z?)/, '.$1$2');
      const date = new Date(normalized);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatTimestamp(value) {
      const date = parseTimestamp(value);
      if (!date) return value || '—';
      const dd = String(date.getDate()).padStart(2, '0');
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const yy = String(date.getFullYear()).slice(-2);
      const hh = String(date.getHours()).padStart(2, '0');
      const min = String(date.getMinutes()).padStart(2, '0');
      return `${dd}.${mm}.${yy}, ${hh}:${min}`;
    }

    function formatNumber(value) {
      if (value === null || value === undefined) return '—';
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      return num.toLocaleString('en-US');
    }

    function formatCost(value) {
      if (value === null || value === undefined) return '—';
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return state.currency ? `${formatted} ${state.currency}` : formatted;
    }

    function applySortState() {
      sortableHeaders.forEach((th) => {
        th.classList.remove('sort-active', 'sort-asc', 'sort-desc');
        const key = th.dataset.sort;
        if (key === state.sort) {
          th.classList.add('sort-active');
          th.classList.add(state.direction === 'asc' ? 'sort-asc' : 'sort-desc');
        }
      });
    }

    function renderTable(items) {
      if (!tableBody) return;
      if (!items.length) {
        tableBody.innerHTML = '<tr class="empty-row"><td colspan="8">No client reports yet.</td></tr>';
        return;
      }

      const rows = items.map((item) => {
        const created = formatTimestamp(item.created_at);
        const host = item.fqdn ? escapeHtml(item.fqdn) : 'Unknown';
        const clientIp = item.client_ip ? escapeHtml(item.client_ip) : '—';
        const inputTokens = formatNumber(item.input);
        const outputTokens = formatNumber(item.output);
        const cachedTokens = formatNumber(item.cached);
        const reasoningTokens = formatNumber(item.reasoning);
        const costValue = formatCost(item.cost);

        return `<tr>
          <td><div class="mono">${created}</div></td>
          <td><div class="host-chip"><span class="host-name">${host}</span></div></td>
          <td><span class="mono">${clientIp}</span></td>
          <td><span class="mono">${inputTokens}</span></td>
          <td><span class="mono">${outputTokens}</span></td>
          <td><span class="mono">${cachedTokens}</span></td>
          <td><span class="mono">${reasoningTokens}</span></td>
          <td><span class="mono">${costValue}</span></td>
        </tr>`;
      });

      tableBody.innerHTML = rows.join('');
    }

    function renderPagination() {
      if (!statusEl || !pageIndicator || !prevBtn || !nextBtn) return;
      const start = state.total === 0 ? 0 : (state.page - 1) * state.perPage + 1;
      const end = Math.min(state.total, state.page * state.perPage);
      statusEl.textContent = state.total === 0
        ? 'No results'
        : `Showing ${start}-${end} of ${state.total} reports`;
      pageIndicator.textContent = `Page ${state.page} / ${Math.max(1, state.pages)}`;
      prevBtn.disabled = state.page <= 1;
      nextBtn.disabled = state.page >= state.pages;
    }

    async function loadLogs() {
      if (state.loading) return;
      state.loading = true;
      applySortState();
      if (tableBody) {
        tableBody.innerHTML = '<tr class="loading-row"><td colspan="8">Loading…</td></tr>';
      }
      statusEl.textContent = 'Loading…';

      const params = new URLSearchParams({
        page: state.page,
        per_page: state.perPage,
        sort: state.sort,
        direction: state.direction,
      });
      if (state.q) params.set('q', state.q);

      try {
        const res = await fetch(`/admin/usage/ingests?${params.toString()}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const data = json.data || {};
        state.total = Number(data.total || 0);
        state.pages = Number(data.pages || 1);
        state.page = Number(data.page || state.page);
        if (data.currency) {
          state.currency = data.currency;
        }
        renderTable(data.items || []);
        renderPagination();
      } catch (err) {
        console.error('load logs', err);
        if (tableBody) {
          tableBody.innerHTML = '<tr class="error-row"><td colspan="8">Could not load logs.</td></tr>';
        }
        if (statusEl) statusEl.textContent = 'Error loading logs';
      } finally {
        state.loading = false;
      }
    }

    const handleSearch = debounce((value) => {
      state.q = value.trim();
      state.page = 1;
      loadLogs();
    }, 300);

    sortableHeaders.forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sort;
        if (!key) return;
        if (state.sort === key) {
          state.direction = state.direction === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = key;
          state.direction = key === 'created_at' ? 'desc' : 'asc';
        }
        loadLogs();
      });
    });

    searchInput?.addEventListener('input', (e) => handleSearch(e.target.value));

    pageSizeSelect?.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      state.perPage = Number.isFinite(val) ? val : 50;
      state.page = 1;
      loadLogs();
    });

    prevBtn?.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        loadLogs();
      }
    });

    nextBtn?.addEventListener('click', () => {
      if (state.page < state.pages) {
        state.page += 1;
        loadLogs();
      }
    });

    refreshBtn?.addEventListener('click', () => loadLogs());

    loadLogs();
  }

  // Admin event logs (audit trail)
  function initEventLogs() {
    const tableBody = document.querySelector('#event-log-table tbody');
    const statusEl = document.getElementById('event-log-status');
    const refreshBtn = document.getElementById('event-refresh');
    const hostSelect = document.getElementById('event-host');
    const prefixInput = document.getElementById('event-prefix');
    const windowSelect = document.getElementById('event-window');
    const searchInput = document.getElementById('event-search');
    const limitSelect = document.getElementById('event-limit');

    if (!tableBody) return;

    const state = {
      q: '',
      prefix: '',
      host: '',
      window: windowSelect?.value || '0',
      limit: Number(limitSelect?.value || 100),
      loading: false,
    };

    let hostMap = new Map(); // host_id -> fqdn
    let rows = [];

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function parseTimestamp(value) {
      if (!value) return null;
      const raw = String(value).trim();
      const normalized = raw.replace(/\.(\d{3})\d*(Z?)/, '.$1$2');
      const date = new Date(normalized);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatTimestamp(value) {
      const date = parseTimestamp(value);
      if (!date) return value || '—';
      const dd = String(date.getDate()).padStart(2, '0');
      const mm = String(date.getMonth() + 1).padStart(2, '0');
      const yy = String(date.getFullYear()).slice(-2);
      const hh = String(date.getHours()).padStart(2, '0');
      const min = String(date.getMinutes()).padStart(2, '0');
      return `${dd}.${mm}.${yy}, ${hh}:${min}`;
    }

    function tryParseJson(raw) {
      if (!raw) return null;
      if (typeof raw === 'object') return raw;
      const text = String(raw).trim();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    }

    function summarizeValue(value) {
      if (value === null || value === undefined) return '';
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (Array.isArray(value)) return `[${value.length} items]`;
      if (typeof value === 'object') return '{…}';
      return String(value);
    }

    function summarizeDetails(detailsRaw) {
      if (!detailsRaw) return '—';
      const parsed = tryParseJson(detailsRaw);
      if (!parsed) {
        const rawText = String(detailsRaw).trim();
        if (!rawText) return '—';
        return rawText.length > 220 ? `${rawText.slice(0, 220)}…` : rawText;
      }
      if (Array.isArray(parsed)) {
        return parsed.length ? `[${parsed.length} items]` : '[]';
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return String(parsed);
      }
      const entries = Object.entries(parsed)
        .filter(([_, v]) => v !== null && v !== undefined && v !== '')
        .slice(0, 6)
        .map(([k, v]) => `${k}=${summarizeValue(v)}`);
      const suffix = Object.keys(parsed).length > entries.length ? ` (+${Object.keys(parsed).length - entries.length} more)` : '';
      return entries.length ? `${entries.join(' · ')}${suffix}` : '—';
    }

    function windowCutoff(value) {
      const v = String(value || '').trim();
      if (!v || v === '0') return null;
      const m = v.match(/^(\d+)([mhd])$/);
      if (!m) return null;
      const qty = Number(m[1]);
      const unit = m[2];
      if (!Number.isFinite(qty) || qty <= 0) return null;
      const now = Date.now();
      const msPer = unit === 'm' ? 60_000 : (unit === 'h' ? 3_600_000 : 86_400_000);
      return new Date(now - qty * msPer);
    }

    function rowMatches(item, cutoff) {
      const hostFilter = (state.host || '').trim();
      if (hostFilter) {
        if (hostFilter === 'system') {
          if (item.host_id !== null && item.host_id !== undefined) return false;
        } else {
          const hostId = Number(hostFilter);
          if (!Number.isFinite(hostId)) return false;
          if (Number(item.host_id) !== hostId) return false;
        }
      }

      const prefix = (state.prefix || '').trim();
      if (prefix) {
        const action = String(item.action || '');
        if (!action.toLowerCase().startsWith(prefix.toLowerCase())) return false;
      }

      if (cutoff) {
        const ts = parseTimestamp(item.created_at);
        if (!ts) return false;
        if (ts.getTime() < cutoff.getTime()) return false;
      }

      const q = (state.q || '').trim().toLowerCase();
      if (q) {
        const hostName = item.host_fqdn || '';
        const detailsText = item.details_raw || '';
        const haystack = `${item.action || ''}\n${hostName}\n${item.host_id || ''}\n${detailsText}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    }

    function renderTable(items) {
      if (!items.length) {
        tableBody.innerHTML = '<tr class="empty-row"><td colspan="5">No events found.</td></tr>';
        return;
      }

      tableBody.innerHTML = items.map((item) => {
        const created = formatTimestamp(item.created_at);
        const hostLabel = item.host_fqdn || (item.host_id === null ? 'System' : `Host #${item.host_id}`);
        const action = item.action || '—';
        const details = summarizeDetails(item.details_raw);
        return `<tr data-event-row="${escapeHtml(item.id)}">
          <td><div class="mono">${escapeHtml(created)}</div></td>
          <td><div class="host-chip"><span class="host-name">${escapeHtml(hostLabel)}</span></div></td>
          <td><div class="mono">${escapeHtml(action)}</div></td>
          <td><div class="mono event-details">${escapeHtml(details)}</div></td>
          <td style="text-align:right;">
            <button class="ghost tiny-btn" type="button" data-event-action="copy" data-event-id="${escapeHtml(item.id)}">Copy</button>
          </td>
        </tr>`;
      }).join('');
    }

    function updateStatus(total, filtered, cutoff) {
      if (!statusEl) return;
      const windowLabel = cutoff ? ` (since ${formatTimestamp(cutoff.toISOString())})` : '';
      statusEl.textContent = total === 0
        ? 'No events'
        : `Showing ${filtered} / ${total} events${windowLabel}`;
    }

    function applyFilters() {
      const cutoff = windowCutoff(state.window);
      const filtered = rows.filter((row) => rowMatches(row, cutoff));
      renderTable(filtered);
      updateStatus(rows.length, filtered.length, cutoff);
    }

    async function loadHosts() {
      try {
        const res = await fetch('/admin/hosts', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const hosts = json?.data?.hosts || [];
        hostMap = new Map();
        hosts.forEach((h) => {
          const id = Number(h?.id);
          if (!Number.isFinite(id)) return;
          const fqdn = String(h?.fqdn || '').trim();
          if (!fqdn) return;
          hostMap.set(id, fqdn);
        });

        if (hostSelect) {
          const keep = new Set(['', 'system']);
          const existing = Array.from(hostSelect.options || []).filter((opt) => keep.has(opt.value));
          hostSelect.innerHTML = '';
          existing.forEach((opt) => hostSelect.appendChild(opt));

          Array.from(hostMap.entries())
            .sort((a, b) => a[1].localeCompare(b[1]))
            .forEach(([id, fqdn]) => {
              const opt = document.createElement('option');
              opt.value = String(id);
              opt.textContent = fqdn;
              hostSelect.appendChild(opt);
            });
        }
      } catch (err) {
        // Host mapping is best-effort; table still works with host_id.
        console.warn('event logs host list', err);
      }
    }

    async function loadLogs() {
      if (state.loading) return;
      state.loading = true;
      if (statusEl) statusEl.textContent = 'Loading…';
      tableBody.innerHTML = '<tr class="loading-row"><td colspan="5">Loading…</td></tr>';

      const limit = Number.isFinite(state.limit) ? state.limit : 100;
      const safeLimit = Math.max(1, Math.min(limit, 500));
      try {
        const res = await fetch(`/admin/logs?limit=${encodeURIComponent(String(safeLimit))}`, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const items = json?.data?.logs || [];
        rows = items.map((item) => {
          const hostId = item.host_id === null || item.host_id === undefined ? null : Number(item.host_id);
          const hostFqdn = (hostId !== null && hostMap.has(hostId)) ? hostMap.get(hostId) : '';
          const detailsRaw = item.details ?? null;
          return {
            id: item.id ?? '',
            host_id: hostId,
            host_fqdn: hostFqdn,
            action: item.action ?? '',
            details_raw: detailsRaw ? String(detailsRaw) : '',
            created_at: item.created_at ?? '',
          };
        });

        applyFilters();
      } catch (err) {
        console.error('event logs', err);
        tableBody.innerHTML = '<tr class="error-row"><td colspan="5">Could not load events.</td></tr>';
        if (statusEl) statusEl.textContent = 'Error loading events';
      } finally {
        state.loading = false;
      }
    }

    function copyToClipboard(text) {
      const value = String(text || '');
      if (navigator.clipboard?.writeText) {
        return navigator.clipboard.writeText(value);
      }
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand('copy');
      } finally {
        document.body.removeChild(ta);
      }
      return Promise.resolve();
    }

    tableBody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-event-action="copy"]');
      if (!btn) return;
      ev.preventDefault();
      const id = btn.getAttribute('data-event-id');
      const row = rows.find((r) => String(r.id) === String(id));
      if (!row) return;
      const detailsParsed = tryParseJson(row.details_raw);
      const payload = {
        id: row.id,
        created_at: row.created_at || null,
        host_id: row.host_id,
        host_fqdn: row.host_fqdn || null,
        action: row.action || null,
        details: detailsParsed ?? (row.details_raw || null),
      };
      const previous = btn.textContent;
      btn.textContent = 'Copying…';
      copyToClipboard(JSON.stringify(payload, null, 2))
        .then(() => { btn.textContent = 'Copied'; })
        .catch(() => { btn.textContent = 'Copy failed'; })
        .finally(() => {
          setTimeout(() => { btn.textContent = previous; }, 900);
        });
    });

    const handleSearch = debounce((value) => {
      state.q = value.trim();
      applyFilters();
    }, 200);

    searchInput?.addEventListener('input', (ev) => handleSearch(ev.target.value));
    prefixInput?.addEventListener('input', (ev) => {
      state.prefix = ev.target.value;
      applyFilters();
    });
    hostSelect?.addEventListener('change', (ev) => {
      state.host = ev.target.value;
      applyFilters();
    });
    windowSelect?.addEventListener('change', (ev) => {
      state.window = ev.target.value;
      applyFilters();
    });
    limitSelect?.addEventListener('change', (ev) => {
      const v = Number(ev.target.value);
      state.limit = Number.isFinite(v) ? v : 100;
      loadLogs();
    });
    refreshBtn?.addEventListener('click', (ev) => {
      ev.preventDefault();
      loadLogs();
    });

    // load order: hosts first (for fqdn mapping), then logs
    loadHosts().finally(() => loadLogs());
  }

  // MCP logs
  function initMcpLogs() {
    const tableBody = document.querySelector('#mcp-log-table tbody');
    const refreshBtn = document.getElementById('mcp-refresh');
    if (!tableBody) return;

    const formatStatus = (item) => {
      if (item.success) return 'ok';
      const code = item.error_code ? `code ${item.error_code}` : null;
      const msg = item.error_message || null;
      if (code && msg) return `fail (${code}: ${msg})`;
      if (msg) return `fail (${msg})`;
      if (code) return `fail (${code})`;
      return 'fail';
    };

    const formatHost = (item) => item.host_fqdn || item.host || '—';
    const formatTool = (item) => item.name || item.method || '—';
    const formatTime = (ts) => ts || '—';

    async function loadMcpLogs() {
      try {
        tableBody.innerHTML = '<tr class="loading-row"><td colspan="4">Loading…</td></tr>';
        const res = await fetch('/admin/mcp/logs', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        const items = json?.data?.logs || [];
        if (!items.length) {
          tableBody.innerHTML = '<tr class="empty-row"><td colspan="4">No logs.</td></tr>';
          return;
        }
        tableBody.innerHTML = items.map((item) => {
          const ts = formatTime(item.created_at);
          const host = formatHost(item);
          const tool = formatTool(item);
          const status = formatStatus(item);
          return `<tr><td>${ts}</td><td>${host}</td><td>${tool}</td><td>${status}</td></tr>`;
        }).join('');
      } catch (err) {
        tableBody.innerHTML = `<tr class=\"error-row\"><td colspan=\"4\">Failed: ${err.message}</td></tr>`;
      }
    }

    refreshBtn?.addEventListener('click', (ev) => {
      ev.preventDefault();
      loadMcpLogs();
    });

    loadMcpLogs();
  }

  // Export inits for router (aliases kept for legacy callers)
  window.initClientLogs = window.initClientLogs || initClientLogs;
  window.initMcpLogs = window.initMcpLogs || initMcpLogs;
  window.initEventLogs = window.initEventLogs || initEventLogs;
  window.__initClientLogs = window.__initClientLogs || initClientLogs;
  window.__initMcpLogs = window.__initMcpLogs || initMcpLogs;
  window.__initEventLogs = window.__initEventLogs || initEventLogs;

  // If the page loaded directly on a logs hash before dashboard.js ran the router,
  // eagerly initialize the visible tab so the table isn't empty.
  const currentHash = (window.location.hash || '').replace(/^#/, '');
  const [panel, sub] = currentHash.split('/');
  if (panel === 'logs') {
    const tab = sub === 'mcp'
      ? 'mcp'
      : (sub === 'events' ? 'events' : 'client');
    if (tab === 'client') {
      initClientLogs();
      window.__initClientLogs = null;
    } else if (tab === 'events') {
      initEventLogs();
      window.__initEventLogs = null;
    } else {
      initMcpLogs();
      window.__initMcpLogs = null;
    }
  }
})();
