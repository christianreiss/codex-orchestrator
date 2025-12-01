(() => {
  const tableBody = document.querySelector('#log-table tbody');
  const searchInput = document.getElementById('log-search');
  const pageSizeSelect = document.getElementById('log-page-size');
  const statusEl = document.getElementById('log-status');
  const pageIndicator = document.getElementById('page-indicator');
  const prevBtn = document.getElementById('page-prev');
  const nextBtn = document.getElementById('page-next');
  const refreshBtn = document.getElementById('log-refresh');
  const sortableHeaders = document.querySelectorAll('#log-table th.sortable');
  const apiToggleBtn = document.getElementById('api-toggle-btn');

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
  let apiDisabled = null;

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
    const formatted = num.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
    return state.currency ? `${formatted} ${state.currency}` : formatted;
  }

  function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const init = {
      cache: 'no-store',
      headers,
      method: opts.method || 'GET',
    };
    if (Object.prototype.hasOwnProperty.call(opts, 'json')) {
      init.body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    } else if (Object.prototype.hasOwnProperty.call(opts, 'body')) {
      init.body = opts.body;
    }

    return fetch(path, init).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`);
      }
      return res.json();
    });
  }

  async function loadApiState() {
    if (!apiToggleBtn) return;
    try {
      const res = await api('/admin/api/state');
      apiDisabled = !!(res.data && res.data.disabled);
      apiToggleBtn.textContent = 'API';
      apiToggleBtn.title = apiDisabled ? 'API disabled — click to enable' : 'API enabled — click to disable';
      apiToggleBtn.classList.remove('danger', 'ghost', 'api-enabled', 'api-disabled');
      apiToggleBtn.classList.add(apiDisabled ? 'api-disabled' : 'api-enabled');
    } catch (err) {
      console.error('api state', err);
      apiToggleBtn.textContent = 'API: unavailable';
      apiToggleBtn.classList.add('danger');
    }
  }

  async function setApiState(enabled) {
    if (!apiToggleBtn) return;
    const original = apiToggleBtn.textContent;
    apiToggleBtn.disabled = true;
    apiToggleBtn.textContent = enabled ? 'Enabling…' : 'Disabling…';
    try {
      await api('/admin/api/state', {
        method: 'POST',
        json: { disabled: !enabled },
      });
      apiDisabled = !enabled;
    } catch (err) {
      alert(`API toggle failed: ${err.message}`);
    } finally {
      apiToggleBtn.disabled = false;
      apiToggleBtn.textContent = original;
      loadApiState();
    }
  }

  function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
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
        <td>
          <div class="host-chip">
            <span class="host-name">${host}</span>
          </div>
        </td>
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

  if (searchInput) {
    searchInput.addEventListener('input', (e) => handleSearch(e.target.value));
  }

  if (pageSizeSelect) {
    pageSizeSelect.addEventListener('change', (e) => {
      const val = Number(e.target.value);
      state.perPage = Number.isFinite(val) ? val : 50;
      state.page = 1;
      loadLogs();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        loadLogs();
      }
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (state.page < state.pages) {
        state.page += 1;
        loadLogs();
      }
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => loadLogs());
  }

  if (apiToggleBtn) {
    apiToggleBtn.addEventListener('click', () => {
      if (apiDisabled === null) return;
      setApiState(!apiDisabled);
    });
    loadApiState();
  }

  loadLogs();
})();
