const statsEl = document.getElementById('stats');
    const hostsTbody = document.querySelector('#hosts tbody');
    const versionCheckBtn = document.getElementById('version-check');
    const filterInput = document.getElementById('host-filter');
    const newHostBtn = document.getElementById('newHostBtn');
    const newHostModal = document.getElementById('newHostModal');
    const newHostName = document.getElementById('new-host-name');
    const secureHostToggle = document.getElementById('secureHostToggle');
    const insecureToggle = document.getElementById('insecureToggle');
    const ipv4Toggle = document.getElementById('ipv4Toggle');
    const vipToggle = document.getElementById('vipToggle');
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
    const promptsToggle = document.getElementById('promptsToggle');
    const newCommandBtn = document.getElementById('newCommandBtn');
    const promptModal = document.getElementById('promptModal');
    const promptFilename = document.getElementById('promptFilename');
    const promptDescription = document.getElementById('promptDescription');
    const promptArgument = document.getElementById('promptArgument');
    const promptBody = document.getElementById('promptBody');
    const promptSave = document.getElementById('promptSave');
    const promptCancel = document.getElementById('promptCancel');
    const promptStatus = document.getElementById('promptStatus');
    const promptsPanel = document.getElementById('prompts-panel');
    const agentsPanel = document.getElementById('agents-panel');
    const settingsPanel = document.getElementById('settings-panel');
    const memoriesPanel = document.getElementById('memories-panel');
    const memoriesTableBody = document.querySelector('#memories tbody');
    const memoriesHostFilter = document.getElementById('memoriesHostFilter');
    const memoriesQueryInput = document.getElementById('memoriesQuery');
    const memoriesTagsInput = document.getElementById('memoriesTags');
    const memoriesLimitInput = document.getElementById('memoriesLimit');
    const memoriesRefreshBtn = document.getElementById('memoriesRefreshBtn');
    const agentsMeta = document.getElementById('agentsMeta');
    const agentsPreview = document.getElementById('agentsPreview');
    const editAgentsBtn = document.getElementById('editAgentsBtn');
    const agentsToggle = document.getElementById('agentsToggle');
    const agentsModal = document.getElementById('agentsModal');
    const agentsBody = document.getElementById('agentsBody');
    const agentsStatus = document.getElementById('agentsStatus');
    const agentsCancel = document.getElementById('agentsCancel');
    const agentsSave = document.getElementById('agentsSave');
    const apiToggle = document.getElementById('apiToggle');
    const apiToggleLabel = document.getElementById('apiToggleLabel');
    const quotaToggle = document.getElementById('quotaHardFailToggle');
    const quotaModeLabel = document.getElementById('quotaModeLabel');
    const quotaLimitSlider = document.getElementById('quotaLimitSlider');
    const quotaLimitLabel = document.getElementById('quotaLimitLabel');
    const quotaPartitionSelect = document.getElementById('quotaPartitionSelect');
    const quotaPartitionLabel = document.getElementById('quotaPartitionLabel');
    const cdxSilentToggle = document.getElementById('cdxSilentToggle');
    const cdxSilentLabel = document.getElementById('cdxSilentLabel');
    const settingsToggle = document.getElementById('settingsToggle');
    const insecureWindowSlider = document.getElementById('insecureWindowSlider');
    const insecureWindowLabel = document.getElementById('insecureWindowLabel');
    const pageHero = document.querySelector('.page-hero');
    const heroEyebrow = pageHero?.querySelector('.eyebrow');
    const heroTitle = pageHero?.querySelector('h1');
    const heroCopy = pageHero?.querySelector('p.muted');
    const USAGE_HISTORY_DAYS = 60;
    const COST_SERIES = [
      { key: 'total', label: 'Total', color: '#312e81', emphasis: true },
      { key: 'input', label: 'Input', color: '#0ea5e9' },
      { key: 'output', label: 'Output', color: '#16a34a' },
      { key: 'cached', label: 'Cached', color: '#f97316' },
    ];
    const QUOTA_LIMIT_MIN = 50;
    const QUOTA_LIMIT_MAX = 100;
    const QUOTA_LIMIT_DEFAULT = 100;
    const QUOTA_WEEK_PARTITION_OFF = 0;
    const QUOTA_WEEK_PARTITION_FIVE = 5;
    const QUOTA_WEEK_PARTITION_SEVEN = 7;
    let pendingDeleteId = null;

    const upgradeNotesCache = {};
    let currentHosts = [];
    let currentPrompts = [];
    let currentMemories = [];
    let currentAgents = null;
    let agentsExpanded = true;
    let promptsExpanded = true;
    let settingsExpanded = true;
    let latestVersions = { client: null, wrapper: null };
    let tokensSummary = null;
    let runnerSummary = null;
    let hostFilterText = '';
    let hostSort = { key: 'last_seen', direction: 'desc' };
    let insecureExpanded = true;
    let secureExpanded = false;
    let hostStatusFilter = ''; // maintained for clarity
    const hostTabLinks = Array.from(document.querySelectorAll('.host-tab'));

    const urlParams = new URLSearchParams(window.location.search);
    const bodyView = (document.body?.dataset?.viewMode || '').toLowerCase();
    const viewMode = (bodyView || urlParams.get('view') || 'dashboard').toLowerCase();
    const redirectTargets = {
      agents: '/admin/agents.html',
      prompts: '/admin/prompts.html',
      hosts: '/admin/hosts.html',
      memories: '/admin/memories.html',
      settings: '/admin/settings.html',
    };
    if (['agents', 'prompts', 'hosts', 'memories', 'settings'].includes(viewMode)) {
      const targetId = `${viewMode}-panel`;
      if (!document.getElementById(targetId) && redirectTargets[viewMode]) {
        window.location.href = redirectTargets[viewMode];
      }
    }
    const initialHostParam = (urlParams.get('host') || '').toLowerCase();
    if (initialHostParam) {
      hostStatusFilter = initialHostParam;
    }
    function updateHostQueryParam(value) {
      const url = new URL(window.location.href);
      if (value) {
        url.searchParams.set('host', value);
      } else {
        url.searchParams.delete('host');
      }
      window.history.replaceState({}, '', url.toString());
    }
    function syncHostTabs() {
      hostTabLinks.forEach((link) => {
        const status = (link.dataset.hostTab || '').toLowerCase();
        const active = status === (hostStatusFilter || '');
        link.classList.toggle('active', active);
      });
    }
    syncHostTabs();
    let lastOverview = null;
    let chatgptUsage = null;
    let apiDisabled = null;
    let mtlsMeta = null;
    let uploadFileContent = '';
    let quotaHardFail = true;
    let quotaLimitPercent = QUOTA_LIMIT_DEFAULT;
    let quotaWeekPartition = QUOTA_WEEK_PARTITION_OFF;
    let cdxSilent = false;
    let chatgptUsageHistory = null;
    let chatgptUsageHistoryPromise = null;
    let costHistory = null;
    let costHistoryPromise = null;
    let activeHostId = null;
    const INSECURE_WINDOW_MIN = 2;
    const INSECURE_WINDOW_MAX = 60;
    const INSECURE_WINDOW_DEFAULT = 10;
    const INSECURE_WINDOW_STORAGE_KEY = 'codex.insecureWindowMinutes';
    let insecureWindowMinutes = INSECURE_WINDOW_DEFAULT;
    let memoriesLoading = false;
    let memoriesOpen = false;

    const VIEW_LAYOUTS = {
      dashboard: {
        eyebrow: 'Dashboard',
        title: 'Fleet overview',
        copy: 'Lightweight, square, and consistent across every admin page.',
        show: ['stats', 'chatgpt-usage-card'],
      },
      hosts: {
        eyebrow: 'Hosts',
        title: 'Authorized hosts',
        copy: 'Search, filter, and manage host state.',
        show: ['hosts-panel'],
      },
      agents: {
        eyebrow: 'Agents',
        title: 'Canonical AGENTS.md',
        copy: 'Synced to every host via cdx.',
        show: ['agents-panel'],
      },
      prompts: {
        eyebrow: 'Slash commands',
        title: 'Server-stored prompts',
        copy: 'Edit the prompts baked into hosts.',
        show: ['prompts-panel'],
      },
      memories: {
        eyebrow: 'Memories',
        title: 'Host memories',
        copy: 'Browse MCP memories stored by hosts.',
        show: ['memories-panel'],
      },
      settings: {
        eyebrow: 'Settings',
        title: 'Operations & settings',
        copy: 'Emergency toggles and runner utilities.',
        show: ['settings-panel'],
      },
    };

    function toggleSection(id, visible) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = visible ? '' : 'none';
    }

    function applyViewMode() {
      const config = VIEW_LAYOUTS[viewMode] || VIEW_LAYOUTS.dashboard;
      const allIds = ['stats', 'chatgpt-usage-card', 'hosts-panel', 'agents-panel', 'prompts-panel', 'memories-panel', 'settings-panel'];
      allIds.forEach((id) => toggleSection(id, config.show.includes(id)));
      if (pageHero) {
        if (heroEyebrow) heroEyebrow.textContent = config.eyebrow;
        if (heroTitle) heroTitle.textContent = config.title;
        if (heroCopy) heroCopy.textContent = config.copy;
      }
      if (document && config.eyebrow) {
        try {
          const baseTitle = document.title.replace(/ · .+$/, '');
          document.title = `${baseTitle} · ${config.eyebrow}`;
        } catch (_) {
          // ignore
        }
      }
    }

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

    function formatCurrency(value, currency = 'USD') {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      try {
        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency,
          maximumFractionDigits: 2,
        }).format(num);
      } catch {
        return `${currency} ${num.toFixed(2)}`;
      }
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

    function clipText(text, max = 140) {
      if (!text) return '';
      const trimmed = String(text).trim();
      if (trimmed.length <= max) return trimmed;
      return `${trimmed.slice(0, max - 1)}…`;
    }

    function parseTagInput(value) {
      if (!value) return [];
      return Array.from(new Set(
        String(value)
          .split(/[,\\s]+/)
          .map(t => t.trim())
          .filter(Boolean)
          .map(t => t.toLowerCase())
      ));
    }

    async function loadApiState() {
      try {
        const res = await api('/admin/api/state');
        apiDisabled = !!res.data?.disabled;
        if (apiToggle) {
          apiToggle.checked = !apiDisabled;
          apiToggle.disabled = false;
          if (apiToggleLabel) {
            apiToggleLabel.textContent = apiDisabled ? 'Disabled' : 'Enabled';
          }
        }
      } catch (err) {
        console.error('api state', err);
        if (apiToggle) {
          apiToggle.checked = false;
          apiToggle.disabled = true;
        }
        if (apiToggleLabel) {
          apiToggleLabel.textContent = 'Unavailable';
        }
      }
    }

    async function setApiState(enabled) {
      if (!apiToggle) return;
      apiToggle.disabled = true;
      try {
        await api('/admin/api/state', {
          method: 'POST',
          json: { disabled: !enabled },
        });
        apiDisabled = !enabled;
        if (apiToggleLabel) {
          apiToggleLabel.textContent = apiDisabled ? 'Disabled' : 'Enabled';
        }
      } catch (err) {
        alert(`API toggle failed: ${err.message}`);
        apiToggle.checked = !enabled; // revert
      } finally {
        apiToggle.disabled = false;
      }
    }

    async function setQuotaMode(hardFail) {
      if (!quotaToggle) return;
      quotaToggle.disabled = true;
      try {
        await api('/admin/quota-mode', {
          method: 'POST',
          json: { hard_fail: !!hardFail, limit_percent: quotaLimitPercent, week_partition: quotaWeekPartition },
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

    async function updateQuotaLimitPercent(nextValue) {
      if (!quotaLimitSlider) return;
      const normalized = clampQuotaLimitPercent(nextValue);
      if (normalized === quotaLimitPercent) {
        renderQuotaLimit();
        return;
      }
      const previous = quotaLimitPercent;
      quotaLimitPercent = normalized;
      renderQuotaLimit();
      quotaLimitSlider.disabled = true;
      try {
        await api('/admin/quota-mode', {
          method: 'POST',
          json: { hard_fail: quotaHardFail, limit_percent: normalized, week_partition: quotaWeekPartition },
        });
      } catch (err) {
        alert(`Quota limit update failed: ${err.message}`);
        quotaLimitPercent = previous;
        renderQuotaLimit();
      } finally {
        quotaLimitSlider.disabled = false;
      }
    }

    async function setQuotaPartition(nextValue) {
      if (!quotaPartitionSelect) return;
      const normalized = normalizeQuotaPartition(nextValue);
      if (normalized === quotaWeekPartition) {
        renderQuotaPartition();
        return;
      }
      const previous = quotaWeekPartition;
      quotaWeekPartition = normalized;
      renderQuotaPartition();
      quotaPartitionSelect.disabled = true;
      try {
        await api('/admin/quota-mode', {
          method: 'POST',
          json: { hard_fail: quotaHardFail, limit_percent: quotaLimitPercent, week_partition: normalized },
        });
      } catch (err) {
        alert(`Week partition update failed: ${err.message}`);
        quotaWeekPartition = previous;
        renderQuotaPartition();
      } finally {
        quotaPartitionSelect.disabled = false;
      }
    }

    function renderCdxSilent() {
      if (!cdxSilentToggle || !cdxSilentLabel) return;
      cdxSilentToggle.checked = !!cdxSilent;
      cdxSilentLabel.textContent = cdxSilent ? 'Silent' : 'Verbose';
    }

    async function loadCdxSilent() {
      if (!cdxSilentToggle) return;
      try {
        const res = await api('/admin/cdx-silent');
        cdxSilent = !!res?.data?.silent;
        renderCdxSilent();
      } catch (err) {
        console.warn('cdx silent state unavailable', err);
      }
    }

    async function setCdxSilent(nextValue) {
      if (!cdxSilentToggle) return;
      const previous = cdxSilent;
      cdxSilent = !!nextValue;
      renderCdxSilent();
      cdxSilentToggle.disabled = true;
      try {
        await api('/admin/cdx-silent', {
          method: 'POST',
          json: { silent: !!nextValue },
        });
      } catch (err) {
        alert(`cdx silent update failed: ${err.message}`);
        cdxSilent = previous;
        renderCdxSilent();
      } finally {
        cdxSilentToggle.disabled = false;
      }
    }

    function setMtls(meta) {
      mtlsMeta = meta; // kept for future use; pill removed from UI
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

    function summarizeAgentsContent(content) {
      const text = (content || '').trim();
      if (!text) return 'Empty AGENTS.md (hosts will receive a blank file).';
      return text;
    }

    function setAgentsExpanded(expanded) {
      agentsExpanded = !!expanded;
      if (agentsToggle) {
        agentsToggle.textContent = agentsExpanded ? 'Hide' : 'Show';
      }
      if (agentsPanel) {
        agentsPanel.classList.toggle('agents-collapsed', !agentsExpanded);
      }
    }

    function setPromptsExpanded(expanded) {
      promptsExpanded = !!expanded;
      if (promptsToggle) {
        promptsToggle.textContent = promptsExpanded ? 'Hide' : 'Show';
      }
      if (promptsPanel) {
        promptsPanel.classList.toggle('prompts-collapsed', !promptsExpanded);
      }
    }

    function setSettingsExpanded(expanded) {
      settingsExpanded = !!expanded;
      if (settingsToggle) {
        settingsToggle.textContent = settingsExpanded ? 'Hide' : 'Show';
      }
      if (settingsPanel) {
        settingsPanel.classList.toggle('settings-collapsed', !settingsExpanded);
      }
    }

    function renderAgents(doc) {
      currentAgents = doc || null;
      if (!agentsPanel) return;
      agentsPanel.style.display = 'block';
      setAgentsExpanded(agentsExpanded);

      const status = doc?.status || 'missing';
      const updatedAt = doc?.updated_at ? formatTimestamp(doc.updated_at) : 'never';
      const size = Number(doc?.size_bytes);
      const sizeLabel = Number.isFinite(size) ? `${formatNumber(size)} bytes` : '—';
      if (agentsMeta) {
        const parts = [];
        parts.push(`updated ${updatedAt}`);
        if (sizeLabel !== '—') parts.push(sizeLabel);
        agentsMeta.textContent = parts.join(' · ');
      }

      if (agentsPreview) {
        if (status === 'missing') {
          agentsPreview.textContent = 'No canonical AGENTS.md stored. Hosts will remove local copies.';
          agentsPreview.classList.add('muted');
        } else {
          agentsPreview.textContent = summarizeAgentsContent(doc?.content || '');
          agentsPreview.classList.remove('muted');
        }
      }
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
      const now = Date.now();
      const targetTs = (() => {
        const parsed = resetAt ? parseTimestamp(resetAt) : null;
        if (parsed) return parsed.getTime();
        if (Number.isFinite(seconds)) return now + (seconds * 1000);
        return null;
      })();

      if (!targetTs) return 'reset time unknown';

      const diffMs = targetTs - now;
      if (diffMs <= 0) return 'resets imminently';

      const minuteMs = 60 * 1000;
      const hourMs = 60 * minuteMs;
      const dayMs = 24 * hourMs;

      const days = Math.floor(diffMs / dayMs);
      const hours = Math.floor((diffMs % dayMs) / hourMs);
      const minutes = Math.floor((diffMs % hourMs) / minuteMs);

      if (diffMs >= 48 * hourMs) {
        const weekday = new Date(targetTs).toLocaleDateString('en-US', { weekday: 'long' });
        const dayLabel = `${days} day${days === 1 ? '' : 's'}`;
        return `Resets in ${dayLabel} (${weekday})`;
      }

      if (diffMs >= 24 * hourMs) {
        const dayLabel = `${days} day${days === 1 ? '' : 's'}`;
        const hourLabel = hours > 0 ? `, ${hours} hour${hours === 1 ? '' : 's'}` : '';
        return `Resets in ${dayLabel}${hourLabel}`;
      }

      if (diffMs >= hourMs) {
        const hourLabel = `${hours} hour${hours === 1 ? '' : 's'}`;
        const minuteLabel = minutes > 0 ? `, ${minutes} minute${minutes === 1 ? '' : 's'}` : '';
        return `Resets in ${hourLabel}${minuteLabel}`;
      }

      if (minutes > 0) {
        return `Resets in ${minutes} minute${minutes === 1 ? '' : 's'}`;
      }

      const secondsLeft = Math.max(1, Math.round(diffMs / 1000));
      return `Resets in ${secondsLeft} second${secondsLeft === 1 ? '' : 's'}`;
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

    function hostMatchesStatus(host) {
      switch ((hostStatusFilter || '').toLowerCase()) {
        case 'secure':
          return isHostSecure(host);
        case 'insecure':
          return !isHostSecure(host);
        case 'unprovisioned':
          return !host?.authed;
        default:
          return true;
      }
    }

    function applyHostFilters(list) {
      return list.filter(host => {
        if (!hostMatchesStatus(host)) return false;
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
      document.querySelectorAll('.sort-link[data-sort]').forEach((link) => {
        const key = link.getAttribute('data-sort');
        const indicator = link.querySelector('.sort-indicator');
        const isActive = key === hostSort.key;
        link.classList.toggle('sorted', isActive);
        link.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        link.setAttribute('aria-sort', isActive ? (hostSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
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

    function setHostStatusFilter(value) {
      hostStatusFilter = (value || '').toLowerCase();
      updateHostQueryParam(hostStatusFilter);
      syncHostTabs();
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

    function renderHostToggleRow({ action, checked, disabled, title, state }) {
      const attrs = [`type="checkbox"`, `data-toggle-action="${action}"`];
      if (checked) attrs.push('checked');
      if (disabled) attrs.push('disabled');
      const effect = state ? `
        <span class="host-toggle-divider">|</span>
        <span class="host-toggle-state">${escapeHtml(state)}</span>
      ` : '';
      return `
        <div class="host-toggle-row${disabled ? ' host-toggle-disabled' : ''}">
          <div class="host-toggle-left">
            <label class="toggle">
              <input ${attrs.join(' ')}>
              <span class="track"><span class="thumb"></span></span>
            </label>
            <div class="host-toggle-labels">
              <span class="host-toggle-title">${escapeHtml(title)}</span>
              ${effect}
            </div>
          </div>
        </div>
      `;
    }

    function renderHostActionButtons(host) {
      const secure = isHostSecure(host);
      const toggles = [];
      const secureState = secure
        ? 'Secure: auth.json stays on disk'
        : 'Insecure: auth.json purged after each run';
      toggles.push(renderHostToggleRow({
        action: 'secure',
        checked: secure,
        disabled: false,
        title: 'Secure host',
        state: secureState,
      }));

      toggles.push(renderHostToggleRow({
        action: 'vip',
        checked: !!host.vip,
        disabled: false,
        title: 'VIP host',
        state: host.vip ? 'Warn only: quota kill switch bypassed' : 'Standard quota enforcement',
      }));

      toggles.push(renderHostToggleRow({
        action: 'roaming',
        checked: !!host.allow_roaming_ips,
        disabled: false,
        title: 'Allow roaming IPs',
        state: host.allow_roaming_ips ? 'Roaming allowed (any IP)' : 'IP locked to first caller',
      }));

      toggles.push(renderHostToggleRow({
        action: 'ipv4',
        checked: !!host.force_ipv4,
        disabled: false,
        title: 'Force IPv4',
        state: host.force_ipv4 ? 'curl -4 enforced' : 'Dual-stack (IPv4/IPv6) allowed',
      }));

      const insecureAvailable = !secure;
      const insecureSnapshot = insecureAvailable ? insecureState(host) : null;
      const insecureChecked = insecureAvailable && !!insecureSnapshot?.enabledActive;
      let insecureStateLabel = 'Window closed';
      if (secure) {
        insecureStateLabel = 'Secure host: not applicable';
      } else if (insecureSnapshot?.enabledActive) {
        insecureStateLabel = `Window open (${formatCountdown(host.insecure_enabled_until)})`;
      } else if (insecureSnapshot?.graceActive) {
        insecureStateLabel = `Grace period (${formatCountdown(host.insecure_grace_until)})`;
      }
      toggles.push(renderHostToggleRow({
        action: 'insecure',
        checked: insecureChecked,
        disabled: !insecureAvailable,
        title: 'Insecure API window',
        state: insecureStateLabel,
      }));

      return `
        <div class="host-toggle-list">
          ${toggles.join('')}
        </div>
        <div class="host-action-buttons">
          <button class="ghost secondary" data-action="install">Install script</button>
          <button class="ghost" data-action="clear">Clear auth</button>
          <button class="danger" data-action="remove">Remove</button>
        </div>
      `;
    }

    function bindHostDetailActions(host) {
      if (!hostDetailActions) return;
      hostDetailActions.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const action = btn.getAttribute('data-action');
          if (action === 'install') {
            showHostDetailModal(false);
            regenerateInstaller(host.fqdn, host.id);
          } else if (action === 'clear') {
            confirmClear(host.id);
          } else if (action === 'remove') {
            showHostDetailModal(false);
            openDeleteModal(host.id);
          }
        };
      });
      hostDetailActions.querySelectorAll('input[data-toggle-action]').forEach((input) => {
        input.addEventListener('change', async (event) => {
          event.stopPropagation();
          const action = input.getAttribute('data-toggle-action');
          const desired = input.checked;
          input.disabled = true;
          try {
            if (action === 'secure') {
              await toggleSecurity(host.id, desired);
            } else if (action === 'vip') {
              await toggleVip(host, null, desired);
            } else if (action === 'roaming') {
              await toggleRoaming(host.id, desired);
            } else if (action === 'ipv4') {
              await toggleIpv4(host, null, desired);
            } else if (action === 'insecure') {
              await toggleInsecureApi(host, null, desired);
            }
          } catch (err) {
            alert(`Error: ${err.message}`);
            input.checked = !desired;
          } finally {
            input.disabled = false;
          }
        });
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
        if (host.vip) {
          pills.push('<span class="chip ok">VIP</span>');
        }
        if (isHostSecure(host) && host.auth_outdated) {
          pills.push('<span class="chip warn">Outdated auth</span>');
        }
        if (!isHostSecure(host)) {
          pills.push('<span class="chip warn">Insecure</span>');
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

    function isInsecureActive(host) {
      const state = insecureState(host);
      return state.enabledActive || state.graceActive;
    }

    function createHostRow(host, hasInsecure) {
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
      const vipChip = host.vip
        ? '<span class="chip ok" title="VIP host: quota hard-fail disabled">VIP</span>'
        : '';
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
      const authOutdatedChip = isSecure && host.auth_outdated ? '<span class="chip warn">Outdated auth</span>' : '';
      tr.classList.add(`status-${health.tone}`);
      tr.classList.add('host-row');
      tr.setAttribute('data-id', host.id);
      tr.tabIndex = 0;
      tr.innerHTML = `
        <td data-label="Host">
          <div class="inline-cell" style="flex-direction:column; align-items:flex-start; gap:4px;">
            <strong>${escapeHtml(host.fqdn)}</strong>
            <div class="inline-cell" style="gap:6px; align-items:center; flex-wrap:wrap;">
              <span class="muted" style="font-size:12px;">${shouldPruneSoon && willPruneAt ? `added ${formatRelative(addedAt)} · will be removed in ${willPruneAt}` : `added ${formatRelative(addedAt)}`}</span>
              <span class="chip ${health.tone === 'ok' ? 'ok' : 'warn'}">${health.label}</span>
              ${authOutdatedChip}
              ${securityChip}
              ${vipChip}
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
      return tr;
    }

    function paintHosts() {
      if (!Array.isArray(currentHosts)) return;
      const filtered = applyHostFilters(currentHosts);
      const hasInsecure = filtered.some((h) => !isHostSecure(h));
      const insecureHeader = document.querySelector('th.insecure-col');
      if (insecureHeader) {
        insecureHeader.style.display = hasInsecure ? '' : 'none';
      }

      hostsTbody.innerHTML = '';
      const cols = hasInsecure ? 6 : 5;
      if (!filtered.length) {
        hostsTbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">No hosts match your filters yet.</td></tr>`;
        updateSortIndicators();
        return;
      }

      const sorted = sortHosts(filtered);
      sorted.forEach((host) => hostsTbody.appendChild(createHostRow(host, hasInsecure)));
      updateSortIndicators();
    }

    function renderHosts(hosts) {
      currentHosts = Array.isArray(hosts) ? hosts : [];
      // Populate upload host select
      if (uploadHostSelect) {
        uploadHostSelect.innerHTML = '<option value="system">System (no host attribution)</option>' + currentHosts.map(h => `<option value="${h.id}">${escapeHtml(h.fqdn)}</option>`).join('');
        uploadHostSelect.value = 'system';
      }
      setMemoriesHostOptions();
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
        promptsPanel.style.display = 'block';
        setPromptsExpanded(promptsExpanded);
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

    function setMemoriesHostOptions() {
      if (!memoriesHostFilter) return;
      const previous = memoriesHostFilter.value;
      const options = ['<option value="">All hosts</option>'].concat(
        currentHosts.map(h => `<option value="${h.id}">${escapeHtml(h.fqdn)}</option>`)
      );
      memoriesHostFilter.innerHTML = options.join('');
      if (previous && options.join('').includes(`value="${previous}"`)) {
        memoriesHostFilter.value = previous;
      }
    }

    function renderMemories(memories) {
      currentMemories = Array.isArray(memories) ? memories : [];
      if (!memoriesTableBody) return;
      if (currentMemories.length === 0) {
        memoriesTableBody.innerHTML = '<tr><td colspan="4" class="muted" style="padding:12px;">No memories found</td></tr>';
        return;
      }

      memoriesTableBody.innerHTML = currentMemories.map((row) => {
        const id = row.id || '—';
        const content = clipText(row.content || '', 180).replace(/</g, '&lt;');
        const updated = row.updated_at ? formatTimestamp(row.updated_at) : '—';
        const tags = Array.isArray(row.tags) && row.tags.length
          ? row.tags.map(t => `<span class="tag-badge">${escapeHtml(t)}</span>`).join('')
          : '—';

        return `<tr>
          <td data-label="Content">${content || '—'}</td>
          <td data-label="Tags">${tags}</td>
          <td data-label="Updated">${updated}</td>
          <td data-label="Actions"><button class="ghost tiny-btn" data-delete-id="${escapeHtml(id)}">Delete</button></td>
        </tr>`;
      }).join('');

      memoriesTableBody.querySelectorAll('button[data-delete-id]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const id = btn.getAttribute('data-delete-id');
          if (!id || !confirm(`Delete memory ${id}?`)) return;
          try {
            await api(`/admin/mcp/memories/${encodeURIComponent(id)}`, 'DELETE');
            await loadMemories();
          } catch (err) {
            alert(err.message || 'Delete failed');
          }
        });
      });
    }

    async function loadMemories() {
      if (!memoriesPanel) return;
      const hostId = memoriesHostFilter?.value || '';
      const query = memoriesQueryInput?.value?.trim() || '';
      const tagInput = memoriesTagsInput?.value || '';
      const tags = parseTagInput(tagInput);
      let limit = Number(memoriesLimitInput?.value || 50);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      if (limit > 200) limit = 200;

      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (tags.length) params.set('tags', tags.join(','));
      params.set('limit', String(limit));

      if (memoriesRefreshBtn) {
        memoriesRefreshBtn.disabled = true;
        memoriesRefreshBtn.textContent = 'Loading…';
      }
      memoriesLoading = true;
      try {
        const res = await api(`/admin/mcp/memories?${params.toString()}`);
        renderMemories(res?.data?.matches || []);
      } catch (err) {
        console.error('memories', err);
        if (memoriesTableBody) {
          memoriesTableBody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:12px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        }
      } finally {
        memoriesLoading = false;
        if (memoriesRefreshBtn) {
          memoriesRefreshBtn.disabled = false;
          memoriesRefreshBtn.textContent = 'Refresh';
        }
      }
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
      const isPro = typeof plan === 'string' && plan.toLowerCase().includes('pro');
      const planLabel = plan;

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
          ev.stopPropagation();
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
      const currency = history?.currency || 'USD';
      const pointIndex = buildCostPointIndex(history);
      if (!pointIndex.length) {
        costHistoryChart.innerHTML = '<div class="muted">No cost history yet.</div>';
        return;
      }

      const gridLines = ticks.map((tick) => {
        const y = height - ((tick / yMax) * height);
        return `<g class="grid-row"><line x1="0" y1="${y.toFixed(2)}" x2="${width}" y2="${y.toFixed(2)}"></line><text x="${width}" y="${(y - 4).toFixed(2)}" text-anchor="end" class="tick">${formatMoney(tick, currency)}</text></g>`;
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
        const lineClass = `line line-${s.key}${s.emphasis ? ' line-emphasis' : ''}`;
        const dotClass = `dot dot-${s.key}${s.emphasis ? ' dot-emphasis' : ''}`;
        return `${path ? `<path d="${path}" class="${lineClass}"></path>` : ''}${latest ? `<circle cx="${latest.x.toFixed(2)}" cy="${latest.y.toFixed(2)}" r="4" class="${dotClass}"></circle>` : ''}`;
      }).join('');

      const legend = series.map((s) => {
        const latest = s.values[s.values.length - 1];
        const value = latest ? latest.y : 0;
        const color = s.color || '#0f172a';
        const classes = ['legend-item'];
        if (s.key === 'total' || s.emphasis) classes.push('legend-total');
        return `<span class="${classes.join(' ')}"><span class="swatch" style="background:${color};"></span>${s.label}<strong>${formatMoney(value, currency)}</strong></span>`;
      }).join('');

      const latestPoint = pointIndex[pointIndex.length - 1];
      const detailHtml = renderCostDetail(latestPoint, currency);
      const tableRows = renderCostTableRows(pointIndex, currency);

      costHistoryChart.innerHTML = `
        <div class="legend">${legend}</div>
        <div class="cost-chart-shell" data-chart-shell>
          <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Cost history over time">
            <g class="grid">${gridLines}</g>
            ${paths}
          </svg>
          <div class="cost-chart-overlay" data-chart-overlay aria-hidden="true"></div>
          <div class="cost-chart-crosshair" data-cost-crosshair hidden></div>
          <div class="cost-chart-tooltip" data-cost-tooltip hidden></div>
        </div>
        <div class="cost-detail" data-cost-detail>${detailHtml}</div>
        <div class="cost-table-wrap">
          <table class="cost-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Total</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cached</th>
                <th scope="col">Tokens</th>
              </tr>
            </thead>
            <tbody data-cost-table>${tableRows}</tbody>
          </table>
        </div>
      `;

      attachCostHistoryInteractions(costHistoryChart, {
        points: pointIndex,
        currency,
        minX,
        spanX,
      });
    }

    function attachCostHistoryInteractions(root, config) {
      const { points, currency, minX, spanX } = config || {};
      if (!root || !Array.isArray(points) || points.length === 0) return;
      const overlay = root.querySelector('[data-chart-overlay]');
      const tooltip = root.querySelector('[data-cost-tooltip]');
      const crosshair = root.querySelector('[data-cost-crosshair]');
      const detailEl = root.querySelector('[data-cost-detail]');
      const tableBody = root.querySelector('[data-cost-table]');
      if (!detailEl || !tableBody) return;

      const dateLookup = new Map(points.map((pt) => [pt.date, pt]));
      let selectedDate = points[points.length - 1]?.date || null;
      let lockedDate = selectedDate;
      let activeRow = null;

      function updateRowSelection(date) {
        if (!tableBody) return;
        if (activeRow && activeRow.dataset.costRow !== date) {
          activeRow.classList.remove('is-active');
          activeRow.setAttribute('aria-selected', 'false');
          activeRow = null;
        }
        if (!date) return;
        const nextRow = tableBody.querySelector(`tr[data-cost-row="${date}"]`);
        if (nextRow && nextRow !== activeRow) {
          nextRow.classList.add('is-active');
          nextRow.setAttribute('aria-selected', 'true');
          activeRow = nextRow;
        }
      }

      function positionCrosshair(point) {
        if (!crosshair) return;
        if (!point) {
          crosshair.hidden = true;
          return;
        }
        const range = spanX || 1;
        const ratio = range === 0 ? 0 : (point.x - minX) / range;
        const percent = clamp(ratio, 0, 1);
        crosshair.style.left = `${(percent * 100).toFixed(2)}%`;
        crosshair.hidden = false;
      }

      function setSelection(date, opts = {}) {
        if (!dateLookup.has(date)) return null;
        const point = dateLookup.get(date);
        const force = opts.force ?? false;
        if (!force && selectedDate === date) {
          if (opts.lock) lockedDate = date;
          return point;
        }
        selectedDate = date;
        if (opts.lock) lockedDate = date;
        if (detailEl) {
          detailEl.innerHTML = renderCostDetail(point, currency);
        }
        updateRowSelection(date);
        positionCrosshair(point);
        return point;
      }

      function showTooltip(point, clientX) {
        if (!tooltip || !overlay || !point) return;
        tooltip.innerHTML = renderCostTooltip(point, currency);
        tooltip.hidden = false;
        const rect = overlay.getBoundingClientRect();
        if (rect.width <= 0) return;
        const relative = clamp((clientX - rect.left) / rect.width, 0, 1);
        const tipWidth = tooltip.offsetWidth || 0;
        const leftPx = clamp((relative * rect.width) - (tipWidth / 2), 0, Math.max(rect.width - tipWidth, 0));
        tooltip.style.left = `${leftPx}px`;
        tooltip.style.top = '12px';
      }

      function hideTooltip() {
        if (!tooltip) return;
        tooltip.hidden = true;
        tooltip.innerHTML = '';
      }

      setSelection(selectedDate, { lock: true, force: true });

      if (overlay) {
        overlay.addEventListener('pointermove', (ev) => {
          const rect = overlay.getBoundingClientRect();
          if (rect.width <= 0) return;
          const relative = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const targetX = minX + ((spanX || 1) * relative);
          const point = findNearestCostPoint(points, targetX);
          if (!point) return;
          setSelection(point.date, { lock: false });
          showTooltip(point, ev.clientX);
        });
        overlay.addEventListener('pointerleave', () => {
          hideTooltip();
          if (lockedDate) {
            setSelection(lockedDate, { lock: false, force: true });
          }
        });
        overlay.addEventListener('click', (ev) => {
          const rect = overlay.getBoundingClientRect();
          if (rect.width <= 0) return;
          const relative = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const targetX = minX + ((spanX || 1) * relative);
          const point = findNearestCostPoint(points, targetX);
          if (point) {
            setSelection(point.date, { lock: true, force: true });
            showTooltip(point, ev.clientX);
          }
        });
      }

      const handleRowFocus = (event, lock = false) => {
        const row = event.target.closest('tr[data-cost-row]');
        if (!row) return;
        const date = row.dataset.costRow;
        if (!date) return;
        setSelection(date, { lock, force: lock });
        if (!lock) hideTooltip();
      };

      tableBody.addEventListener('mouseover', (event) => handleRowFocus(event, false));
      tableBody.addEventListener('focusin', (event) => handleRowFocus(event, false));
      tableBody.addEventListener('mouseleave', () => {
        hideTooltip();
        if (lockedDate) {
          setSelection(lockedDate, { lock: false, force: true });
        }
      });
      tableBody.addEventListener('click', (event) => {
        event.preventDefault();
        handleRowFocus(event, true);
      });
      tableBody.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleRowFocus(event, true);
      });
    }

    function buildCostPointIndex(history) {
      const points = Array.isArray(history?.points) ? history.points : [];
      const indexed = [];
      points.forEach((pt) => {
        const dateObj = parseDateOnly(pt?.date);
        if (!dateObj) return;
        indexed.push({
          ...pt,
          dateObj,
          x: dateObj.getTime(),
        });
      });
      indexed.sort((a, b) => a.x - b.x);
      return indexed;
    }

    function renderCostDetail(point, currency) {
      if (!point) {
        return '<div class="muted">Hover the chart or select a day to inspect the exact costs.</div>';
      }
      const totalCost = formatMoney(point?.costs?.total ?? 0, currency);
      const totalTokens = formatNumber(point?.tokens?.total ?? 0);
      const dateLabel = point.dateObj ? formatShortDate(point.dateObj) : point.date;
      const chips = COST_SERIES
        .filter((s) => s.key !== 'total')
        .map((seriesItem) => {
          const safeCost = Number.isFinite(point?.costs?.[seriesItem.key]) ? point.costs[seriesItem.key] : 0;
          const safeTokens = Number.isFinite(point?.tokens?.[seriesItem.key]) ? point.tokens[seriesItem.key] : 0;
          return `
            <div class="cost-detail-chip" data-series="${seriesItem.key}">
              <span>${seriesItem.label}</span>
              <strong>${formatMoney(safeCost, currency)}</strong>
              <small>${formatNumber(safeTokens)} tokens</small>
            </div>
          `;
        }).join('');
      return `
        <div class="cost-detail-head">
          <div>
            <div class="cost-detail-date">${dateLabel}</div>
            <div class="cost-detail-total">${totalCost}</div>
          </div>
          <div class="cost-detail-note">${totalTokens} tokens</div>
        </div>
        <div class="cost-detail-chips">${chips}</div>
      `;
    }

    function renderCostTooltip(point, currency) {
      if (!point) return '';
      const dateLabel = point.dateObj ? formatShortDate(point.dateObj) : point.date;
      const breakdown = COST_SERIES
        .filter((s) => s.key !== 'total')
        .map((seriesItem) => {
          const safeCost = Number.isFinite(point?.costs?.[seriesItem.key]) ? point.costs[seriesItem.key] : 0;
          return `<div><span>${seriesItem.label}</span><strong>${formatMoney(safeCost, currency)}</strong></div>`;
        }).join('');
      return `
        <div class="cost-tooltip-date">${dateLabel}</div>
        <div class="cost-tooltip-total">${formatMoney(point?.costs?.total ?? 0, currency)}</div>
        <div class="cost-tooltip-breakdown">${breakdown}</div>
      `;
    }

    function renderCostTableRows(points, currency) {
      if (!Array.isArray(points) || points.length === 0) {
        return '<tr><td colspan="6" class="muted">No cost data yet.</td></tr>';
      }
      const rows = [...points]
        .sort((a, b) => b.x - a.x)
        .map((pt) => {
          const dateLabel = pt.dateObj ? formatShortDate(pt.dateObj) : pt.date;
          const totalTokens = formatNumber(pt?.tokens?.total ?? 0);
          const col = (key) => formatMoney(pt?.costs?.[key] ?? 0, currency);
          const tok = (key) => formatNumber(pt?.tokens?.[key] ?? 0);
          return `
            <tr data-cost-row="${pt.date}" tabindex="0" aria-selected="false">
              <td><span class="cost-table-date" title="${pt.date}">${dateLabel}</span></td>
              <td><strong>${col('total')}</strong></td>
              <td><span>${col('input')}</span><small>${tok('input')} tok</small></td>
              <td><span>${col('output')}</span><small>${tok('output')} tok</small></td>
              <td><span>${col('cached')}</span><small>${tok('cached')} tok</small></td>
              <td class="tokens-col"><strong>${totalTokens}</strong><small>tokens</small></td>
            </tr>
          `;
        }).join('');
      return rows;
    }

    function findNearestCostPoint(points, targetX) {
      if (!Array.isArray(points) || points.length === 0) return null;
      let nearest = null;
      let bestDelta = Infinity;
      points.forEach((pt) => {
        const delta = Math.abs(pt.x - targetX);
        if (delta < bestDelta) {
          bestDelta = delta;
          nearest = pt;
        }
      });
      return nearest;
    }

    function clamp(value, min, max) {
      if (!Number.isFinite(value)) return min;
      if (value < min) return min;
      if (value > max) return max;
      return value;
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

    function clampQuotaLimitPercent(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return QUOTA_LIMIT_DEFAULT;
      let limited = Math.round(num);
      if (limited < QUOTA_LIMIT_MIN) {
        limited = QUOTA_LIMIT_MIN;
      } else if (limited > QUOTA_LIMIT_MAX) {
        limited = QUOTA_LIMIT_MAX;
      }
      return limited;
    }

    function normalizeQuotaPartition(value) {
      const allowed = [QUOTA_WEEK_PARTITION_OFF, QUOTA_WEEK_PARTITION_FIVE, QUOTA_WEEK_PARTITION_SEVEN];
      if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        if (trimmed === 'off' || trimmed === '0' || trimmed === '') {
          return QUOTA_WEEK_PARTITION_OFF;
        }
      }
      const num = Number(value);
      if (Number.isFinite(num)) {
        const rounded = Math.round(num);
        if (allowed.includes(rounded)) {
          return rounded;
        }
      }
      return QUOTA_WEEK_PARTITION_OFF;
    }

    function renderQuotaLimit() {
      if (quotaLimitSlider) {
        quotaLimitSlider.value = String(quotaLimitPercent);
      }
      if (quotaLimitLabel) {
        quotaLimitLabel.textContent = `${quotaLimitPercent}%`;
      }
    }

    function renderQuotaPartition() {
      if (quotaPartitionSelect) {
        quotaPartitionSelect.value = String(quotaWeekPartition);
      }
      if (quotaPartitionLabel) {
        let label = 'Off';
        if (quotaWeekPartition === QUOTA_WEEK_PARTITION_SEVEN) {
          label = '7 days (100/7 daily)';
        } else if (quotaWeekPartition === QUOTA_WEEK_PARTITION_FIVE) {
          label = '5 days (100/5 daily)';
        }
        quotaPartitionLabel.textContent = label;
      }
    }

    function renderQuotaMode() {
      if (quotaToggle && quotaModeLabel) {
        quotaToggle.checked = !!quotaHardFail;
        quotaModeLabel.textContent = quotaHardFail ? 'Deny launches' : 'Warn only';
      }
      const quotaDesc = quotaHardFail
        ? 'ChatGPT quota hit: deny Codex launch.'
        : 'ChatGPT quota hit: warn and continue.';
      document.querySelectorAll('#settings-panel .quota-desc').forEach((desc) => {
        desc.textContent = quotaDesc;
      });
      renderQuotaLimit();
      renderQuotaPartition();
    }

    function clampInsecureWindowMinutes(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return INSECURE_WINDOW_DEFAULT;
      if (num < INSECURE_WINDOW_MIN) return INSECURE_WINDOW_MIN;
      if (num > INSECURE_WINDOW_MAX) return INSECURE_WINDOW_MAX;
      return Math.round(num);
    }

    function applyQueryParams() {
      const params = new URLSearchParams(window.location.search);
      const hostParam = params.get('host');
      if (hostParam) {
        setHostStatusFilter(hostParam);
      }
      if (params.has('newHost')) {
        setTimeout(() => showNewHostModal(true), 180);
      }
    }

    function setInsecureWindowMinutes(value, persist = false) {
      insecureWindowMinutes = clampInsecureWindowMinutes(value);
      if (insecureWindowSlider && insecureWindowSlider.value !== String(insecureWindowMinutes)) {
        insecureWindowSlider.value = String(insecureWindowMinutes);
      }
      if (insecureWindowLabel) {
        insecureWindowLabel.textContent = `${insecureWindowMinutes} min`;
      }
      if (persist) {
        try {
          window.localStorage.setItem(INSECURE_WINDOW_STORAGE_KEY, String(insecureWindowMinutes));
        } catch {
          // ignore storage failures
        }
      }
    }

    function initInsecureWindowControl() {
      if (!insecureWindowSlider && !insecureWindowLabel) return;
      let stored = null;
      try {
        stored = window.localStorage.getItem(INSECURE_WINDOW_STORAGE_KEY);
      } catch {
        stored = null;
      }
      if (stored !== null) {
        setInsecureWindowMinutes(Number(stored));
      } else {
        setInsecureWindowMinutes(INSECURE_WINDOW_DEFAULT);
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
      if (!statsEl) return;
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

      const tokensDay = data.tokens_day || {};
      const tokensWeek = data.tokens_week || {};
      const tokensMonth = data.tokens_month || {};
      const getToken = (bucket, key) => {
        const v = Number(bucket?.[key]);
        return Number.isFinite(v) ? v : 0;
      };
      const tokenCard = (label, key) => {
        const month = getToken(tokensMonth, key);
        const week = getToken(tokensWeek, key);
        const day = getToken(tokensDay, key);
        return `
          <div class="card">
            <div class="stat-head">
              <span class="stat-label">${label}</span>
            </div>
            <div class="stat-value">${formatNumber(month)}</div>
            <small>${formatNumber(week)} this week · ${formatNumber(day)} today</small>
          </div>
        `;
      };

      const currency = typeof data?.pricing?.currency === 'string'
        ? data.pricing.currency.toUpperCase()
        : 'USD';
      const normalizeCost = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const dayCost = normalizeCost(data?.pricing_day_cost);
      const weekCost = normalizeCost(data?.pricing_week_cost);
      const monthCost = normalizeCost(data?.pricing_month_cost);
      const costCard = () => `
        <div class="card">
          <div class="stat-head">
            <span class="stat-label">Estimated Total</span>
            <span class="stat-sub">${currency}</span>
          </div>
          <div class="stat-value">${formatCurrency(monthCost, currency)}</div>
          <div class="stat-meta-line">
            <span>${formatCurrency(weekCost, currency)} this week</span>
            <span>${formatCurrency(dayCost, currency)} today</span>
            <button class="ghost tiny-btn cost-history-btn" type="button" aria-label="Open cost trend">Trend</button>
          </div>
        </div>
      `;

      cards.push(
        tokenCard('Input tokens', 'input'),
        tokenCard('Output tokens', 'output'),
        tokenCard('Cached tokens', 'cached'),
        costCard(),
      );

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
        const [overview, hosts, runner, prompts, agents] = await Promise.all([
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
          api('/admin/agents').catch(err => {
            console.warn('AGENTS.md unavailable', err);
            return null;
          }),
        ]);
        setMtls(overview.data.mtls);
        renderStats(overview.data, runner?.data || null);
        renderHosts(hosts.data.hosts);
        renderPrompts(prompts?.data?.commands || []);
        renderAgents(agents?.data || { status: 'missing' });
        await loadMemories();
        if (typeof overview.data.quota_limit_percent !== 'undefined') {
          quotaLimitPercent = clampQuotaLimitPercent(overview.data.quota_limit_percent);
        }
        if (typeof overview.data.quota_week_partition !== 'undefined') {
          quotaWeekPartition = normalizeQuotaPartition(overview.data.quota_week_partition);
        }
        if (typeof overview.data.quota_hard_fail !== 'undefined') {
          quotaHardFail = !!overview.data.quota_hard_fail;
        }
        renderQuotaMode();
        if (typeof overview.data.cdx_silent !== 'undefined') {
          cdxSilent = !!overview.data.cdx_silent;
          renderCdxSilent();
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

    function showAgentsModal(show) {
      if (!agentsModal) return;
      if (show) {
        agentsModal.classList.add('show');
      } else {
        agentsModal.classList.remove('show');
        if (agentsStatus) agentsStatus.textContent = '';
      }
    }

    function openAgentsModal() {
      if (!agentsBody) return;
      const content = currentAgents?.content || '';
      agentsBody.value = content;
      if (agentsStatus) agentsStatus.textContent = '';
      showAgentsModal(true);
    }

    async function saveAgents() {
      if (!agentsBody || !agentsSave) return;
      const content = agentsBody.value;
      agentsSave.disabled = true;
      const original = agentsSave.textContent;
      agentsSave.textContent = 'Saving…';
      if (agentsStatus) agentsStatus.textContent = 'Saving…';
      try {
        await api('/admin/agents/store', {
          method: 'POST',
          json: { content },
        });
        if (agentsStatus) agentsStatus.textContent = 'Saved';
        await loadAll();
        showAgentsModal(false);
      } catch (err) {
        if (agentsStatus) agentsStatus.textContent = `Save failed: ${err.message}`;
      } finally {
        agentsSave.disabled = false;
        agentsSave.textContent = original;
      }
    }

    async function openPromptModal(filename) {
      if (!promptFilename || !promptDescription || !promptBody) return;
      const target = typeof filename === 'string' ? filename.trim() : '';
      promptFilename.value = target;
      promptDescription.value = '';
      promptArgument.value = '';
      promptBody.value = '';
      if (!target) {
        if (promptStatus) promptStatus.textContent = '';
        showPromptModal(true);
        return;
      }
      if (promptStatus) promptStatus.textContent = 'Loading…';
      showPromptModal(true);
      try {
        const resp = await api(`/admin/slash-commands/${encodeURIComponent(target)}`);
        const data = resp?.data || {};
        promptFilename.value = data.filename || target || '';
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

    setSettingsExpanded(false);
    if (versionCheckBtn) {
      versionCheckBtn.addEventListener('click', runVersionCheck);
    }
    if (runnerRunnerBtn) {
      runnerRunnerBtn.addEventListener('click', handleRunnerClick);
    }
    if (settingsToggle) {
      settingsToggle.addEventListener('click', () => {
        setSettingsExpanded(!settingsExpanded);
      });
    }
    if (filterInput) {
      filterInput.addEventListener('input', (event) => {
        hostFilterText = event.target.value.trim().toLowerCase();
        paintHosts();
      });
    }
    if (hostTabLinks.length) {
      hostTabLinks.forEach((link) => {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          const status = (link.dataset.hostTab || '').toLowerCase();
          setHostStatusFilter(status);
        });
      });
      syncHostTabs();
    }
    document.querySelectorAll('.sort-link[data-sort]').forEach((link) => {
      const activate = () => {
        const key = link.getAttribute('data-sort');
        if (key) setHostSort(key);
      };
      link.addEventListener('click', (event) => {
        event.preventDefault();
        activate();
      });
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
    });
    updateSortIndicators();
    initInsecureWindowControl();
    if (insecureWindowSlider) {
      insecureWindowSlider.addEventListener('input', (event) => {
        setInsecureWindowMinutes(event.target.value, true);
      });
    }
    if (quotaLimitSlider) {
      quotaLimitSlider.addEventListener('input', (event) => {
        if (quotaLimitLabel) {
          const preview = clampQuotaLimitPercent(event.target.value);
          quotaLimitLabel.textContent = `${preview}%`;
        }
      });
      quotaLimitSlider.addEventListener('change', (event) => {
        updateQuotaLimitPercent(Number(event.target.value));
      });
    }
    if (quotaPartitionSelect) {
      quotaPartitionSelect.addEventListener('change', (event) => {
        setQuotaPartition(event.target.value);
      });
    }
    if (newHostBtn) {
      newHostBtn.addEventListener('click', () => showNewHostModal(true));
    }
    if (memoriesRefreshBtn) {
      memoriesRefreshBtn.addEventListener('click', () => loadMemories());
    }
    if (memoriesHostFilter) {
      memoriesHostFilter.addEventListener('change', () => loadMemories());
    }
    if (memoriesLimitInput) {
      memoriesLimitInput.addEventListener('change', () => loadMemories());
    }
    if (memoriesQueryInput) {
      memoriesQueryInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadMemories();
        }
      });
    }
    if (memoriesTagsInput) {
      memoriesTagsInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          loadMemories();
        }
      });
      memoriesTagsInput.addEventListener('blur', () => {
        if (!memoriesLoading) loadMemories();
      });
    }
    if (newCommandBtn) {
      newCommandBtn.addEventListener('click', (event) => {
        event.preventDefault();
        openPromptModal('');
      });
    }
    if (editAgentsBtn) {
      editAgentsBtn.addEventListener('click', (event) => {
        event.preventDefault();
        openAgentsModal();
      });
    }
    if (promptsToggle) {
      promptsToggle.addEventListener('click', (event) => {
        event.preventDefault();
        setPromptsExpanded(!promptsExpanded);
      });
    }
    if (agentsToggle) {
      agentsToggle.addEventListener('click', (event) => {
        event.preventDefault();
        setAgentsExpanded(!agentsExpanded);
      });
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
    if (agentsModal) {
      agentsModal.addEventListener('click', (e) => {
        if (e.target === agentsModal) showAgentsModal(false);
      });
    }
    if (promptCancel) {
      promptCancel.addEventListener('click', () => showPromptModal(false));
    }
    if (promptSave) {
      promptSave.addEventListener('click', () => savePrompt());
    }
    if (agentsCancel) {
      agentsCancel.addEventListener('click', () => showAgentsModal(false));
    }
    if (agentsSave) {
      agentsSave.addEventListener('click', () => saveAgents());
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
    if (apiToggle) {
      apiToggle.addEventListener('change', () => {
        setApiState(apiToggle.checked);
      });
    }
    if (quotaToggle) {
      quotaToggle.addEventListener('change', () => {
        setQuotaMode(quotaToggle.checked);
      });
    }
    if (cdxSilentToggle) {
      cdxSilentToggle.addEventListener('change', () => {
        setCdxSilent(cdxSilentToggle.checked);
      });
    }
    loadApiState();
    loadCdxSilent();

    function wireNavShortcuts() {
      const navNewHost = document.getElementById('navNewHost');
      if (navNewHost) {
        navNewHost.addEventListener('click', (ev) => {
          ev.preventDefault();
          showNewHostModal(true);
        });
      }
      document.querySelectorAll('[data-nav-host]').forEach((el) => {
        if (el.href && el.href.includes('view=')) return; // new pages handle navigation
        el.addEventListener('click', (ev) => {
          const target = el.getAttribute('data-nav-host');
          const samePage = ['/admin', '/admin/'].includes(window.location.pathname);
          if (!samePage) return;
          ev.preventDefault();
          setHostStatusFilter(target);
          secureExpanded = true;
          insecureExpanded = true;
          const panel = document.getElementById('hosts-panel');
          if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
      document.querySelectorAll('[data-nav-jump]').forEach((el) => {
        if (el.href && el.href.includes('view=')) return; // let navigation handle split pages
        el.addEventListener('click', (ev) => {
          const targetKey = el.getAttribute('data-nav-jump');
          const samePage = ['/admin', '/admin/'].includes(window.location.pathname);
          if (!samePage) return;
          ev.preventDefault();
          const targetId = `${targetKey}-panel`;
          const section = document.getElementById(targetId);
          if (targetKey === 'settings') setSettingsExpanded(true);
          if (targetKey === 'agents') setAgentsExpanded(true);
          if (targetKey === 'prompts') setPromptsExpanded(true);
          if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }

    wireNavShortcuts();
    applyQueryParams();
    applyViewMode();

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
      if (vipToggle) {
        vipToggle.checked = false;
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
      if (vipToggle && existingHost) {
        vipToggle.checked = !!existingHost.vip;
      }
      const secure = secureHostToggle ? secureHostToggle.checked : true;
      const vip = vipToggle ? vipToggle.checked : false;
      if (createHostBtn) {
        createHostBtn.disabled = true;
        createHostBtn.textContent = 'Generating…';
      }
      try {
        const res = await api('/admin/hosts/register', {
          method: 'POST',
          json: { fqdn: targetFqdn, host_id: hostId ?? undefined, secure, vip },
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

    async function toggleRoaming(id, allowState = null) {
      const host = currentHosts.find(h => h.id === id);
      if (!host) {
        alert('Host not found');
        return;
      }
      const targetState = typeof allowState === 'boolean' ? allowState : !host.allow_roaming_ips;
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

    async function toggleVip(host, button = null, desiredState = null) {
      if (!host) {
        alert('Host not found');
        return;
      }
      const target = typeof desiredState === 'boolean' ? desiredState : !host.vip;
      const original = button ? button.textContent : null;
      if (button) {
        button.disabled = true;
        button.textContent = target ? 'Promoting…' : 'Removing…';
      }
      try {
        await api(`/admin/hosts/${host.id}/vip`, {
          method: 'POST',
          json: { vip: target },
        });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      } finally {
        if (button) {
          button.disabled = false;
          if (original !== null) button.textContent = original;
        }
      }
    }

    async function toggleInsecureApi(host, button = null, desiredState = null) {
      if (!host || isHostSecure(host)) {
        alert('Host is secure; insecure API window not available.');
        return;
      }
      const state = insecureState(host);
      const enableTarget = typeof desiredState === 'boolean' ? desiredState : !state.enabledActive;
      const path = enableTarget
        ? `/admin/hosts/${host.id}/insecure/enable`
        : `/admin/hosts/${host.id}/insecure/disable`;
      const originalLabel = button ? button.textContent : null;
      if (button) {
        button.disabled = true;
        button.textContent = enableTarget ? 'Turning on…' : 'Turning off…';
      }
      const request = { method: 'POST' };
      if (enableTarget) {
        request.json = { duration_minutes: insecureWindowMinutes };
      }
      try {
        await api(path, request);
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

    async function toggleIpv4(host, button = null, desiredState = null) {
      if (!host) {
        alert('Host not found');
        return;
      }
      const target = typeof desiredState === 'boolean' ? desiredState : !host.force_ipv4;
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
