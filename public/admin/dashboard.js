const statsEl = document.getElementById('stats');
    const hostsTbody = document.querySelector('#hosts tbody');
    const mtlsEl = document.getElementById('mtls');
    const versionCheckBtn = document.getElementById('version-check');
    const filterInput = document.getElementById('host-filter');
    const newHostBtn = document.getElementById('newHostBtn');
    const newHostModal = document.getElementById('newHostModal');
    const newHostName = document.getElementById('new-host-name');
    const secureHostToggle = document.getElementById('secureHostToggle');
    const insecureToggle = document.getElementById('insecureToggle');
    const ipv4Toggle = document.getElementById('ipv4Toggle');
    const createHostBtn = document.getElementById('createHost');
    const cancelNewHostBtn = document.getElementById('cancelNewHost');
    const commandField = document.getElementById('commandField');
    const bootstrapCmdEl = document.getElementById('bootstrapCmd');
    const copyCmdBtn = document.getElementById('copyCmd');
    const installerMeta = document.getElementById('installerMeta');
    const uploadAuthBtn = document.getElementById('uploadAuthBtn');
    const uploadModal = document.getElementById('uploadModal');
    const uploadAuthText = document.getElementById('uploadAuthText');
    const uploadAuthFile = document.getElementById('uploadAuthFile');
    const uploadAuthSubmit = document.getElementById('uploadAuthSubmit');
    const uploadAuthCancel = document.getElementById('uploadAuthCancel');
    const uploadHostSelect = document.getElementById('uploadHostSelect');
    const uploadStatus = document.getElementById('uploadStatus');
    const apiToggleBtn = document.getElementById('api-toggle-btn');
    const seedModal = document.getElementById('seedModal');
    const seedUploadBtn = document.getElementById('seedUploadBtn');
    const seedDismissBtn = document.getElementById('seedDismissBtn');
    const seedModalCopy = document.getElementById('seedModalCopy');
    const seedHostsStatus = document.getElementById('seedHostsStatus');
    const seedAuthStatus = document.getElementById('seedAuthStatus');
    const runnerRunnerBtn = document.getElementById('runner-runner');
    const runnerModal = document.getElementById('runnerModal');
    const runnerLogEl = document.getElementById('runnerLog');
    const runnerMetaEl = document.getElementById('runnerMeta');
    const runnerCloseBtn = document.getElementById('runnerClose');
    const upgradeModal = document.getElementById('upgradeModal');
    const upgradeNotesEl = document.getElementById('upgradeNotes');
    const upgradeVersionEl = document.getElementById('upgradeVersionLabel');
    const upgradeGithubLink = document.getElementById('upgradeGithubLink');
    const upgradeCloseBtn = document.getElementById('upgradeClose');
    const usageHistoryModal = document.getElementById('usageHistoryModal');
    const usageHistoryChart = document.getElementById('usageHistoryChart');
    const usageHistorySubtitle = document.getElementById('usageHistorySubtitle');
    const usageHistoryMeta = document.getElementById('usageHistoryMeta');
    const usageHistoryCloseBtn = document.getElementById('usageHistoryClose');
    const costHistoryModal = document.getElementById('costHistoryModal');
    const costHistoryChart = document.getElementById('costHistoryChart');
    const costHistorySubtitle = document.getElementById('costHistorySubtitle');
    const costHistoryMeta = document.getElementById('costHistoryMeta');
    const costHistoryCloseBtn = document.getElementById('costHistoryClose');
    const deleteHostModal = document.getElementById('deleteHostModal');
    const deleteHostText = document.getElementById('delete-host-text');
    const cancelDeleteHostBtn = document.getElementById('cancelDeleteHost');
    const confirmDeleteHostBtn = document.getElementById('confirmDeleteHost');
    const hostDetailModal = document.getElementById('hostDetailModal');
    const hostDetailTitle = document.getElementById('hostDetailTitle');
    const hostDetailPills = document.getElementById('hostDetailPills');
    const hostDetailGrid = document.getElementById('hostDetailGrid');
    const hostDetailActions = document.getElementById('hostDetailActions');
    const hostDetailSummary = document.getElementById('hostDetailSummary');
    const closeHostDetailBtn = document.getElementById('closeHostDetail');
    const chatgptUsageCard = document.getElementById('chatgpt-usage-card');
    const promptsTbody = document.querySelector('#prompts tbody');
    const promptModal = document.getElementById('promptModal');
    const promptFilename = document.getElementById('promptFilename');
    const promptDescription = document.getElementById('promptDescription');
    const promptArgument = document.getElementById('promptArgument');
    const promptBody = document.getElementById('promptBody');
    const promptSave = document.getElementById('promptSave');
    const promptCancel = document.getElementById('promptCancel');
    const promptStatus = document.getElementById('promptStatus');
    const promptsPanel = document.getElementById('prompts-panel');
    const quotaToggle = document.getElementById('quotaHardFailToggle');
    const quotaModeLabel = document.getElementById('quotaModeLabel');
    const USAGE_HISTORY_DAYS = 60;
    const COST_SERIES = [
      { key: 'input', label: 'Input', color: '#0ea5e9' },
      { key: 'output', label: 'Output', color: '#16a34a' },
      { key: 'cached', label: 'Cached', color: '#f97316' },
    ];
    let pendingDeleteId = null;

    const upgradeNotesCache = {};
    let currentHosts = [];
    let currentPrompts = [];
    let latestVersions = { client: null, wrapper: null };
    let tokensSummary = null;
    let runnerSummary = null;
    let hostFilterText = '';
    let hostSort = { key: 'last_seen', direction: 'desc' };
    let hostStatusFilter = ''; // maintained for clarity
    let lastOverview = null;
    let chatgptUsage = null;
    let apiDisabled = null;
    let mtlsMeta = null;
    let uploadFileContent = '';
    let quotaHardFail = true;
    let chatgptUsageHistory = null;
    let chatgptUsageHistoryPromise = null;
    let costHistory = null;
    let costHistoryPromise = null;
    let activeHostId = null;

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

    function formatCountdown(value) {
      const ts = parseTimestamp(value);
      if (!ts) return '—';
      const diff = ts.getTime() - Date.now();
      if (diff <= 0) return 'expired';
      const mins = Math.round(diff / 60000);
      if (mins >= 90) {
        const hours = Math.round(mins / 60);
        return `${hours}h left`;
      }
      return `${mins}m left`;
    }

    function countdownMinutes(value) {
      const ts = parseTimestamp(value);
      if (!ts) return null;
      const diff = ts.getTime() - Date.now();
      if (diff <= 0) return 0;
      return Math.max(0, Math.round(diff / 60000));
    }

    function api(path, opts = {}) {
      const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
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
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        return res.json();
      });
    }

    function copyToClipboard(text) {
      return navigator.clipboard?.writeText(text).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
    }

    function addCurlFlag(cmd, flag) {
      if (!cmd || !flag) return cmd;
      return cmd.replace(/curl\b/g, (match) => `${match} ${flag}`);
    }

    async function loadApiState() {
      try {
        const res = await api('/admin/api/state');
        apiDisabled = !!res.data?.disabled;
        if (apiToggleBtn) {
          apiToggleBtn.textContent = 'API';
          apiToggleBtn.title = apiDisabled ? 'API disabled — click to enable' : 'API enabled — click to disable';
          apiToggleBtn.classList.remove('danger', 'ghost', 'api-enabled', 'api-disabled');
          apiToggleBtn.classList.add(apiDisabled ? 'api-disabled' : 'api-enabled');
        }
      } catch (err) {
        console.error('api state', err);
        if (apiToggleBtn) {
          apiToggleBtn.textContent = 'API: unavailable';
          apiToggleBtn.classList.add('danger');
        }
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

    async function setQuotaMode(hardFail) {
      if (!quotaToggle) return;
      quotaToggle.disabled = true;
      try {
        await api('/admin/quota-mode', {
          method: 'POST',
          json: { hard_fail: !!hardFail },
        });
        quotaHardFail = !!hardFail;
        renderQuotaMode();
      } catch (err) {
        alert(`Quota policy update failed: ${err.message}`);
        quotaToggle.checked = quotaHardFail;
      } finally {
        quotaToggle.disabled = false;
      }
    }

    function setMtls(meta) {
      mtlsMeta = meta;
      if (!mtlsEl) return;
      mtlsEl.style.display = 'inline-flex';

      const required = meta && meta.required === false ? false : true;
      const present = !!(meta && (meta.present || meta.fingerprint));

      if (!required) {
        mtlsEl.textContent = present ? 'mTLS: presented (optional)' : 'mTLS: optional';
        mtlsEl.classList.remove('error');
        if (present) {
          mtlsEl.classList.add('success');
        } else {
          mtlsEl.classList.remove('success');
        }
        return;
      }

      if (present) {
        mtlsEl.textContent = 'mTLS: presented';
        mtlsEl.classList.add('success');
        mtlsEl.classList.remove('error');
      } else {
        mtlsEl.textContent = 'mTLS: missing (admin blocked)';
        mtlsEl.classList.remove('success');
        mtlsEl.classList.add('error');
      }
    }

    function compareVersions(a, b) {
      const normalize = (v) => {
        if (typeof v !== 'string') return null;
        let n = v.trim();
        n = n.replace(/^(codex-cli|codex|rust-)/i, '');
        n = n.replace(/^v/i, '');
        return n;
      };
      const left = normalize(a);
      const right = normalize(b);
      if (!left || !right) return null;
      const leftParts = left.split(/[^0-9]+/).map(Number).filter(n => !Number.isNaN(n));
      const rightParts = right.split(/[^0-9]+/).map(Number).filter(n => !Number.isNaN(n));
      const len = Math.max(leftParts.length, rightParts.length);
      for (let i = 0; i < len; i++) {
        const l = leftParts[i] ?? 0;
        const r = rightParts[i] ?? 0;
        if (l > r) return 1;
        if (l < r) return -1;
      }
      return 0;
    }

    function renderVersionTag(version, current) {
      const normalized = typeof version === 'string' ? version.trim().replace(/^v/i, '') : null;
      if (!normalized) return '—';
      const cmp = compareVersions(normalized, current);
      const tone = cmp === -1 ? 'warn' : cmp === 1 ? 'neutral' : 'ok';
      return `<span class="chip ${tone}">${escapeHtml(normalized)}</span>`;
    }

    function renderStatusPill(status) {
      const normalized = typeof status === 'string' ? status.toLowerCase() : 'unknown';
      const slug = ['active', 'suspended'].includes(normalized) ? normalized : 'unknown';
      return `<span class="status-pill status-${slug}">${status ?? 'unknown'}</span>`;
    }

    function formatMinutesAgo(value) {
      const date = parseTimestamp(value);
      if (!date) return '—';
      const delta = Date.now() - date.getTime();
      const future = delta < 0;
      const minutes = Math.round(Math.abs(delta) / 60000);
      const suffix = future ? 'from now' : 'ago';
      return `${minutes} min ${suffix}`;
    }

    function formatRelative(value) {
      const date = parseTimestamp(value);
      if (!date) return '—';
      const now = Date.now();
      const diff = now - date.getTime();
      const future = diff < 0;
      const delta = Math.abs(diff);
      const minutes = Math.round(delta / 60000);
      const hours = Math.round(delta / 3600000);
      const days = Math.round(delta / 86400000);
      const suffix = future ? 'from now' : 'ago';
      if (delta < 45 * 1000) return future ? 'in a few seconds' : 'just now';
      if (delta < 90 * 1000) return future ? 'in 1 minute' : '1 minute ago';
      if (delta < 45 * 60 * 1000) return `${minutes} min ${suffix}`;
      if (delta < 36 * 60 * 60 * 1000) return `${hours} h ${suffix}`;
      if (delta < 14 * 24 * 60 * 60 * 1000) return `${days} d ${suffix}`;
      return formatTimestamp(value);
    }

    function formatUntil(value) {
      const date = parseTimestamp(value);
      if (!date) return 'soon';
      const diff = date.getTime() - Date.now();
      if (diff <= 0) return 'imminently';
      const minutes = Math.round(diff / 60000);
      if (minutes < 90) return `${minutes} min`;
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      if (hours < 48) return `${hours}h ${mins}m`;
      const days = Math.floor(hours / 24);
      const hrs = hours % 24;
      return `${days}d ${hrs}h`;
    }

    function formatDurationSeconds(value) {
      if (!Number.isFinite(value)) return null;
      const seconds = Math.max(0, Math.floor(value));
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor((seconds % 86400) / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const parts = [];
      if (days > 0) parts.push(`${days}d`);
      if (hours > 0) parts.push(`${hours}h`);
      if (minutes > 0) parts.push(`${minutes}m`);
      if (parts.length) return parts.join(' ');
      return `${seconds || 1}s`;
    }

    function formatResetLabel(seconds, resetAt) {
      if (Number.isFinite(seconds)) {
        const duration = formatDurationSeconds(seconds);
        return duration ? `${duration} to reset` : 'reset time unknown';
      }
      if (resetAt) {
        return `resets ${formatRelative(resetAt)}`;
      }
      return 'reset time unknown';
    }

    function formatMoney(amount, currency = 'USD') {
      if (!Number.isFinite(amount)) return `${currency} —`;
      return `${currency} ${amount.toFixed(2)}`;
    }

    function hostPruneMeta(host) {
      const last = host?.last_refresh || host?.updated_at || null;
      const lastTs = parseTimestamp(last);
      if (!lastTs) return { daysLeft: null };
      const cutoff = lastTs.getTime() + (30 * 24 * 60 * 60 * 1000);
      const daysLeft = (cutoff - Date.now()) / 86400000;
      return { daysLeft };
    }

    function hostHealth(host) {
      if (!isHostSecure(host)) {
        const { enabledActive, graceActive } = insecureState(host);
        if (!enabledActive && !graceActive) {
          return { tone: 'warning', label: 'Locked' };
        }
        if (graceActive) {
          return { tone: 'warning', label: 'Insecure grace window' };
        }
      }
      const status = (host?.status || '').toLowerCase();
      const authed = host?.authed === true;
      const canLogin = status === 'active' && authed;
      const { daysLeft } = hostPruneMeta(host);
      if (daysLeft !== null && daysLeft <= 3) {
        return { tone: 'critical', label: 'Pruning in ≤3d' };
      }
      if (daysLeft !== null && daysLeft <= 10) {
        return { tone: 'warning', label: `Pruning in ${Math.max(0, Math.ceil(daysLeft))}d` };
      }
      if (!canLogin) {
        return { tone: 'ok', label: 'Not provisioned yet' };
      }
      return { tone: 'ok', label: 'Can login' };
    }

    function isHostSecure(host) {
      if (!host) return true;
      if (typeof host.secure === 'boolean') return host.secure;
      if (typeof host.secure === 'number') return host.secure !== 0;
      return true;
    }

    function insecureState(host) {
      const now = Date.now();
      const enabledTs = parseTimestamp(host?.insecure_enabled_until)?.getTime?.();
      const graceTs = parseTimestamp(host?.insecure_grace_until)?.getTime?.();
      const enabledActive = Number.isFinite(enabledTs) && enabledTs >= now;
      const graceActive = Number.isFinite(graceTs) && graceTs >= now;
      return { enabledActive, graceActive, enabledTs: enabledTs || null, graceTs: graceTs || null };
    }

    function renderTokenCell(host) {
      const total = host?.token_usage?.total ?? null;
      if (total === null) return '—';
      const runs = host?.token_usage?.events;
      const percent = tokensSummary?.total
        ? Math.min(100, Math.round((total / tokensSummary.total) * 100))
        : 0;
      return `
        <div class="token-cell">
          <span>${formatNumber(total)}${runs ? ` · ${formatNumber(runs)} runs` : ''}</span>
          ${percent ? `<div class="meter"><span style="width:${percent}%"></span></div>` : ''}
        </div>
      `;
    }

    function applyHostFilters(list) {
      return list.filter(host => {
        if (!hostFilterText) return true;
        const haystacks = [host.fqdn, host.ip, host.client_version, host.wrapper_version]
          .map(value => (typeof value === 'string' ? value.toLowerCase() : ''));
        return haystacks.some(text => text.includes(hostFilterText));
      });
    }

    function hostSortValue(host, key) {
      switch (key) {
        case 'host':
          return (host.fqdn || '').toLowerCase();
        case 'last_seen': {
          const ts = parseTimestamp(host.updated_at);
          return ts ? ts.getTime() : -Infinity;
        }
        case 'client':
          return (host.client_version || '').toLowerCase();
        case 'wrapper':
          return (host.wrapper_version || '').toLowerCase();
        case 'ip':
          return (host.ip || '').toLowerCase();
        default:
          return '';
      }
    }

    function sortHosts(list) {
      const sorted = [...list];
      sorted.sort((a, b) => {
        const aVal = hostSortValue(a, hostSort.key);
        const bVal = hostSortValue(b, hostSort.key);
        let result;
        if (Number.isFinite(aVal) && Number.isFinite(bVal)) {
          result = aVal - bVal;
        } else {
          result = String(aVal).localeCompare(String(bVal), undefined, { sensitivity: 'base' });
        }
        if (result === 0) {
          result = String(a.fqdn || '').localeCompare(String(b.fqdn || ''), undefined, { sensitivity: 'base' });
        }
        return hostSort.direction === 'desc' ? -result : result;
      });
      return sorted;
    }

    function updateSortIndicators() {
      document.querySelectorAll('.sort-btn[data-sort]').forEach((btn) => {
        const key = btn.getAttribute('data-sort');
        const indicator = btn.querySelector('.sort-indicator');
        const isActive = key === hostSort.key;
        btn.classList.toggle('sorted', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        btn.setAttribute('aria-sort', isActive ? (hostSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
        if (indicator) {
          indicator.textContent = isActive
            ? (hostSort.direction === 'asc' ? '▲' : '▼')
            : '↕';
        }
      });
    }

    function setHostSort(key) {
      const defaultDirection = key === 'last_seen' ? 'desc' : 'asc';
      if (hostSort.key === key) {
        hostSort = { key, direction: hostSort.direction === 'asc' ? 'desc' : 'asc' };
      } else {
        hostSort = { key, direction: defaultDirection };
      }
      updateSortIndicators();
      paintHosts();
    }

    function formatRelativeWithTimestamp(value) {
      if (!value) return '—';
      const relative = formatRelative(value);
      const absolute = formatTimestamp(value);
      return `${relative} (${absolute})`;
    }

    function renderTokenUsageValue(usage) {
      if (!usage || usage.total === null || usage.total === undefined) return 'No usage yet';
      const total = Number(usage.total) || 0;
      const breakdownKeys = ['input', 'output', 'cached', 'reasoning'];
      const bars = breakdownKeys.map(key => {
        const val = Number(usage[key]);
        if (!Number.isFinite(val) || val <= 0) return '';
        const pct = total > 0 ? Math.min(100, Math.max(6, Math.round((val / total) * 100))) : 0;
        return `
          <div class="token-usage-bar">
            <span class="token-usage-label">${key}</span>
            <div class="token-usage-track">
              <span class="token-usage-fill token-usage-${key}" style="width:${pct}%;"></span>
            </div>
            <span class="token-usage-count">${formatNumber(val)}</span>
          </div>
        `;
      }).filter(Boolean).join('');
      const when = usage.created_at ? `reported ${formatRelative(usage.created_at)}` : '';
      const line = '';
      return `
        <div class="token-usage">
          <div class="token-usage-head">
            <div class="token-usage-total">${formatNumber(total)} tokens</div>
            ${usage.model ? `<span class="chip neutral">${escapeHtml(usage.model)}</span>` : ''}
          </div>
          ${bars ? `<div class="token-usage-bars">${bars}</div>` : ''}
          ${when || line ? `<div class="token-usage-meta muted">${escapeHtml(when)}${line ? ` · ${escapeHtml(line)}` : ''}</div>` : ''}
        </div>
      `;
    }

    function renderHostActionButtons(host) {
      const roamingLabel = host.allow_roaming_ips ? 'Lock to IP' : 'Allow roaming';
      const securityLabel = isHostSecure(host) ? 'Mark insecure' : 'Mark secure';
      const insecure = !isHostSecure(host);
      const state = insecureState(host);
      const minutesLeft = countdownMinutes(host.insecure_enabled_until);
      const insecureLabel = state.enabledActive ? `Turn Off (${minutesLeft ?? 0} min)` : 'Turn On';
      const insecureClasses = state.enabledActive ? 'ghost danger' : 'ghost primary';
      const ipv4Label = host.force_ipv4 ? 'Allow IPv6' : 'Force IPv4';
      return `
        <button class="ghost secondary" data-action="install">Install script</button>
        <button class="ghost" data-action="toggle-roaming">${roamingLabel}</button>
        <button class="ghost" data-action="toggle-security">${securityLabel}</button>
        ${insecure ? `<button class="${insecureClasses}" data-action="toggle-insecure-api">${insecureLabel}</button>` : ''}
        <button class="ghost" data-action="toggle-ipv4">${ipv4Label}</button>
        <button class="ghost" data-action="clear">Clear auth</button>
        <button class="danger" data-action="remove">Remove</button>
      `;
    }

    function bindHostDetailActions(host) {
      if (!hostDetailActions) return;
        hostDetailActions.querySelectorAll('button').forEach(btn => {
          btn.onclick = (ev) => {
            ev.stopPropagation();
            const action = btn.getAttribute('data-action');
            if (action === 'install') {
              showHostDetailModal(false);
              regenerateInstaller(host.fqdn, host.id);
            } else if (action === 'toggle-roaming') {
              toggleRoaming(host.id);
            } else if (action === 'toggle-security') {
              toggleSecurity(host.id);
            } else if (action === 'toggle-insecure-api') {
              toggleInsecureApi(host, btn);
            } else if (action === 'toggle-ipv4') {
              toggleIpv4(host, btn);
            } else if (action === 'clear') {
              confirmClear(host.id);
            } else if (action === 'remove') {
              showHostDetailModal(false);
              openDeleteModal(host.id);
          }
        };
      });
    }

    function renderHostSummary(host) {
      if (!hostDetailSummary) return;
      const health = hostHealth(host);
      const clientTag = renderVersionTag(host.client_version, latestVersions.client);
      const wrapperTag = renderVersionTag(host.wrapper_version, latestVersions.wrapper);
      const summaryItems = [
        {
          label: 'Health',
          value: health.label,
          meta: host.authed ? 'Canonical auth stored' : 'Not provisioned yet',
        },
        {
          label: 'Last Seen',
          value: host.updated_at ? formatRelative(host.updated_at) : 'Never',
          meta: host.updated_at ? formatTimestamp(host.updated_at) : 'No API calls yet',
        },
        {
          label: 'Tokens',
          value: host.token_usage?.total !== null && host.token_usage?.total !== undefined
            ? `${formatNumber(host.token_usage.total)}`
            : '—',
          meta: host.token_usage?.created_at ? `reported ${formatRelative(host.token_usage.created_at)}` : 'No usage yet',
        },
        {
          label: 'Versions',
          value: `${clientTag} ${wrapperTag}`,
          meta: 'Client · Wrapper',
          raw: true,
        },
      ];
      hostDetailSummary.innerHTML = summaryItems.map(item => `
        <div class="summary-card">
          <div class="label">${escapeHtml(item.label)}</div>
          <div class="value">${item.raw ? item.value : escapeHtml(item.value ?? '—')}</div>
          ${item.meta ? `<div class="meta">${escapeHtml(item.meta)}</div>` : ''}
        </div>
      `).join('');
    }

    function hostDetailRows(host) {
      const health = hostHealth(host);
      const insecureStateNow = !isHostSecure(host) ? insecureState(host) : null;
      const insecureStatus = isHostSecure(host)
        ? ''
        : insecureStateNow?.enabledActive
          ? `<span class="chip warn">Insecure · ${formatCountdown(host.insecure_enabled_until)} left</span>`
          : insecureStateNow?.graceActive
            ? `<span class="chip warn">Insecure · grace ${formatCountdown(host.insecure_grace_until)}</span>`
            : '<span class="chip warn">Insecure · window closed</span>';
      const healthDesc = 'Provisioning and sync signal for this host.';
      const clientTag = renderVersionTag(host.client_version, latestVersions.client);
      const wrapperTag = renderVersionTag(host.wrapper_version, latestVersions.wrapper);
      const apiCallsLabel = host.api_calls !== null && host.api_calls !== undefined
        ? ` (${formatNumber(host.api_calls)} api calls)`
        : '';
      const securityChip = isHostSecure(host)
        ? '<span class="chip ok">Secure</span>'
        : '<span class="chip warn">Insecure</span>';
      const ipv4Chip = host.force_ipv4 ? '<span class="chip neutral">IPv4 only</span>' : '';
      const rows = [
        {
          key: 'Status',
          value: `${renderStatusPill(host.status)} ${securityChip} ${insecureStatus}`,
          desc: 'Host entry state; suspended hosts cannot authenticate. Insecure hosts purge auth.json after each run.',
        },
        { key: 'Health', value: `<span class="chip ${health.tone === 'ok' ? 'ok' : 'warn'}">${health.label}</span>`, desc: healthDesc },
        { key: 'Last seen', value: `${formatRelativeWithTimestamp(host.updated_at)}${apiCallsLabel}`, desc: 'Timestamp of the most recent API call from this host.' },
        { key: 'Auth refresh', value: formatRelativeWithTimestamp(host.last_refresh), desc: 'When auth.json was last uploaded or fetched.' },
        {
          key: 'IP binding',
          value: `
            <div class="kv-ip">
              ${host.ip ? `<code>${escapeHtml(host.ip)}</code>` : 'Not yet bound'}
              <span class="chip ${host.allow_roaming_ips ? 'warn' : 'ok'}">${host.allow_roaming_ips ? 'Roaming enabled' : 'IP locked'}</span>
              ${ipv4Chip}
            </div>
          `,
          desc: host.allow_roaming_ips
            ? 'Roaming enabled; host may authenticate from any IP.'
            : 'First caller IP is locked; toggle roaming to permit moves.',
        },
      ];

      rows.push({
        key: 'Users',
        value: Array.isArray(host.users) && host.users.length
          ? `<span class="muted" title="Reported users">${escapeHtml(host.users.map(u => u.username).filter(Boolean).join(', '))}</span>`
          : '—',
        desc: 'Users reported by this host.',
      });

      rows.push({
        key: 'Token usage',
        value: renderTokenUsageValue(host.token_usage),
        desc: '',
        full: true,
      });

      return rows;
    }

    function showHostDetailModal(show) {
      if (!hostDetailModal) return;
      if (show) {
        hostDetailModal.classList.add('show');
      } else {
        hostDetailModal.classList.remove('show');
        activeHostId = null;
        if (hostDetailGrid) hostDetailGrid.innerHTML = '';
        if (hostDetailSummary) hostDetailSummary.innerHTML = '';
        if (hostDetailPills) hostDetailPills.innerHTML = '';
      }
    }

    function closeHostDetail() {
      showHostDetailModal(false);
    }

    function renderHostDetail(host, { keepOpen = false } = {}) {
      if (!host) return;
      activeHostId = host.id;
      if (hostDetailTitle) {
        hostDetailTitle.textContent = host.fqdn || `Host #${host.id}`;
      }
      if (hostDetailPills) {
        const pills = [];
        if (isHostSecure(host) && host.auth_outdated) {
          pills.push('<span class="chip warn">Outdated auth</span>');
        }
        hostDetailPills.innerHTML = pills.join('');
      }
      renderHostSummary(host);
      if (hostDetailGrid) {
        const rows = hostDetailRows(host);
        hostDetailGrid.innerHTML = rows.map(row => `
          <div class="kv-row${row.full ? ' kv-row-full' : ''}">
            <div class="kv-key">${escapeHtml(row.key)}</div>
            <div class="kv-value">${row.value}</div>
            <div class="kv-desc">${row.desc}</div>
          </div>
        `).join('');
      }
      if (hostDetailActions) {
        hostDetailActions.innerHTML = renderHostActionButtons(host);
        bindHostDetailActions(host);
      }
      if (!keepOpen) {
        showHostDetailModal(true);
      }
    }

    function openHostDetail(hostId) {
      const host = currentHosts.find(h => h.id === hostId);
      if (!host) return;
      renderHostDetail(host);
    }

    function paintHosts() {
      if (!Array.isArray(currentHosts)) return;
      const filtered = applyHostFilters(currentHosts);
      const sorted = sortHosts(filtered);
      const hasInsecure = sorted.some(h => !isHostSecure(h));
      const insecureHeader = document.querySelector('th.insecure-col');
      if (insecureHeader) {
        insecureHeader.style.display = hasInsecure ? '' : 'none';
      }
      hostsTbody.innerHTML = '';
      if (!sorted.length) {
        const cols = hasInsecure ? 6 : 5;
        hostsTbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">No hosts match your filters yet.</td></tr>`;
        updateSortIndicators();
        return;
      }
      sorted.forEach(host => {
        const tr = document.createElement('tr');
        const addedAt = host.created_at ?? host.last_refresh ?? host.updated_at ?? null;
        const shouldPruneSoon = (!host.last_refresh || host.last_refresh === '') && (!host.auth_digest || host.auth_digest === '') && (host.api_calls ?? 0) === 0;
        const addedDate = parseTimestamp(addedAt);
        const pruneAt = shouldPruneSoon && addedDate ? new Date(addedDate.getTime() + 30 * 60 * 1000) : null;
        const willPruneAt = pruneAt ? formatUntil(pruneAt.toISOString()) : null;
        const ipIcon = host.allow_roaming_ips ? '🌍' : '🔒';
        const isSecure = isHostSecure(host);
        const securityChip = isSecure
          ? ''
          : `<span class="chip warn" title="Insecure host: cdx will remove auth.json after runs">Insecure</span>`;
        const insecureStateNow = insecureState(host);
        const minutesActive = countdownMinutes(host.insecure_enabled_until);
        const minutesGrace = countdownMinutes(host.insecure_grace_until);
        let insecureLabel = 'Turn On';
        let insecureClasses = 'ghost tiny-btn primary';
        if (!isSecure && insecureStateNow.enabledActive) {
          insecureLabel = `Turn Off (${minutesActive ?? 0} min left)`;
          insecureClasses = 'ghost tiny-btn ok';
        } else if (!isSecure && insecureStateNow.graceActive) {
          const graceText = minutesGrace !== null ? `${minutesGrace} min` : 'grace';
          insecureLabel = `Turn On (${graceText} left)`;
          insecureClasses = 'ghost tiny-btn neutral';
        }
        const health = hostHealth(host);
        if (isHostSecure(host)) {
          tr.classList.add(`status-${health.tone}`);
        }
        tr.classList.add('host-row');
        tr.setAttribute('data-id', host.id);
        tr.tabIndex = 0;
        const authOutdatedChip = isSecure && host.auth_outdated ? '<span class="chip warn">Outdated auth</span>' : '';
        tr.innerHTML = `
          <td data-label="Host">
            <div class="inline-cell" style="flex-direction:column; align-items:flex-start; gap:4px;">
              <strong>${escapeHtml(host.fqdn)}</strong>
              <div class="inline-cell" style="gap:6px; align-items:center; flex-wrap:wrap;">
                <span class="muted" style="font-size:12px;">${shouldPruneSoon && willPruneAt ? `added ${formatRelative(addedAt)} · will be removed in ${willPruneAt}` : `added ${formatRelative(addedAt)}`}</span>
                <span class="chip ${health.tone === 'ok' ? 'ok' : 'warn'}">${health.label}</span>
                ${authOutdatedChip}
                ${securityChip}
              </div>
            </div>
          </td>
          <td data-label="Last Seen">
            <div class="inline-cell" style="flex-direction:column; align-items:flex-start; gap:2px;">
              <span>${formatRelative(host.updated_at)}</span>
              <span class="muted" style="font-size:12px;">auth ${formatRelative(host.last_refresh)}</span>
            </div>
          </td>
          <td data-label="Client">${renderVersionTag(host.client_version, latestVersions.client)}</td>
          <td data-label="Wrapper">${renderVersionTag(host.wrapper_version, latestVersions.wrapper)}</td>
          <td data-label="IP / Mode">
            <div class="inline-cell" style="gap:6px; align-items:center; flex-wrap:wrap;">
              <span>${escapeHtml(host.ip ?? '—')}</span>
              ${host.ip ? `<span class="ip-indicator" title="${host.allow_roaming_ips ? 'Roaming enabled' : 'Locked to first IP'}">${ipIcon}</span>` : ''}
              ${host.force_ipv4 ? '<span class="chip neutral">IPv4 only</span>' : ''}
            </div>
          </td>
          ${hasInsecure ? `<td class="actions-cell insecure-cell" data-label="Insecure API">
            ${isSecure ? '' : `<button class="${insecureClasses} insecure-inline-btn" style="white-space:nowrap;" data-id="${host.id}">${insecureLabel}</button>`}
          </td>` : ''}
        `;
        tr.addEventListener('click', () => openHostDetail(host.id));
        tr.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            openHostDetail(host.id);
          }
        });
        const insecureBtn = tr.querySelector('.insecure-inline-btn');
        if (insecureBtn) {
          insecureBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            const targetId = Number(insecureBtn.getAttribute('data-id'));
            const targetHost = currentHosts.find(h => h.id === targetId);
            if (targetHost) {
              toggleInsecureApi(targetHost, insecureBtn);
            }
          });
        }
        hostsTbody.appendChild(tr);
      });
      updateSortIndicators();
    }

    function renderHosts(hosts) {
      currentHosts = Array.isArray(hosts) ? hosts : [];
      // Populate upload host select
      if (uploadHostSelect) {
        uploadHostSelect.innerHTML = '<option value="system">System (no host attribution)</option>' + currentHosts.map(h => `<option value="${h.id}">${escapeHtml(h.fqdn)}</option>`).join('');
        uploadHostSelect.value = 'system';
      }
      if (hostDetailModal?.classList.contains('show') && activeHostId) {
        const active = currentHosts.find(h => h.id === activeHostId);
        if (active) {
          renderHostDetail(active, { keepOpen: true });
        } else {
          closeHostDetail();
        }
      }
      paintHosts();
    }

    function renderPrompts(prompts) {
      currentPrompts = Array.isArray(prompts) ? prompts : [];
      if (promptsPanel) {
        promptsPanel.style.display = currentPrompts.length > 0 ? 'block' : 'none';
      }
      if (!promptsTbody) return;
      if (currentPrompts.length === 0) {
        promptsTbody.innerHTML = `<tr><td colspan="3" class="muted" style="padding:14px;">No slash commands stored</td></tr>`;
        return;
      }
      promptsTbody.innerHTML = currentPrompts.map((p) => {
        const desc = (p.description || '').replace(/</g, '&lt;');
        const retired = p.deleted_at ? '<span class="muted">(retired)</span>' : '';
        return `<tr>
          <td data-label="Filename"><code>${p.filename}</code> ${retired}</td>
          <td data-label="Description">${desc || '—'}</td>
          <td data-label="Actions">
            <button class="ghost tiny-btn prompt-edit" data-filename="${p.filename}">Edit</button>
            <button class="ghost tiny-btn danger prompt-delete" data-filename="${p.filename}" ${p.deleted_at ? 'disabled' : ''}>Retire</button>
          </td>
        </tr>`;
      }).join('');

      promptsTbody.querySelectorAll('.prompt-edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.getAttribute('data-filename');
          openPromptModal(name);
        });
      });
      promptsTbody.querySelectorAll('.prompt-delete').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.getAttribute('data-filename');
          retirePrompt(name);
        });
      });
    }

    function renderRunnerCard(info) {
      if (!info) return '';
      const baseUrl = info.base_url || 'n/a';
      const validation = info.latest_validation || null;
      const hasValidation = !!validation;
      const validationStatus = hasValidation
        ? (validation.status ?? 'unknown')
        : (info.enabled ? 'No runs yet' : 'Disabled');
      const normalizedStatus = typeof validationStatus === 'string' ? validationStatus.toLowerCase() : '';
      const validationTone = !hasValidation
        ? (info.enabled ? 'neutral' : 'warn')
        : (['ok', 'valid'].includes(normalizedStatus) ? 'ok'
          : normalizedStatus === 'unchanged' ? 'neutral'
          : 'warn');
      const validationWhen = validation?.created_at ? formatMinutesAgo(validation.created_at) : '—';
      const validationLatency = validation?.latency_ms ? `${validation.latency_ms}ms` : null;
      const validationReason = validation?.reason ? validation.reason : null;
      const runnerStore = info.latest_runner_store || null;
      const runnerStoreLabel = runnerStore?.last_refresh ? formatTimestamp(runnerStore.last_refresh) : '—';
      const runnerStoreWhen = runnerStore?.created_at ? formatRelative(runnerStore.created_at) : '—';
      const runnerHost = '';
      const lastRun = hasValidation ? validationWhen : (info.enabled ? 'No runs yet' : '—');
      const statusLabel = (hasValidation ? validationStatus : (info.enabled ? 'VALID' : 'DISABLED')).toString().toUpperCase();
      return `
        <div class="card runner-card">
          <div class="stat-head">
            <span class="stat-label">Validation Service</span>
          </div>
          <div class="stat-value">${statusLabel}</div>
          <small class="muted">Timeout ${info.timeout_seconds ?? '—'}s, Last run ${lastRun}${validationLatency ? ` · ${validationLatency}` : ''}</small>
          <div class="runner-meta" style="margin-top:12px;">
            ${validationReason ? `<div><div class="label">Notes</div><div>${validationReason}</div></div>` : ''}
          </div>
        </div>
      `;
    }

    function renderUsageWindow(label, data, windowKey = null) {
      const used = Number.isFinite(data?.used_percent) ? Math.min(100, Math.max(0, data.used_percent)) : null;
      const limitLabel = Number.isFinite(data?.limit_seconds) ? formatDurationSeconds(data.limit_seconds) : '';
      const resetLabel = formatResetLabel(data?.reset_after_seconds ?? null, data?.reset_at ?? null);
      const timePercent = Number.isFinite(data?.limit_seconds) && Number.isFinite(data?.reset_after_seconds)
        ? Math.min(100, Math.max(0, Math.round(((data.limit_seconds - data.reset_after_seconds) / data.limit_seconds) * 100)))
        : null;
      const tone = (() => {
        if (used === null || timePercent === null) return 'neutral';
        const ahead = used <= timePercent;
        if (ahead && (timePercent - used) >= 15) return 'ok';
        if (ahead) return 'warn';
        return 'critical';
      })();
      const chartBtn = windowKey
        ? `<button class="ghost tiny-btn usage-history-btn" data-window="${windowKey}" title="Show last 60 days">📊</button>`
        : '';
      const meter = `<div class="meter ${tone}"><span style="width:${used !== null ? used : 0}%"></span></div>`;
      const timeMeter = timePercent !== null
        ? `<div class="meter time"><span style="width:${timePercent}%"></span></div>`
        : '';
      return `
        <div class="usage-bar">
          <div class="label">
            <span>${label}</span>
            ${chartBtn}
          </div>
          <div class="value">
            <span>${used !== null ? `${used}% used` : 'n/a'}</span>
            <small>${limitLabel}</small>
          </div>
          ${meter}
          ${timeMeter}
          <small>${resetLabel}</small>
        </div>
      `;
    }

    function renderChatGptUsage(usage) {
      if (!chatgptUsageCard) return;
      if (!usage || !usage.snapshot) {
        chatgptUsageCard.innerHTML = '<div class="muted">ChatGPT usage not available yet.</div>';
        return;
      }

      const snapshot = usage.snapshot;
      const status = snapshot.status || 'unknown';
      const plan = snapshot.plan_type || 'Unknown plan';
      const fetched = snapshot.fetched_at ? formatRelative(snapshot.fetched_at) : 'never';
      const next = usage.next_eligible_at ? formatRelative(usage.next_eligible_at) : null;
      const primary = {
        used_percent: snapshot.primary_used_percent ?? null,
        limit_seconds: snapshot.primary_limit_seconds ?? null,
        reset_after_seconds: snapshot.primary_reset_after_seconds ?? null,
        reset_at: snapshot.primary_reset_at ?? null,
      };
      const secondary = {
        used_percent: snapshot.secondary_used_percent ?? null,
        limit_seconds: snapshot.secondary_limit_seconds ?? null,
        reset_after_seconds: snapshot.secondary_reset_after_seconds ?? null,
        reset_at: snapshot.secondary_reset_at ?? null,
      };
      const daily = (lastOverview?.tokens_day) || { input: 0, output: 0, cached: 0, total: 0 };
      const weekly = (lastOverview?.tokens_week) || { input: 0, output: 0, cached: 0, total: 0 };
      const monthly = (lastOverview?.tokens_month) || { input: 0, output: 0, cached: 0, total: 0 };
      const pricing = lastOverview?.pricing || { currency: 'EUR', input_price_per_1k: 0, output_price_per_1k: 0, cached_price_per_1k: 0 };
      const dayCost = lastOverview?.pricing_day_cost ?? null;
      const monthCost = lastOverview?.pricing_month_cost ?? null;
      const weekCost = lastOverview?.pricing_week_cost ?? null;
      const currency = pricing.currency || 'EUR';
      const isPro = typeof plan === 'string' && plan.toLowerCase().includes('pro');
      const planLabel = plan;
      const hasPricing = (pricing.input_price_per_1k ?? 0) > 0 || (pricing.output_price_per_1k ?? 0) > 0 || (pricing.cached_price_per_1k ?? 0) > 0;
      const computeCost = (usage) => {
        if (!hasPricing || !usage) return null;
        const toNum = (value) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : 0;
        };
        return ((toNum(usage.input) / 1000) * (pricing.input_price_per_1k ?? 0))
          + ((toNum(usage.output) / 1000) * (pricing.output_price_per_1k ?? 0))
          + ((toNum(usage.cached) / 1000) * (pricing.cached_price_per_1k ?? 0));
      };
      const inputCost = hasPricing ? (monthly.input / 1000) * (pricing.input_price_per_1k ?? 0) : null;
      const outputCost = hasPricing ? (monthly.output / 1000) * (pricing.output_price_per_1k ?? 0) : null;
      const cachedCost = hasPricing ? (monthly.cached / 1000) * (pricing.cached_price_per_1k ?? 0) : null;
      const dayCostResolved = hasPricing ? (dayCost ?? computeCost(daily)) : null;
      const weekCostResolved = hasPricing ? (weekCost ?? computeCost(weekly)) : null;
      const monthCostResolved = hasPricing ? (monthCost ?? computeCost(monthly)) : null;
      const formatCostValue = (value) => hasPricing && Number.isFinite(value) ? formatMoney(value, currency) : (hasPricing ? formatMoney(0, currency) : 'pricing missing');
      const monthlyTotalTokens = Number.isFinite(monthly.total)
        ? monthly.total
        : ((Number.isFinite(monthly.input) ? monthly.input : 0) + (Number.isFinite(monthly.output) ? monthly.output : 0) + (Number.isFinite(monthly.cached) ? monthly.cached : 0));
      const costBreakdown = hasPricing ? [
        dayCostResolved !== null ? { label: 'Today', value: dayCostResolved } : null,
        weekCostResolved !== null ? { label: 'Week', value: weekCostResolved } : null,
        monthCostResolved !== null ? { label: 'Month', value: monthCostResolved } : null,
      ].filter(Boolean) : [];
      const primaryCost = hasPricing
        ? (monthCostResolved !== null ? { label: 'Month', value: monthCostResolved }
          : weekCostResolved !== null ? { label: 'Week', value: weekCostResolved }
          : dayCostResolved !== null ? { label: 'Today', value: dayCostResolved }
            : null)
        : null;
      const costSummary = (() => {
        if (!hasPricing) return '<div class="muted">Pricing missing</div>';
        if (!costBreakdown.length) return '<div class="muted">No usage yet</div>';
        return costBreakdown.map((item) => `
          <div class="cost-chip">
            <span>${item.label}</span>
            <strong>${formatCostValue(item.value)}</strong>
          </div>
        `).join('');
      })();
      const renderCostCard = (title, tokens, cost, unitPrice) => `
        <div class="cost-card">
          <div class="label">${title}</div>
          <div class="value">${hasPricing ? formatMoney(cost ?? 0, currency) : 'pricing missing'}</div>
          <div class="stat-line">${formatNumber(tokens)} tokens</div>
          <small>${unitPrice}</small>
        </div>
      `;
      const totalCard = `
        <div class="cost-card total">
          <div class="total-head">
            <div class="total-kicker">Estimated Total</div>
            <button class="total-icon-btn cost-history-btn" type="button" title="Open cost trend" aria-label="Open cost trend">
              <span class="total-icon" aria-hidden="true">📈</span>
            </button>
          </div>
          <div class="total-main">
            <div class="total-amount">${primaryCost ? formatCostValue(primaryCost.value) : (hasPricing ? formatMoney(0, currency) : 'Pricing missing')}</div>
            <span class="total-sub">${primaryCost ? `${primaryCost.label} to date` : (hasPricing ? 'No usage yet' : 'Pricing missing')}</span>
          </div>
          <div class="stat-line strong">${formatNumber(monthlyTotalTokens)} tokens</div>
          <div class="total-breakdown">
            ${costSummary}
          </div>
          ${hasPricing ? '' : '<small class="muted">Set PRICING_URL or GPT51_* env vars.</small>'}
        </div>
      `;

      chatgptUsageCard.innerHTML = `
        <div class="usage-head">
          <div>
            <div class="stat-label">ChatGPT Account</div>
            <div class="usage-plan ${isPro ? 'pro-plan' : ''}">${planLabel} ${isPro ? '🎉' : ''}</div>
            <div class="usage-meta">
              <span>Last check ${fetched}</span>
              ${next ? `<span>Next ${next}</span>` : ''}
              ${snapshot.rate_limit_reached ? '<span class="chip warn">Limit reached</span>' : ''}
            </div>
          </div>
          <div class="usage-actions">
            <button class="ghost tiny-btn" id="chatgpt-refresh">Refresh</button>
          </div>
        </div>
        ${status !== 'ok' ? `<div class="usage-error">Usage unavailable: ${snapshot.error ?? 'Unknown error'}</div>` : ''}
        <div class="usage-bars">
          ${renderUsageWindow('5-hour limit', primary, 'primary')}
          ${renderUsageWindow('Weekly limit', secondary, 'secondary')}
        </div>
        <div class="usage-credits">
          <strong>Month to date (${currency})</strong>
          <div class="cost-grid">
            ${renderCostCard('Input', monthly.input, inputCost, hasPricing ? `${formatMoney(pricing.input_price_per_1k ?? 0, currency)}/1k` : 'pricing missing')}
            ${renderCostCard('Output', monthly.output, outputCost, hasPricing ? `${formatMoney(pricing.output_price_per_1k ?? 0, currency)}/1k` : 'pricing missing')}
            ${renderCostCard('Cached', monthly.cached, cachedCost, hasPricing ? `${formatMoney(pricing.cached_price_per_1k ?? 0, currency)}/1k` : 'pricing missing')}
            ${totalCard}
          </div>
        </div>
      `;

      wireChatGptControls();
    }

    async function refreshChatGptUsage() {
      const btn = document.getElementById('chatgpt-refresh');
      const original = btn ? btn.textContent : '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
      }
      try {
        const res = await api('/admin/chatgpt/usage/refresh', { method: 'POST' });
        chatgptUsage = res?.data || null;
        chatgptUsageHistory = null;
        chatgptUsageHistoryPromise = null;
        renderChatGptUsage(chatgptUsage);
      } catch (err) {
        alert(`Refresh failed: ${err.message}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = original || 'Refresh';
        }
      }
    }

    function wireChatGptControls() {
      const btn = document.getElementById('chatgpt-refresh');
      if (btn) {
        btn.onclick = (ev) => {
          ev.preventDefault();
          refreshChatGptUsage();
        };
      }
      document.querySelectorAll('.usage-history-btn').forEach((el) => {
        el.onclick = (ev) => {
          ev.preventDefault();
          const key = el.getAttribute('data-window') === 'secondary' ? 'secondary' : 'primary';
          openUsageHistory(key);
        };
      });
      document.querySelectorAll('.cost-history-btn').forEach((el) => {
        el.onclick = (ev) => {
          ev.preventDefault();
          openCostHistory();
        };
      });
    }

    function showUsageHistoryModal(show) {
      if (!usageHistoryModal) return;
      if (show) {
        usageHistoryModal.classList.add('show');
      } else {
        usageHistoryModal.classList.remove('show');
      }
    }

    function parseDateOnly(value) {
      if (!value) return null;
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatShortDate(date, includeTime = false) {
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
      const dateText = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      if (!includeTime) return dateText;
      const timeText = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      return `${dateText} ${timeText} UTC`;
    }

    function buildUsageSeries(points, windowKey) {
      const key = windowKey === 'secondary' ? 'secondary_used_percent' : 'primary_used_percent';
      const series = [];
      (points || []).forEach((p) => {
        const ts = parseTimestamp(p?.fetched_at);
        const val = Number(p?.[key]);
        if (!ts || Number.isNaN(val)) return;
        const clamped = Math.max(0, Math.min(130, val));
        series.push({ x: ts.getTime(), y: clamped, raw: val, iso: p.fetched_at });
      });
      series.sort((a, b) => a.x - b.x);
      return series;
    }

    function renderUsageHistoryChart(series, windowKey) {
      if (!usageHistoryChart) return;
      if (!Array.isArray(series) || series.length === 0) {
        usageHistoryChart.innerHTML = '<div class="muted">No quota history yet.</div>';
        return;
      }

      const width = 800;
      const height = 260;
      const minX = series[0].x;
      const maxX = series[series.length - 1].x;
      const spanX = Math.max(1, maxX - minX);
      const maxY = Math.max(100, Math.max(...series.map((s) => s.y)));

      const coords = series.map((pt) => {
        const x = ((pt.x - minX) / spanX) * width;
        const y = height - ((pt.y / maxY) * height);
        return { x, y };
      });
      const path = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
      const firstX = coords[0]?.x ?? 0;
      const lastX = coords[coords.length - 1]?.x ?? width;
      const areaPath = path
        ? `${path} L ${lastX.toFixed(2)},${height} L ${firstX.toFixed(2)},${height} Z`
        : '';

      const latest = coords[coords.length - 1];
      const gridLines = [0, 25, 50, 75, 100].map((pct) => {
        const y = height - ((Math.min(pct, maxY) / maxY) * height);
        return `<g class="grid-row"><line x1="0" y1="${y.toFixed(2)}" x2="${width}" y2="${y.toFixed(2)}"></line><text x="${width}" y="${(y - 4).toFixed(2)}" text-anchor="end" class="tick">${pct}%</text></g>`;
      }).join('');

      usageHistoryChart.innerHTML = `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${windowKey === 'secondary' ? 'Weekly quota history' : '5-hour quota history'}">
          <g class="grid">${gridLines}</g>
          ${areaPath ? `<path d="${areaPath}" class="area"></path>` : ''}
          ${path ? `<path d="${path}" class="line"></path>` : ''}
          ${latest ? `<circle cx="${latest.x.toFixed(2)}" cy="${latest.y.toFixed(2)}" r="4" class="dot"></circle>` : ''}
        </svg>
      `;
    }

    async function loadUsageHistory(force = false) {
      if (!force && chatgptUsageHistory) return chatgptUsageHistory;
      if (!force && chatgptUsageHistoryPromise) return chatgptUsageHistoryPromise;
      const url = `/admin/chatgpt/usage/history?days=${USAGE_HISTORY_DAYS}`;
      chatgptUsageHistoryPromise = api(url).then((res) => {
        const data = res?.data || {};
        const result = {
          points: Array.isArray(data.points) ? data.points : [],
          days: data.days ?? USAGE_HISTORY_DAYS,
          since: data.since || null,
        };
        chatgptUsageHistory = result;
        return result;
      }).finally(() => {
        chatgptUsageHistoryPromise = null;
      });
      return chatgptUsageHistoryPromise;
    }

    async function openUsageHistory(windowKey = 'primary') {
      if (!usageHistoryModal) return;
      const label = windowKey === 'secondary' ? 'Weekly quota' : '5-hour quota';
      if (usageHistorySubtitle) {
        usageHistorySubtitle.textContent = `${label} · loading…`;
      }
      if (usageHistoryMeta) usageHistoryMeta.textContent = '';
      if (usageHistoryChart) {
        usageHistoryChart.innerHTML = '<div class="muted">Loading…</div>';
      }
      showUsageHistoryModal(true);
      try {
        const history = await loadUsageHistory();
        const series = buildUsageSeries(history.points, windowKey);
        if (series.length === 0) {
          if (usageHistorySubtitle) {
            usageHistorySubtitle.textContent = `${label} · no history yet`;
          }
          if (usageHistoryChart) {
            usageHistoryChart.innerHTML = '<div class="muted">No recorded quota data.</div>';
          }
          return;
        }

        renderUsageHistoryChart(series, windowKey);
        const start = new Date(series[0].x);
        const end = new Date(series[series.length - 1].x);
        const latest = series[series.length - 1];
        const latestLabel = `${Math.round(latest.raw ?? latest.y)}% on ${formatShortDate(new Date(latest.x), true)}`;
        if (usageHistorySubtitle) {
          usageHistorySubtitle.textContent = `${label} · last ${history.days ?? USAGE_HISTORY_DAYS} days`;
        }
        if (usageHistoryMeta) {
          usageHistoryMeta.textContent = `Showing ${series.length} points from ${formatShortDate(start)} to ${formatShortDate(end)}. Latest: ${latestLabel}.`;
        }
      } catch (err) {
        if (usageHistorySubtitle) {
          usageHistorySubtitle.textContent = `${label} · error`;
        }
        if (usageHistoryChart) {
          usageHistoryChart.innerHTML = `<div class="error">Unable to load history: ${escapeHtml(err.message)}</div>`;
        }
      }
    }

    function showCostHistoryModal(show) {
      if (!costHistoryModal) return;
      if (show) {
        costHistoryModal.classList.add('show');
      } else {
        costHistoryModal.classList.remove('show');
      }
    }

    function buildCostTicks(maxValue) {
      if (!Number.isFinite(maxValue) || maxValue <= 0) {
        return [0, 0.25, 0.5, 0.75, 1];
      }
      const rawStep = maxValue / 4;
      const exponent = Math.floor(Math.log10(rawStep || 1));
      const magnitude = 10 ** exponent;
      const candidates = [1, 2, 2.5, 5, 10];
      let step = candidates.find((candidate) => (rawStep / magnitude) <= candidate) ?? 10;
      step *= magnitude;
      if (step <= 0) {
        step = maxValue || 1;
      }

      const ticks = [];
      for (let v = 0; v <= maxValue + step; v += step) {
        ticks.push(Number(v.toFixed(6)));
        if (ticks.length > 14) break;
      }
      if (ticks.length && ticks[0] !== 0) {
        ticks.unshift(0);
      }
      return ticks;
    }

    function buildCostSeries(history) {
      const series = COST_SERIES.map((item) => ({ ...item, values: [] }));
      const points = Array.isArray(history?.points) ? history.points : [];
      points.forEach((pt) => {
        const date = parseDateOnly(pt?.date);
        if (!date) return;
        series.forEach((seriesItem) => {
          const raw = Number(pt?.costs?.[seriesItem.key] ?? 0);
          if (!Number.isFinite(raw)) return;
          seriesItem.values.push({ x: date.getTime(), y: Math.max(0, raw), date: pt.date });
        });
      });
      series.forEach((s) => s.values.sort((a, b) => a.x - b.x));
      return series;
    }

    function renderCostHistoryChart(history) {
      if (!costHistoryChart) return;
      const series = buildCostSeries(history);
      const allPoints = series.flatMap((s) => s.values);
      if (allPoints.length === 0) {
        costHistoryChart.innerHTML = '<div class="muted">No cost history yet.</div>';
        return;
      }

      const width = 800;
      const height = 260;
      const minX = Math.min(...allPoints.map((p) => p.x));
      const maxX = Math.max(...allPoints.map((p) => p.x));
      const spanX = Math.max(1, maxX - minX || 1);
      const maxY = Math.max(...allPoints.map((p) => p.y), 0);
      const ticks = buildCostTicks(maxY);
      const yMax = Math.max(maxY, ticks[ticks.length - 1] ?? 0.01);

      const gridLines = ticks.map((tick) => {
        const y = height - ((tick / yMax) * height);
        return `<g class="grid-row"><line x1="0" y1="${y.toFixed(2)}" x2="${width}" y2="${y.toFixed(2)}"></line><text x="${width}" y="${(y - 4).toFixed(2)}" text-anchor="end" class="tick">${formatMoney(tick, history?.currency || 'USD')}</text></g>`;
      }).join('');

      const paths = series.map((s) => {
        if (!s.values.length) return '';
        const coords = s.values.map((pt) => {
          const x = ((pt.x - minX) / spanX) * width;
          const y = height - ((pt.y / yMax) * height);
          return { x, y };
        });
        const path = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'}${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ');
        const latest = coords[coords.length - 1];
        return `${path ? `<path d="${path}" class="line line-${s.key}"></path>` : ''}${latest ? `<circle cx="${latest.x.toFixed(2)}" cy="${latest.y.toFixed(2)}" r="4" class="dot dot-${s.key}"></circle>` : ''}`;
      }).join('');

      const legend = series.map((s) => {
        const latest = s.values[s.values.length - 1];
        const value = latest ? latest.y : 0;
        const color = s.color || '#0f172a';
        return `<span class="legend-item"><span class="swatch" style="background:${color};"></span>${s.label}<strong>${formatMoney(value, history?.currency || 'USD')}</strong></span>`;
      }).join('');

      costHistoryChart.innerHTML = `
        <div class="legend">${legend}</div>
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Cost history over time">
          <g class="grid">${gridLines}</g>
          ${paths}
        </svg>
      `;
    }

    async function loadCostHistory(force = false) {
      if (!force && costHistory) return costHistory;
      if (!force && costHistoryPromise) return costHistoryPromise;
      const url = `/admin/usage/cost-history?days=${USAGE_HISTORY_DAYS}`;
      costHistoryPromise = api(url).then((res) => {
        const data = res?.data || {};
        const rawPoints = Array.isArray(data.points) ? data.points : [];
        const normalizeNumber = (value) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : 0;
        };
        const points = rawPoints.map((pt) => {
          const date = typeof pt?.date === 'string' ? pt.date : null;
          if (!date) return null;
          return {
            date,
            costs: {
              input: normalizeNumber(pt?.costs?.input),
              output: normalizeNumber(pt?.costs?.output),
              cached: normalizeNumber(pt?.costs?.cached),
              total: normalizeNumber(pt?.costs?.total),
            },
            tokens: {
              input: normalizeNumber(pt?.tokens?.input),
              output: normalizeNumber(pt?.tokens?.output),
              cached: normalizeNumber(pt?.tokens?.cached),
              total: normalizeNumber(pt?.tokens?.total),
            },
          };
        }).filter(Boolean);

        const result = {
          points,
          currency: data.currency || 'USD',
          has_pricing: data.has_pricing ?? false,
          pricing: data.pricing || {},
          since: data.since || null,
          until: data.until || null,
          days: data.days ?? USAGE_HISTORY_DAYS,
        };
        costHistory = result;
        return result;
      }).finally(() => {
        costHistoryPromise = null;
      });
      return costHistoryPromise;
    }

    async function openCostHistory() {
      if (!costHistoryModal) return;
      if (costHistorySubtitle) {
        costHistorySubtitle.textContent = 'Loading cost history…';
      }
      if (costHistoryChart) {
        costHistoryChart.innerHTML = '<div class="muted">Loading…</div>';
      }
      if (costHistoryMeta) {
        costHistoryMeta.textContent = '';
      }
      showCostHistoryModal(true);
      try {
        const history = await loadCostHistory();
        const points = Array.isArray(history?.points) ? history.points : [];
        const startDate = parseTimestamp(history?.since) || parseDateOnly(points[0]?.date);
        const endDate = parseTimestamp(history?.until) || parseDateOnly(points[points.length - 1]?.date);
        const latestTotal = Number(points[points.length - 1]?.costs?.total ?? 0);
        if (points.length === 0) {
          if (costHistorySubtitle) {
            costHistorySubtitle.textContent = 'No cost data yet';
          }
          if (costHistoryChart) {
            costHistoryChart.innerHTML = '<div class="muted">No token usage has been recorded yet.</div>';
          }
          return;
        }

        renderCostHistoryChart(history);
        if (costHistorySubtitle) {
          costHistorySubtitle.textContent = `Last ${history?.days ?? USAGE_HISTORY_DAYS} days`;
        }
        if (costHistoryMeta) {
          const latestLabel = formatMoney(latestTotal, history?.currency || 'USD');
          const pricingNote = history?.has_pricing ? '' : ' Pricing missing — costs shown as zero.';
          costHistoryMeta.textContent = `Showing ${points.length} days from ${formatShortDate(startDate || new Date())} to ${formatShortDate(endDate || new Date())}. Latest total: ${latestLabel}.${pricingNote}`;
        }
      } catch (err) {
        if (costHistorySubtitle) {
          costHistorySubtitle.textContent = 'Error loading costs';
        }
        if (costHistoryChart) {
          costHistoryChart.innerHTML = `<div class="error">Unable to load cost history: ${escapeHtml(err.message)}</div>`;
        }
      }
    }

    function renderQuotaMode() {
      if (!quotaToggle || !quotaModeLabel) return;
      quotaToggle.checked = !!quotaHardFail;
      quotaModeLabel.textContent = quotaHardFail ? 'Deny launches' : 'Warn only';
      const quotaPanel = document.getElementById('quota-panel');
      if (quotaPanel) {
        const desc = quotaPanel.querySelector('.quota-desc');
        if (desc) {
          desc.textContent = quotaHardFail
            ? 'ChatGPT quota hit: deny Codex launch.'
            : 'ChatGPT quota hit: warn and continue.';
        }
      }
    }

    function showSeedModal(show) {
      if (!seedModal) return;
      if (show) {
        seedModal.classList.add('show');
      } else {
        seedModal.classList.remove('show');
      }
    }

    function setSeedStatus(hasHosts, hasAuth, reasons = []) {
      if (seedHostsStatus) {
        seedHostsStatus.textContent = hasHosts ? 'Hosts detected' : 'No hosts registered';
        seedHostsStatus.classList.toggle('ok', hasHosts);
        seedHostsStatus.classList.toggle('warn', !hasHosts);
      }
      if (seedAuthStatus) {
        seedAuthStatus.textContent = hasAuth ? 'Canonical auth.json present' : 'Canonical auth.json missing';
        seedAuthStatus.classList.toggle('ok', hasAuth);
        seedAuthStatus.classList.toggle('warn', !hasAuth);
      }
      if (seedModalCopy) {
        const missing = [];
        if (!hasAuth) missing.push('canonical auth.json is missing');
        seedModalCopy.textContent = missing.length
          ? `Setup incomplete: ${missing.join(' · ')}. Seed auth.json before issuing installers.`
          : 'Setup already initialized.';
      }
    }

    function evaluateSeedRequirement(overviewData, hostsList) {
      const hasHosts = Array.isArray(hostsList) && hostsList.length > 0;
      const hasAuth = !!(overviewData && overviewData.has_canonical_auth);
      const reasons = Array.isArray(overviewData?.seed_reasons) ? overviewData.seed_reasons : [];
      const required = (overviewData && overviewData.seed_required === true)
        || !hasAuth;

      setSeedStatus(hasHosts, hasAuth, reasons);
      showSeedModal(required);
    }

    function renderStats(data, runnerInfo = null) {
      lastOverview = data;
      const checkedAt = formatRelative(data.versions.client_version_checked_at);
      const latestLog = formatRelative(data.latest_log_at);
      const lastRefresh = data.last_refresh ? formatRelative(data.last_refresh) : 'n/a';
      const avgRefresh = data.avg_refresh_age_days !== null ? data.avg_refresh_age_days.toFixed(2) + ' d' : 'n/a';
      latestVersions = {
        client: typeof data.versions.client_version === 'string'
          ? data.versions.client_version.trim().replace(/^v/i, '')
          : null,
        wrapper: typeof data.versions.wrapper_version === 'string'
          ? data.versions.wrapper_version.trim().replace(/^v/i, '')
          : null,
      };
      tokensSummary = data.tokens || null;
      const codexVersion = typeof data.versions.client_version === 'string'
        ? data.versions.client_version.trim()
        : null;
      const codexVersionDisplay = codexVersion && codexVersion !== '' ? codexVersion : 'n/a';
      const versionInfoBtn = '';
      const topHost = tokensSummary?.top_host;
      const topHostLabel = topHost ? `${topHost.fqdn} (${formatNumber(topHost.total)} tokens)` : '—';
      const totalTokens = tokensSummary ? formatNumber(tokensSummary.total) : '—';

      runnerSummary = runnerInfo;
      const cards = [
        `
          <div class="card">
            <div class="stat-head">
              <span class="stat-label">Hosts</span>
            </div>
            <div class="stat-value">${data.totals.hosts}</div>
            <small>Total registered · Avg refresh ${avgRefresh} · Last refresh ${lastRefresh}</small>
          </div>
        `,
        `
          <div class="card version-card">
            <div class="stat-head">
              <span class="stat-label">Versions</span>
            </div>
            <div class="stat-value upgrade-trigger ${codexVersion ? 'clickable' : ''}" ${codexVersion ? `data-version="${codexVersion}"` : ''}>CLI ${codexVersionDisplay}</div>
            <small>Checked ${checkedAt} · Wrapper ${data.versions.wrapper_version ?? 'n/a'}</small>
          </div>
        `,
        `
          <div class="card">
            <div class="stat-head">
              <span class="stat-label">Tokens</span>
            </div>
            <div class="stat-value">${totalTokens}</div>
            <small>Usage · Total tokens reported</small>
          </div>
        `,
      ];

      if (runnerInfo) {
        cards.push(renderRunnerCard(runnerInfo));
      }

      statsEl.innerHTML = cards.join('\n');
      wireRunnerCardControls();
      wireUpgradeNotesControls();

      chatgptUsage = {
        snapshot: data.chatgpt_usage || null,
        cached: data.chatgpt_cached || false,
        next_eligible_at: data.chatgpt_next_eligible_at || null,
      };
      renderChatGptUsage(chatgptUsage);
    }

    function wireRunnerCardControls() {
      const btn = document.getElementById('runner-toggle');
      if (btn) {
        btn.onclick = (ev) => {
          ev.preventDefault();
          handleRunnerClick();
        };
      }
    }

    function wireUpgradeNotesControls() {
      document.querySelectorAll('.upgrade-trigger[data-version]').forEach((el) => {
        el.onclick = (ev) => {
          ev.preventDefault();
          const version = el.getAttribute('data-version') || (lastOverview?.versions?.client_version ?? '');
          openUpgradeNotes(version);
        };
      });
    }

    function showUpgradeNotesModal(show) {
      if (!upgradeModal) return;
      if (show) {
        upgradeModal.classList.add('show');
      } else {
        upgradeModal.classList.remove('show');
      }
    }

    function setUpgradeNotes(text, isError = false) {
      if (!upgradeNotesEl) return;
      upgradeNotesEl.textContent = text;
      upgradeNotesEl.classList.toggle('error', !!isError);
    }

    async function openUpgradeNotes(version) {
      if (!upgradeModal) return;
      const cleanVersion = typeof version === 'string' ? version.trim().replace(/^v/i, '') : '';
      if (upgradeVersionEl) {
        upgradeVersionEl.textContent = cleanVersion ? `Codex v${cleanVersion}` : 'Codex version unavailable';
      }
      if (upgradeGithubLink) {
        const link = cleanVersion
          ? `https://github.com/openai/codex/releases/tag/rust-v${cleanVersion}`
          : 'https://github.com/openai/codex/releases';
        upgradeGithubLink.onclick = () => {
          window.open(link, '_blank', 'noopener,noreferrer');
        };
      }
      showUpgradeNotesModal(true);
      if (!cleanVersion) {
        setUpgradeNotes('No Codex version detected yet.', true);
        return;
      }
      const cached = upgradeNotesCache[cleanVersion];
      if (cached) {
        setUpgradeNotes(cached.text, cached.isError);
        return;
      }
      setUpgradeNotes('Loading upgrade notes…');
      try {
        const resp = await fetch(`https://api.github.com/repos/openai/codex/releases/tags/rust-v${cleanVersion}`, {
          headers: { 'Accept': 'application/vnd.github+json' },
        });
        if (!resp.ok) {
          throw new Error(`GitHub ${resp.status}`);
        }
        const json = await resp.json();
        const notes = typeof json.body === 'string' && json.body.trim() !== ''
          ? json.body.trim()
          : 'No release notes published for this version.';
        upgradeNotesCache[cleanVersion] = { text: notes, isError: false };
        setUpgradeNotes(notes);
      } catch (err) {
        const message = `Unable to load notes: ${err.message}`;
        upgradeNotesCache[cleanVersion] = { text: message, isError: true };
        setUpgradeNotes(message, true);
      }
    }

    async function loadAll() {
      try {
        const [overview, hosts, runner, prompts] = await Promise.all([
          api('/admin/overview'),
          api('/admin/hosts'),
          api('/admin/runner').catch(err => {
            console.warn('Runner status unavailable', err);
            return null;
          }),
          api('/admin/slash-commands').catch(err => {
            console.warn('Slash commands unavailable', err);
            return null;
          }),
        ]);
        setMtls(overview.data.mtls);
        renderStats(overview.data, runner?.data || null);
        renderHosts(hosts.data.hosts);
        renderPrompts(prompts?.data?.commands || []);
        if (typeof overview.data.quota_hard_fail !== 'undefined') {
          quotaHardFail = !!overview.data.quota_hard_fail;
          renderQuotaMode();
        }
        evaluateSeedRequirement(overview.data, hosts.data.hosts);
      } catch (err) {
        mtlsEl.textContent = 'mTLS / Admin access failed';
        mtlsEl.classList.add('error');
        statsEl.innerHTML = `<div class="card"><div class="error">Error: ${err.message}</div></div>`;
      }
    }

    async function runVersionCheck() {
      if (!versionCheckBtn) return;
      const original = versionCheckBtn.textContent;
      versionCheckBtn.disabled = true;
      versionCheckBtn.textContent = 'Checking…';
      try {
        await api('/admin/versions/check', { method: 'POST' });
        await loadAll();
      } catch (err) {
        alert(`Version check failed: ${err.message}`);
      } finally {
        versionCheckBtn.disabled = false;
        versionCheckBtn.textContent = original;
      }
    }

    async function runRunnerNow(logFn = null) {
      try {
        if (logFn) logFn('Invoking auth runner…');
        const res = await api('/admin/runner/run', { method: 'POST' });
        if (logFn) logFn(`Runner completed (applied=${res?.data?.applied ? 'yes' : 'no'})`, res?.data?.applied ? 'ok' : null);
        await loadAll();
        return res?.data ?? null;
      } catch (err) {
        if (logFn) logFn(`Runner failed: ${err.message}`, 'err');
        else alert(`Runner failed: ${err.message}`);
        throw err;
      }
    }

    function showRunnerModal(show) {
      if (!runnerModal) return;
      if (show) {
        runnerModal.classList.add('show');
        resetRunnerLog();
        setRunnerMeta(runnerSummary, null);
      } else {
        runnerModal.classList.remove('show');
      }
    }

    function showPromptModal(show) {
      if (!promptModal) return;
      if (show) {
        promptModal.classList.add('show');
      } else {
        promptModal.classList.remove('show');
        if (promptStatus) promptStatus.textContent = '';
      }
    }

    async function openPromptModal(filename) {
      if (!promptFilename || !promptDescription || !promptBody) return;
      promptFilename.value = filename || '';
      promptDescription.value = '';
      promptArgument.value = '';
      promptBody.value = '';
      if (promptStatus) promptStatus.textContent = 'Loading…';
      showPromptModal(true);
      try {
        const resp = await api(`/admin/slash-commands/${encodeURIComponent(filename)}`);
        const data = resp?.data || {};
        promptFilename.value = data.filename || filename || '';
        promptDescription.value = data.description || '';
        promptArgument.value = data.argument_hint || '';
        promptBody.value = data.prompt || '';
        if (promptStatus) promptStatus.textContent = '';
      } catch (err) {
        if (promptStatus) promptStatus.textContent = `Load failed: ${err.message}`;
      }
    }

    async function retirePrompt(filename) {
      if (!filename) return;
      if (!confirm(`Retire slash command "${filename}"? This removes it from hosts on next sync.`)) {
        return;
      }
      try {
        await api(`/admin/slash-commands/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        await loadAll();
      } catch (err) {
        alert(`Retire failed: ${err.message}`);
      }
    }

    async function savePrompt() {
      if (!promptFilename || !promptBody) return;
      const payload = {
        filename: promptFilename.value.trim(),
        description: promptDescription?.value ?? '',
        argument_hint: promptArgument?.value ?? '',
        prompt: promptBody.value,
      };
      if (!payload.filename) {
        if (promptStatus) promptStatus.textContent = 'Filename is required';
        return;
      }
      if (!payload.prompt.trim()) {
        if (promptStatus) promptStatus.textContent = 'Prompt is required';
        return;
      }
      if (promptStatus) promptStatus.textContent = 'Saving…';
      try {
        await api('/admin/slash-commands/store', {
          method: 'POST',
          json: payload,
        });
        if (promptStatus) promptStatus.textContent = 'Saved';
        await loadAll();
        showPromptModal(false);
      } catch (err) {
        if (promptStatus) promptStatus.textContent = `Save failed: ${err.message}`;
      }
    }

    function resetRunnerLog() {
      if (runnerLogEl) runnerLogEl.innerHTML = '';
    }

    function appendRunnerLog(message, tone = null) {
      if (!runnerLogEl) return;
      const line = document.createElement('div');
      line.className = 'line' + (tone ? ` ${tone}` : '');
      const ts = new Date().toLocaleTimeString();
      line.textContent = `${ts} · ${message}`;
      runnerLogEl.appendChild(line);
      runnerLogEl.scrollTop = runnerLogEl.scrollHeight;
    }

    function setRunnerMeta(info, runResult) {
      if (!runnerMetaEl) return;
      const validation = info?.latest_validation || null;
      const runnerStore = info?.latest_runner_store || null;
      const applied = runResult?.applied === true;
      const digest = runResult?.canonical_digest
        || validation?.digest
        || runnerStore?.digest
        || '—';
      const lastRefresh = runResult?.canonical_last_refresh
        || runnerStore?.last_refresh
        || validation?.last_refresh
        || '—';
      const lastCheck = runResult?.runner_last_check
        || info?.last_daily_check
        || '—';
      const lastFailure = runResult?.runner_last_fail
        || info?.last_failure
        || '';
      const lastOk = runResult?.runner_last_ok
        || info?.last_ok
        || '';
      const validationStatus = validation?.status ?? (info?.enabled ? '—' : 'disabled');
      const state = runResult?.runner_state
        || info?.state
        || validationStatus;
      const bootId = runResult?.runner_boot_id
        || info?.boot_id
        || '';
      const latency = validation?.latency_ms ? `${validation.latency_ms}ms` : '';
      const reason = validation?.reason || runnerStore?.reason || '';
      runnerMetaEl.innerHTML = `
        <div><div class="label">Applied</div><div>${applied ? 'Yes (new auth)' : 'No change'}</div></div>
        <div><div class="label">Runner state</div><div>${state}</div></div>
        <div><div class="label">Validation</div><div>${validationStatus}${latency ? ` · ${latency}` : ''}</div></div>
        <div><div class="label">Digest</div><div>${digest ? `<code>${digest}</code>` : '—'}</div></div>
        <div><div class="label">Last refresh</div><div>${lastRefresh ? formatTimestamp(lastRefresh) : '—'}</div></div>
        <div><div class="label">Runner last check</div><div>${lastCheck ? formatTimestamp(lastCheck) : '—'}</div></div>
        <div><div class="label">Last OK</div><div>${lastOk ? formatTimestamp(lastOk) : '—'}</div></div>
        <div><div class="label">Last failure</div><div>${lastFailure ? formatTimestamp(lastFailure) : '—'}</div></div>
        <div><div class="label">Boot ID</div><div>${bootId ? `<code>${bootId}</code>` : '—'}</div></div>
        <div><div class="label">Notes</div><div>${reason || '—'}</div></div>
      `;
    }

    async function handleRunnerClick() {
      if (!runnerModal || !runnerLogEl) {
        await runRunnerNow();
        return;
      }
      showRunnerModal(true);
      appendRunnerLog('Preparing runner invocation…');
      try {
        const runResult = await runRunnerNow((msg, tone) => appendRunnerLog(msg, tone));
        appendRunnerLog('Fetching latest runner status…');
        const latestRunner = await api('/admin/runner');
        runnerSummary = latestRunner?.data || runnerSummary;
        setRunnerMeta(runnerSummary, runResult);
        appendRunnerLog('Runner finished', runResult?.applied ? 'ok' : null);
      } catch (err) {
        appendRunnerLog(`Runner error: ${err.message}`, 'err');
      }
    }

    if (versionCheckBtn) {
      versionCheckBtn.addEventListener('click', runVersionCheck);
    }
    if (runnerRunnerBtn) {
      runnerRunnerBtn.addEventListener('click', handleRunnerClick);
    }
    if (filterInput) {
      filterInput.addEventListener('input', (event) => {
        hostFilterText = event.target.value.trim().toLowerCase();
        paintHosts();
      });
    }
    document.querySelectorAll('.sort-btn[data-sort]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const key = btn.getAttribute('data-sort');
        if (key) setHostSort(key);
      });
    });
    updateSortIndicators();
    if (newHostBtn) {
      newHostBtn.addEventListener('click', () => showNewHostModal(true));
    }
    if (uploadAuthBtn) {
      uploadAuthBtn.addEventListener('click', () => showUploadModal(true));
    }
    if (seedUploadBtn) {
      seedUploadBtn.addEventListener('click', () => {
        showSeedModal(false);
        showUploadModal(true);
      });
    }
    if (seedDismissBtn) {
      seedDismissBtn.addEventListener('click', () => showSeedModal(false));
    }
    if (cancelNewHostBtn) {
      cancelNewHostBtn.addEventListener('click', () => showNewHostModal(false));
    }
    if (createHostBtn) {
      createHostBtn.addEventListener('click', createHost);
    }
    if (uploadAuthCancel) {
      uploadAuthCancel.addEventListener('click', () => showUploadModal(false));
    }
    if (uploadAuthFile) {
      uploadAuthFile.addEventListener('change', handleAuthFile);
    }
    if (uploadAuthSubmit) {
      uploadAuthSubmit.addEventListener('click', submitAuthUpload);
    }
    if (newHostModal) {
      newHostModal.addEventListener('click', (e) => {
        if (e.target === newHostModal) showNewHostModal(false);
      });
    }
    if (seedModal) {
      seedModal.addEventListener('click', (e) => {
        if (e.target === seedModal) showSeedModal(false);
      });
    }
    if (promptModal) {
      promptModal.addEventListener('click', (e) => {
        if (e.target === promptModal) showPromptModal(false);
      });
    }
    if (promptCancel) {
      promptCancel.addEventListener('click', () => showPromptModal(false));
    }
    if (promptSave) {
      promptSave.addEventListener('click', () => savePrompt());
    }
    if (deleteHostModal) {
      deleteHostModal.addEventListener('click', (e) => {
        if (e.target === deleteHostModal) closeDeleteModal();
      });
    }
    if (hostDetailModal) {
      hostDetailModal.addEventListener('click', (e) => {
        if (e.target === hostDetailModal) closeHostDetail();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && hostDetailModal?.classList.contains('show')) {
        e.preventDefault();
        closeHostDetail();
      }
    });
    if (closeHostDetailBtn) {
      closeHostDetailBtn.addEventListener('click', () => closeHostDetail());
    }
    if (runnerModal) {
      runnerModal.addEventListener('click', (e) => {
        if (e.target === runnerModal) showRunnerModal(false);
      });
    }
    if (runnerCloseBtn) {
      runnerCloseBtn.addEventListener('click', () => showRunnerModal(false));
    }
    if (upgradeModal) {
      upgradeModal.addEventListener('click', (e) => {
        if (e.target === upgradeModal) showUpgradeNotesModal(false);
      });
    }
    if (upgradeCloseBtn) {
      upgradeCloseBtn.addEventListener('click', () => showUpgradeNotesModal(false));
    }
    if (usageHistoryModal) {
      usageHistoryModal.addEventListener('click', (e) => {
        if (e.target === usageHistoryModal) showUsageHistoryModal(false);
      });
    }
    if (usageHistoryCloseBtn) {
      usageHistoryCloseBtn.addEventListener('click', () => showUsageHistoryModal(false));
    }
    if (costHistoryModal) {
      costHistoryModal.addEventListener('click', (e) => {
        if (e.target === costHistoryModal) showCostHistoryModal(false);
      });
    }
    if (costHistoryCloseBtn) {
      costHistoryCloseBtn.addEventListener('click', () => showCostHistoryModal(false));
    }
    if (cancelDeleteHostBtn) {
      cancelDeleteHostBtn.addEventListener('click', closeDeleteModal);
    }
    if (confirmDeleteHostBtn) {
      confirmDeleteHostBtn.addEventListener('click', confirmRemove);
    }
    if (apiToggleBtn) {
      apiToggleBtn.addEventListener('click', () => {
        if (apiDisabled === null) return;
        setApiState(!apiDisabled);
      });
    }
    if (quotaToggle) {
      quotaToggle.addEventListener('change', () => {
        setQuotaMode(quotaToggle.checked);
      });
    }
    loadApiState();

    function resetNewHostForm({ focusInput = false } = {}) {
      if (commandField) {
        commandField.style.display = 'none';
      }
      if (installerMeta) {
        installerMeta.style.display = 'none';
        installerMeta.textContent = '';
      }
      if (bootstrapCmdEl) {
        bootstrapCmdEl.textContent = '';
      }
      if (newHostName) {
        newHostName.value = '';
        if (focusInput) newHostName.focus();
      }
      if (secureHostToggle) {
        secureHostToggle.checked = true;
      }
      if (insecureToggle) {
        insecureToggle.checked = false;
      }
      if (ipv4Toggle) {
        ipv4Toggle.checked = false;
      }
    }

    function showNewHostModal(show, { reset = show, focusInput = reset } = {}) {
      if (!newHostModal) return;
      if (show) {
        newHostModal.classList.add('show');
        if (reset) resetNewHostForm({ focusInput });
      } else {
        newHostModal.classList.remove('show');
        if (reset) resetNewHostForm();
      }
    }

    function showUploadModal(show) {
      if (!uploadModal) return;
      if (show) {
        uploadModal.classList.add('show');
        uploadAuthText.value = '';
        uploadAuthFile.value = '';
        uploadFileContent = '';
        if (uploadHostSelect) {
          uploadHostSelect.value = 'system';
        }
        if (uploadStatus) uploadStatus.textContent = '';
      } else {
        uploadModal.classList.remove('show');
      }
    }

    async function createHost() {
      const fqdn = newHostName.value.trim();
      if (!fqdn) {
        alert('Please enter a host name');
        return;
      }
      await regenerateInstaller(fqdn);
    }

    async function regenerateInstaller(fqdn, hostId = null) {
      const targetFqdn = fqdn || newHostName.value.trim();
      if (!targetFqdn) {
        alert('Please enter a host name');
        return;
      }
      const existingHost = hostId ? currentHosts.find(h => h.id === hostId) : null;
      if (secureHostToggle && existingHost) {
        secureHostToggle.checked = isHostSecure(existingHost);
      }
      if (ipv4Toggle && existingHost) {
        ipv4Toggle.checked = !!existingHost.force_ipv4;
      }
      const secure = secureHostToggle ? secureHostToggle.checked : true;
      if (createHostBtn) {
        createHostBtn.disabled = true;
        createHostBtn.textContent = 'Generating…';
      }
      try {
        const res = await api('/admin/hosts/register', {
          method: 'POST',
          json: { fqdn: targetFqdn, host_id: hostId ?? undefined, secure },
        });
        const installer = res.data?.installer;
        if (!installer || !installer.command) throw new Error('Missing installer command in response');
        let cmd = installer.command;
        if (insecureToggle?.checked) {
          cmd = addCurlFlag(cmd, '-k');
        }
        if (ipv4Toggle?.checked) {
          cmd = addCurlFlag(cmd, '-4');
        }
        bootstrapCmdEl.textContent = cmd;
        commandField.style.display = 'block';
        if (copyCmdBtn) {
          copyCmdBtn.onclick = () => copyToClipboard(cmd);
        }
        if (installerMeta) {
          const expires = installer.expires_at ? formatRelative(installer.expires_at) : null;
          installerMeta.textContent = expires
            ? `One-time installer (expires ${expires}).`
            : `One-time installer ready.`;
          installerMeta.style.display = 'block';
        }
        if (newHostName) {
          newHostName.value = targetFqdn;
        }
        showNewHostModal(true, { reset: false });
        await loadAll();
      } catch (err) {
        const msg = err?.message || String(err);
        alert(`Installer generation failed: ${msg}`);
      } finally {
        if (createHostBtn) {
          createHostBtn.disabled = false;
          createHostBtn.textContent = 'Generate';
        }
      }
    }

    loadAll();

    function handleAuthFile() {
      const file = uploadAuthFile?.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        uploadFileContent = String(e.target?.result || '');
        if (uploadAuthText) {
          uploadAuthText.value = uploadFileContent;
        }
      };
      reader.readAsText(file);
    }

    async function submitAuthUpload() {
      const raw = uploadAuthText?.value?.trim() || uploadFileContent || '';
      if (!raw) {
        alert('Paste auth.json or choose a file first');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        alert(`Invalid JSON: ${err.message}`);
        return;
      }
      const selectedHost = uploadHostSelect?.value || 'system';
      const hostId = selectedHost === 'system' ? null : Number(selectedHost);
      const originalText = uploadAuthSubmit.textContent;
      uploadAuthSubmit.disabled = true;
      uploadAuthSubmit.textContent = 'Uploading…';
      try {
        const res = await api('/admin/auth/upload', {
          method: 'POST',
          json: { auth: parsed, host_id: hostId || undefined },
        });
        const data = res.data || {};
        const digest = data.canonical_digest || data.digest || 'n/a';
        const status = data.status || 'unknown';
        const validation = data.validation ? data.validation.status : null;
        const runnerApplied = data.runner_applied ? 'applied' : 'skipped';
        const message = `Upload ${status}; digest ${digest}; runner ${validation || 'n/a'} (${runnerApplied})`;
        if (uploadStatus) uploadStatus.textContent = message;
        await loadAll();
      } catch (err) {
        alert(`Upload failed: ${err.message}`);
      } finally {
        uploadAuthSubmit.disabled = false;
        uploadAuthSubmit.textContent = originalText;
      }
    }

    function openDeleteModal(id) {
      pendingDeleteId = id;
      const host = currentHosts.find(h => h.id === id);
      const name = host ? host.fqdn : `host #${id}`;
      if (deleteHostText) {
        deleteHostText.textContent = `Remove ${name}? This cannot be undone.`;
      }
      deleteHostModal?.classList.add('show');
    }

    function closeDeleteModal() {
      deleteHostModal?.classList.remove('show');
      pendingDeleteId = null;
    }

    async function confirmRemove() {
      if (pendingDeleteId === null) return;
      const btn = confirmDeleteHostBtn;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Removing…';
      }
      try {
        await api(`/admin/hosts/${pendingDeleteId}`, { method: 'DELETE' });
        await loadAll();
        closeDeleteModal();
      } catch (err) {
        alert(`Remove failed: ${err.message}`);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Remove';
        }
      }
    }

    async function confirmClear(id) {
      const host = currentHosts.find(h => h.id === id);
      const name = host ? host.fqdn : `id ${id}`;
      try {
        await api(`/admin/hosts/${id}/clear`, { method: 'POST' });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    async function toggleRoaming(id) {
      const host = currentHosts.find(h => h.id === id);
      if (!host) {
        alert('Host not found');
        return;
      }
      const targetState = !host.allow_roaming_ips;
      try {
        await api(`/admin/hosts/${id}/roaming`, {
          method: 'POST',
          json: { allow: targetState },
        });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    async function toggleSecurity(id, secureState = null) {
      const host = currentHosts.find(h => h.id === id);
      if (!host) {
        alert('Host not found');
        return;
      }
      const targetSecure = typeof secureState === 'boolean' ? secureState : !isHostSecure(host);
      try {
        await api(`/admin/hosts/${id}/secure`, {
          method: 'POST',
          json: { secure: targetSecure },
        });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    async function toggleInsecureApi(host, button = null) {
      if (!host || isHostSecure(host)) {
        alert('Host is secure; insecure API window not available.');
        return;
      }
      const state = insecureState(host);
      const path = state.enabledActive
        ? `/admin/hosts/${host.id}/insecure/disable`
        : `/admin/hosts/${host.id}/insecure/enable`;
      const originalLabel = button ? button.textContent : null;
      if (button) {
        button.disabled = true;
        button.textContent = state.enabledActive ? 'Turning off…' : 'Turning on…';
      }
      try {
        await api(path, { method: 'POST' });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      } finally {
        if (button) {
          button.disabled = false;
          if (originalLabel !== null) button.textContent = originalLabel;
        }
      }
    }

    async function toggleIpv4(host, button = null) {
      if (!host) {
        alert('Host not found');
        return;
      }
      const target = !host.force_ipv4;
      const originalLabel = button ? button.textContent : null;
      if (button) {
        button.disabled = true;
        button.textContent = target ? 'Forcing…' : 'Allowing…';
      }
      try {
        await api(`/admin/hosts/${host.id}/ipv4`, {
          method: 'POST',
          json: { force: target },
        });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      } finally {
        if (button) {
          button.disabled = false;
          if (originalLabel !== null) button.textContent = originalLabel;
        }
      }
    }
