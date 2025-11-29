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

  const state = {
    page: 1,
    perPage: Number(pageSizeSelect?.value || 50),
    q: '',
    sort: 'created_at',
    direction: 'desc',
    total: 0,
    pages: 1,
    loading: false,
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

  function payloadPreview(payload) {
    if (!payload) return '<span class="muted">—</span>';
    let preview = String(payload);
    try {
      const parsed = JSON.parse(payload);
      preview = JSON.stringify(parsed);
    } catch (_) {
      // leave as-is when not JSON
    }
    preview = preview.replace(/\s+/g, ' ').trim();
    if (preview.length > 140) preview = `${preview.slice(0, 140)}…`;
    return `<code class="payload-preview">${escapeHtml(preview)}</code>`;
  }

  function renderTable(items) {
    if (!tableBody) return;
    if (!items.length) {
      tableBody.innerHTML = '<tr class="empty-row"><td colspan="6">No client reports yet.</td></tr>';
      return;
    }

    const rows = items.map((item) => {
      const created = formatTimestamp(item.created_at);
      const host = item.fqdn ? escapeHtml(item.fqdn) : 'Unknown';
      const hostMeta = item.host_id ? `<span class="muted mono">#${item.host_id}</span>` : '<span class="muted">n/a</span>';
      const clientIp = item.client_ip ? escapeHtml(item.client_ip) : '—';
      const entries = formatNumber(item.entries);
      const tokenTotal = formatNumber(item.total);
      const mini = [
        ['input', item.input],
        ['output', item.output],
        ['cached', item.cached],
        ['reason', item.reasoning],
      ]
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([label, value]) => `<span class="token-chip token-${label}">${label}: ${formatNumber(value)}</span>`)
        .join('');

      return `<tr>
        <td><div class="mono">${created}</div></td>
        <td>
          <div class="host-chip">
            <span class="host-name">${host}</span>
            ${hostMeta}
          </div>
        </td>
        <td><span class="badge">${entries}</span></td>
        <td>
          <div class="token-total">${tokenTotal}</div>
          <div class="token-breakdown">${mini || '<span class="muted">n/a</span>'}</div>
        </td>
        <td><span class="mono">${clientIp}</span></td>
        <td>${payloadPreview(item.payload)}</td>
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
      tableBody.innerHTML = '<tr class="loading-row"><td colspan="6">Loading…</td></tr>';
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
      renderTable(data.items || []);
      renderPagination();
    } catch (err) {
      console.error('load logs', err);
      if (tableBody) {
        tableBody.innerHTML = '<tr class="error-row"><td colspan="6">Could not load logs.</td></tr>';
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

  loadLogs();
})();
