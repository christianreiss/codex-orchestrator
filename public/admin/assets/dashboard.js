    const statsEl = document.getElementById('stats');
    const hostsTbody = document.querySelector('#hosts-table tbody');
    const versionCheckBtn = document.getElementById('version-check');
    const filterInput = document.getElementById('host-filter');
    const newHostBtn = document.getElementById('newHostBtn');
    const newHostModal = document.getElementById('newHostModal');
    const navInsecureHosts = document.getElementById('navInsecureHosts');
    const insecureHostsDisableAllBtn = document.getElementById('insecureHostsDisableAll');
    const mtlsStatus = document.getElementById('mtlsStatus');
    const mtlsSettingStatus = document.getElementById('mtlsSettingStatus');
    const toastDeck = document.getElementById('toastDeck');
    const navAccountGroup = document.getElementById('navAccountGroup');
    const navThemeMenu = document.getElementById('navThemeMenu');
    const navThemeMenuTrigger = document.getElementById('navThemeMenuTrigger');
    const navThemeMenuPanel = document.getElementById('navThemeMenuPanel');
    const themeOptions = Array.from(document.querySelectorAll('[data-theme-option]'));
    const newHostName = document.getElementById('new-host-name');
    const secureHostToggle = document.getElementById('secureHostToggle');
    const temporaryHostToggle = document.getElementById('temporaryHostToggle');
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
    const seedCommandBtn = document.getElementById('seedCommandBtn');
    const seedCommandField = document.getElementById('seedCommandField');
    const seedCommandText = document.getElementById('seedCommandText');
    const seedCommandCopy = document.getElementById('seedCommandCopy');
    const seedCommandMeta = document.getElementById('seedCommandMeta');
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
    const agentsDeleteModal = document.getElementById('agentsDeleteModal');
    const agentsDeleteIntro = document.getElementById('agentsDeleteIntro');
    const agentsDeleteSelect = document.getElementById('agentsDeleteSelect');
    const agentsDeleteHosts = document.getElementById('agentsDeleteHosts');
    const agentsDeleteStatus = document.getElementById('agentsDeleteStatus');
    const agentsDeleteCancel = document.getElementById('agentsDeleteCancel');
    const agentsDeleteConfirm = document.getElementById('agentsDeleteConfirm');
    const hostDetailTitle = document.getElementById('hostDetailTitle');
    const hostDetailPills = document.getElementById('hostDetailPills');
    const hostDetailGrid = document.getElementById('hostDetailGrid');
    const hostDetailActions = document.getElementById('hostDetailActions');
    const hostDetailSummary = document.getElementById('hostDetailSummary');
    const hostDetailProblems = document.getElementById('hostDetailProblems');
    const hostDetailProblemsEmpty = document.getElementById('hostDetailProblemsEmpty');
    const hostDetailLayout = document.getElementById('hostDetailLayout');
    const hostDetailBack = document.getElementById('hostDetailBack');
    const hostDetailEmptyState = document.getElementById('hostDetailEmptyState');
    const hostDetailEmptyTitle = document.getElementById('hostDetailEmptyTitle');
    const hostDetailEmptyBody = document.getElementById('hostDetailEmptyBody');
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
    const skillsTbody = document.querySelector('#skills tbody');
    const newSkillBtn = document.getElementById('newSkillBtn');
    const skillModal = document.getElementById('skillModal');
    const skillSlug = document.getElementById('skillSlug');
    const skillNameInput = document.getElementById('skillName');
    const skillDescriptionInput = document.getElementById('skillDescription');
    const skillTagsInput = document.getElementById('skillTagsInput');
    const skillTagsList = document.getElementById('skillTagsList');
    const skillWhatInput = document.getElementById('skillWhat');
    const skillWhenInput = document.getElementById('skillWhen');
    const skillStepsInput = document.getElementById('skillSteps');
    const skillDelete = document.getElementById('skillDelete');
    const skillSave = document.getElementById('skillSave');
    const skillCancel = document.getElementById('skillCancel');
    const skillStatus = document.getElementById('skillStatus');
    const skillSlugSuggest = document.getElementById('skillSlugSuggest');
    const skillSlugNote = document.getElementById('skillSlugNote');
    const skillDigestBadge = document.getElementById('skillDigestBadge');
    const skillUpdatedBadge = document.getElementById('skillUpdatedBadge');
    const skillModalTitle = document.getElementById('skillModalTitle');
    const skillModalSubtitle = document.getElementById('skillModalSubtitle');
    const skillsPanel = document.querySelector('[data-settings-panel="skills"]');
    const agentsPanel = null;
    const settingsPanel = document.getElementById('settings-panel');
    const memoriesPanel = document.querySelector('.panel-set[data-panel="settings"] [data-settings-panel="memories"]');
    const memoriesTableBody = document.querySelector('#memories tbody');
    const memoriesTableWrap = document.getElementById('memoriesTableWrap');

    const dashboardMissionYear = document.getElementById('dashboardMissionYear');
    const dashboardSignalStrip = document.getElementById('dashboardSignalStrip');
    const dashboardRadarCard = document.getElementById('dashboardRadarCard');
    const memoriesHostFilter = document.getElementById('memoriesHostFilter');
    const memoriesQueryInput = document.getElementById('memoriesQuery');
    const memoriesTagsInput = document.getElementById('memoriesTags');
    const memoriesLimitInput = document.getElementById('memoriesLimit');
    const memoriesRefreshBtn = document.getElementById('memoriesRefreshBtn');
    const agentsMeta = document.getElementById('agentsMeta');
    const agentsServeLabel = document.getElementById('agentsServeLabel');
    const agentsServeLatest = document.getElementById('agentsServeLatest');
    const agentsPreview = document.getElementById('agentsPreview');
    const agentsEditorInline = document.getElementById('agentsEditorInline');
    const agentsStatus = document.getElementById('agentsStatus');
    const agentsEditToggle = document.getElementById('agentsEditToggle');
    const agentsSaveInline = document.getElementById('agentsSaveInline');
    const agentsVersionsBody = document.querySelector('#agentsVersions tbody');
    const apiToggle = document.getElementById('apiToggle');
    const apiToggleLabel = document.getElementById('apiToggleLabel');
    const quotaToggle = document.getElementById('quotaHardFailToggle');
    const quotaModeLabel = document.getElementById('quotaModeLabel');
    const quotaLimitSlider = document.getElementById('quotaLimitSlider');
    const quotaLimitLabel = document.getElementById('quotaLimitLabel');
    const quotaPartitionButtons = Array.from(document.querySelectorAll('.quota-partition-btn'));
    const quotaPartitionLabel = document.getElementById('quotaPartitionLabel');
    const cdxSilentToggle = document.getElementById('cdxSilentToggle');
    const cdxSilentLabel = document.getElementById('cdxSilentLabel');
    const reverseDnsToggle = document.getElementById('reverseDnsToggle');
    const reverseDnsLabel = document.getElementById('reverseDnsLabel');
    const insecureApprovalToggle = document.getElementById('insecureApprovalToggle');
    const insecureApprovalLabel = document.getElementById('insecureApprovalLabel');
    const autoUpdateToggle = document.getElementById('autoUpdateToggle');
    const autoUpdateLabel = document.getElementById('autoUpdateLabel');
    const codexVersionSelect = document.getElementById('codexVersionSelect');
    const codexVersionMeta = document.getElementById('codexVersionMeta');
    const accessBlockModal = document.getElementById('accessBlockModal');
    const accessBlockTitle = document.getElementById('accessBlockTitle');
    const accessBlockBody = document.getElementById('accessBlockBody');
    const accessBlockDismiss = document.getElementById('accessBlockDismiss');
    const insecureApprovalModal = document.getElementById('insecureApprovalModal');
    const insecureApprovalSubtitle = document.getElementById('insecureApprovalSubtitle');
    const insecureApprovalHost = document.getElementById('insecureApprovalHost');
    const insecureApprovalFqdn = document.getElementById('insecureApprovalFqdn');
    const insecureApprovalTime = document.getElementById('insecureApprovalTime');
    const insecureApprovalApprove = document.getElementById('insecureApprovalApprove');
    const insecureApprovalDeny = document.getElementById('insecureApprovalDeny');
    const insecureApprovalAllowDomain = document.getElementById('insecureApprovalAllowDomain');
    const settingsToggle = document.getElementById('settingsToggle');
    const insecureWindowSlider = document.getElementById('insecureWindowSlider');
    const insecureWindowLabel = document.getElementById('insecureWindowLabel');
    const pruneWindowSlider = document.getElementById('pruneWindowSlider');
    const pruneWindowLabel = document.getElementById('pruneWindowLabel');
    const insecureHostsModal = document.getElementById('insecureHostsModal');
    const insecureHostsList = document.getElementById('insecureHostsList');
    const insecureDomainsList = document.getElementById('insecureDomainsList');
    const insecureHostsCloseBtn = document.getElementById('insecureHostsCloseBtn');
    const pageHero = document.querySelector('.page-hero');
    const heroEyebrow = pageHero?.querySelector('.eyebrow');
    const heroTitle = pageHero?.querySelector('h1');
    const heroCopy = pageHero?.querySelector('p.muted');
    const dashboardGrid = document.getElementById('dashboardGrid');
    const USAGE_HISTORY_DAYS = 60;
    const COST_SERIES = [
      { key: 'total', label: 'Total', color: '#312e81', emphasis: true },
      { key: 'input', label: 'Input', color: '#0ea5e9' },
      { key: 'output', label: 'Output', color: '#16a34a' },
      { key: 'cached', label: 'Cached', color: '#f97316' },
    ];
    const DASHBOARD_RANGE_PRESETS = [7, 30, 60, 90, 180];
    const DASHBOARD_CHART_STORAGE_KEY = 'codex.dashboardCharts.v1';
    const QUOTA_SERIES_META = [
      { key: 'normal_primary', label: 'Normal 5-hour', color: '#0b7c73' },
      { key: 'normal_secondary', label: 'Normal weekly', color: '#2563eb' },
      { key: 'spark_primary', label: 'Spark 5-hour', color: '#f97316' },
      { key: 'spark_secondary', label: 'Spark weekly', color: '#7c3aed' },
    ];
    const QUOTA_LIMIT_MIN = 50;
    const QUOTA_LIMIT_MAX = 100;
    const QUOTA_LIMIT_DEFAULT = 100;
    const QUOTA_WEEK_PARTITION_OFF = 0;
    const QUOTA_WEEK_PARTITION_FIVE = 5;
    const QUOTA_WEEK_PARTITION_SEVEN = 7;
    const CODEX_RELEASES_CACHE_MS = 10 * 60 * 1000;
    let cachedCodexReleases = { fetchedAt: 0, versions: null, error: null };
    let pendingDeleteId = null;
    let pendingAgentsDeleteId = null;
    let pendingAgentsDeleteHosts = [];
    const HOST_MODEL_REASONING = {
      'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.3-codex-spark': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.2-codex': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.2': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.1-codex-max': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.1-codex-mini': ['medium', 'high'],
    };
    const HOST_REASONING_DEFAULTS = ['low', 'medium', 'high', 'xhigh'];

    const upgradeNotesCache = {};
    let currentHosts = [];
    let currentPrompts = [];
    let currentSkills = [];
    let currentMemories = [];
    let currentAgents = null;
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
    let skillSlugAutofill = true;
    let skillModalMode = 'new';
    let skillEditingSlug = '';
    let skillTags = [];

    const THEME_OPTIONS = ['auto', 'light', 'dark'];
    const THEME_LABELS = { auto: 'Auto', light: 'Light', dark: 'Dark' };

    function formatReasoningEffortLabel(value) {
      return value === 'xhigh' ? 'xhigh (Extra high)' : value;
    }

    function hostReasoningOptionsForModel(model) {
      const normalized = String(model || '').trim();
      return HOST_MODEL_REASONING[normalized] || HOST_REASONING_DEFAULTS;
    }

    function rebuildHostReasoningOptions(selectEl, model, currentValue) {
      if (!selectEl) return;
      const allowed = hostReasoningOptionsForModel(model);
      const normalizedCurrent = String(currentValue || '').trim().toLowerCase();
      selectEl.innerHTML = '';
      const standardOpt = document.createElement('option');
      standardOpt.value = '';
      standardOpt.textContent = 'Standard (global)';
      selectEl.appendChild(standardOpt);
      allowed.forEach((effort) => {
        const option = document.createElement('option');
        option.value = effort;
        option.textContent = formatReasoningEffortLabel(effort);
        selectEl.appendChild(option);
      });
      if (normalizedCurrent && allowed.includes(normalizedCurrent)) {
        selectEl.value = normalizedCurrent;
      } else {
        selectEl.value = '';
      }
    }

    function normalizeTheme(value) {
      return THEME_OPTIONS.includes(value) ? value : 'auto';
    }

    function readStoredTheme() {
      try {
        return localStorage.getItem('adminTheme');
      } catch (err) {
        return null;
      }
    }

    function writeStoredTheme(value) {
      try {
        localStorage.setItem('adminTheme', value);
      } catch (err) {
        // ignore storage failures (private mode, blocked storage)
      }
    }

    function applyTheme(theme) {
      const normalized = normalizeTheme(theme);
      if (document.body) {
        document.body.dataset.theme = normalized;
      }
      themeOptions.forEach((option) => {
        const active = normalizeTheme(option.dataset.themeOption) === normalized;
        option.classList.toggle('is-current', active);
        option.setAttribute('aria-checked', active ? 'true' : 'false');
      });
      if (navThemeMenuTrigger) {
        const label = `Theme Selection: ${THEME_LABELS[normalized] || 'Auto'}`;
        navThemeMenuTrigger.setAttribute('aria-label', label);
        navThemeMenuTrigger.setAttribute('title', label);
        navThemeMenuTrigger.dataset.theme = normalized;
      }
    }

    function setThemeMenuOpen(open) {
      if (!navThemeMenu || !navThemeMenuTrigger) return;
      const expanded = Boolean(open);
      navThemeMenu.classList.toggle('is-open', expanded);
      navThemeMenuTrigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }

    function initThemeToggle() {
      const initial = normalizeTheme(readStoredTheme());
      applyTheme(initial);
      if (!navThemeMenu || !navThemeMenuTrigger) return;
      navThemeMenuTrigger.addEventListener('click', (event) => {
        event.preventDefault();
        setThemeMenuOpen(!navThemeMenu.classList.contains('is-open'));
      });
      themeOptions.forEach((option) => {
        option.addEventListener('click', () => {
          const nextTheme = normalizeTheme(option.dataset.themeOption);
          writeStoredTheme(nextTheme);
          applyTheme(nextTheme);
          setThemeMenuOpen(false);
          window.__railNav?.closeMenus?.();
        });
      });
      document.addEventListener('click', (event) => {
        if (navThemeMenu.contains(event.target)) return;
        setThemeMenuOpen(false);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        setThemeMenuOpen(false);
      });
      if (navAccountGroup && typeof MutationObserver === 'function') {
        const themeObserver = new MutationObserver(() => {
          if (!navAccountGroup.classList.contains('is-open')) {
            setThemeMenuOpen(false);
          }
        });
        themeObserver.observe(navAccountGroup, {
          attributes: true,
          attributeFilter: ['class'],
        });
      }
    }

    initThemeToggle();

    function parseHostIdFromPath(pathname = window.location.pathname) {
      const match = String(pathname || '').match(/^\/admin\/hosts\/(\d+)\/?$/);
      if (!match) return null;
      const parsed = Number(match[1]);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return Math.trunc(parsed);
    }

    function currentPathHostId() {
      return parseHostIdFromPath(window.location.pathname);
    }

    const { panel: viewMode, sub: _initialSub } = parsePanelFromPath();
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

    function updateHostTabVisibility(hosts) {
      const list = Array.isArray(hosts) ? hosts : [];
      const counts = {
        secure: 0,
        insecure: 0,
        unprovisioned: 0,
      };
      list.forEach((host) => {
        if (!host?.authed) {
          counts.unprovisioned += 1;
          return;
        }
        if (isHostSecure(host)) {
          counts.secure += 1;
        } else {
          counts.insecure += 1;
        }
      });

      const categoriesWithServers = Object.values(counts).filter((n) => n > 0).length;

      hostTabLinks.forEach((link) => {
        const tab = (link.dataset.hostTab || '').toLowerCase();
        if (tab === '') {
          // Show "All" only when there is more than one non-empty category.
          link.style.display = categoriesWithServers > 1 ? '' : 'none';
          return;
        }
        if (tab === 'any') {
          // "Any" is only useful when there is at least one server to show.
          const anyCount = list.length;
          link.style.display = anyCount > 0 ? '' : 'none';
          return;
        }
        if (Object.prototype.hasOwnProperty.call(counts, tab)) {
          link.style.display = counts[tab] > 0 ? '' : 'none';
          return;
        }
        link.style.display = '';
      });

      // If current selection becomes hidden, fall back to the first visible tab.
      const active = hostTabLinks.find((l) => l.classList.contains('active'));
      if (active && active.style.display === 'none') {
        const firstVisible = hostTabLinks.find((l) => l.style.display !== 'none');
        if (firstVisible) {
          setHostStatusFilter((firstVisible.dataset.hostTab || '').toLowerCase());
        }
      }
    }
    syncHostTabs();
    let lastOverview = null;
    let chatgptUsage = null;
    let liveRefreshTimer = null;
    let liveRefreshInFlight = false;
    let liveRefreshQueued = false;
    const liveRefreshPendingDomains = new Set();
    let apiDisabled = null;
    let mtlsMeta = null;
    let uploadFileContent = '';
    let quotaHardFail = true;
    let quotaLimitPercent = QUOTA_LIMIT_DEFAULT;
    let quotaWeekPartition = QUOTA_WEEK_PARTITION_OFF;
    let cdxSilent = false;
    let reverseDnsEnabled = false;
    let insecureApprovalEnabled = false;
    let autoUpdateEnabled = false;
    let chatgptUsageHistory = null;
    let chatgptUsageHistoryPromise = null;
    const chatgptUsageHistoryCache = new Map();
    const chatgptUsageHistoryPromiseCache = new Map();
    let costHistory = null;
    let costHistoryPromise = null;
    const costHistoryCache = new Map();
    const costHistoryPromiseCache = new Map();
    let usageHistoryPlot = null;
    let usageHistoryResizeObserver = null;
    let costHistoryPlot = null;
    let costHistoryResizeObserver = null;
    let dashboardQuotaChart = null;
    let dashboardCostChart = null;
    let dashboardQuotaPoints = [];
    let dashboardCostPoints = [];
    let dashboardCostCurrency = 'USD';
    let dashboardQuotaPinnedIndex = null;
    let dashboardCostPinnedIndex = null;
    let dashboardChartsWired = false;
    let dashboardChartRenderToken = 0;
    let activeHostId = null;
    let activeInsecureApproval = null;
    const insecureApprovalQueue = [];
    let insecureApprovalBusy = false;
    const INSECURE_WINDOW_MIN = 0;
    const INSECURE_WINDOW_MAX = 480;
    const INSECURE_WINDOW_DEFAULT = 10;
    const INSECURE_WINDOW_SLIDER_MIN = 0;
    const INSECURE_WINDOW_SLIDER_MAX = 100;
    const INSECURE_WINDOW_LOG_CURVE = 4;
    const INSECURE_WINDOW_STORAGE_KEY = 'codex.insecureWindowMinutes';
    let insecureWindowMinutes = INSECURE_WINDOW_DEFAULT;
    let insecureModalOpen = false;
    let insecureModalRefreshTimer = null;
    let insecureModalCountdownTimer = null;
    const PRUNE_WINDOW_MIN = 0;
    const PRUNE_WINDOW_MAX = 60;
    const PRUNE_WINDOW_DEFAULT = 30;
    let inactivityWindowDays = PRUNE_WINDOW_DEFAULT;
    let memoriesLoading = false;
    let memoriesOpen = false;
    let dashboardChartPrefs = readDashboardChartPrefs();

    const dashboardYear = new Date().getFullYear();
    if (dashboardMissionYear) {
      dashboardMissionYear.textContent = String(dashboardYear);
    }

    const VIEW_LAYOUTS = {
      dashboard: {
        eyebrow: 'Dashboard',
        title: 'Fleet Mission Control',
        copy: `At-a-glance ${dashboardYear} posture across hosts, auth, usage, quota, and spend.`,
        show: ['stats', 'chatgpt-usage-card'],
      },
      hosts: {
        eyebrow: 'Hosts',
        title: 'Authorized hosts',
        copy: 'Search, filter, and manage host state.',
        show: ['hosts-panel'],
      },
      'host-detail': {
        eyebrow: 'Host Details',
        title: 'Host mission page',
        copy: 'Action items, features, stats, and technical context for one host.',
        show: ['hostDetailPanel'],
      },
      'project-detail': {
        eyebrow: 'Project Details',
        title: 'Project workspace',
        copy: 'Shared context, artifacts, and triage for one coordination space.',
        show: ['projectDetailPanel'],
      },
      users: {
        eyebrow: 'Users',
        title: 'User management',
        copy: 'Create users and assign access levels.',
        show: ['users-panel'],
      },
      account: {
        eyebrow: 'Account',
        title: 'Your account',
        copy: 'Manage your sign-in settings and personal admin session.',
        show: ['accountPanel'],
      },
      agents: {
        eyebrow: 'Agents',
        title: 'Canonical AGENTS.md',
        copy: 'Synced to every host via cdx.',
        show: ['settings-panel'],
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
      // Use the live body dataset view to reflect navigation without reloads.
      const activeView = (document.body?.dataset?.viewMode || viewMode || 'dashboard').toLowerCase();
      let config = VIEW_LAYOUTS[activeView] || VIEW_LAYOUTS.dashboard;
      if (activeView === 'account') {
        const accountTab = (document.body?.dataset?.accountTab || 'password').toLowerCase();
        if (accountTab === 'passkeys') {
          config = {
            ...config,
            eyebrow: 'Passkeys',
            title: 'Account passkeys',
            copy: 'Register, rename, and retire WebAuthn credentials for this admin account.',
          };
        } else {
          config = {
            ...config,
            eyebrow: 'Password',
            title: 'Change your password',
            copy: 'Update the password for the admin account signed into this session.',
          };
        }
      }
      const allIds = ['stats', 'chatgpt-usage-card', 'hosts-panel', 'hostDetailPanel', 'projectDetailPanel', 'users-panel', 'accountPanel', 'prompts-panel', 'memories-panel', 'settings-panel', 'dashboardGrid'];
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

    function formatCompactNumber(value) {
      if (value === null || value === undefined) return '—';
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      try {
        return new Intl.NumberFormat('en-US', {
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(num);
      } catch (_) {
        return formatNumber(num);
      }
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

    function formatPercent(value, digits = 0) {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      const safeDigits = Number.isFinite(digits) ? Math.max(0, Math.min(2, Math.floor(digits))) : 0;
      return `${num.toFixed(safeDigits)}%`;
    }

    function clampRangeDays(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return USAGE_HISTORY_DAYS;
      const rounded = Math.round(numeric);
      if (!DASHBOARD_RANGE_PRESETS.includes(rounded)) return USAGE_HISTORY_DAYS;
      return rounded;
    }

    function normalizeChartType(value) {
      const normalized = String(value || '').trim().toLowerCase();
      return normalized === 'stacked' ? 'stacked' : 'line';
    }

    function normalizeVisibleSeries(value) {
      if (!Array.isArray(value)) return [];
      return value
        .map((item) => String(item || '').trim().toLowerCase())
        .filter((item) => item !== '');
    }

    function readDashboardChartPrefs() {
      const defaults = {
        range_days: USAGE_HISTORY_DAYS,
        compare_previous: false,
        chart_type: 'line',
        quota_visible: [],
        cost_visible: [],
      };
      try {
        const raw = localStorage.getItem(DASHBOARD_CHART_STORAGE_KEY);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        return {
          range_days: clampRangeDays(parsed?.range_days),
          compare_previous: !!parsed?.compare_previous,
          chart_type: normalizeChartType(parsed?.chart_type),
          quota_visible: normalizeVisibleSeries(parsed?.quota_visible),
          cost_visible: normalizeVisibleSeries(parsed?.cost_visible),
        };
      } catch (_) {
        return defaults;
      }
    }

    function writeDashboardChartPrefs() {
      try {
        localStorage.setItem(DASHBOARD_CHART_STORAGE_KEY, JSON.stringify({
          range_days: clampRangeDays(dashboardChartPrefs?.range_days),
          compare_previous: !!dashboardChartPrefs?.compare_previous,
          chart_type: normalizeChartType(dashboardChartPrefs?.chart_type),
          quota_visible: normalizeVisibleSeries(dashboardChartPrefs?.quota_visible),
          cost_visible: normalizeVisibleSeries(dashboardChartPrefs?.cost_visible),
        }));
      } catch (_) {
        // Storage can fail in private mode; ignore.
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

    let toastCounter = 0;
    const TOAST_LEVELS = new Set(['info', 'success', 'warn', 'error']);

    function normalizeToastLevel(value) {
      const raw = String(value || '').toLowerCase();
      if (raw === 'ok' || raw === 'success') return 'success';
      if (raw === 'warning' || raw === 'warn') return 'warn';
      if (raw === 'error' || raw === 'fail' || raw === 'danger') return 'error';
      if (TOAST_LEVELS.has(raw)) return raw;
      return 'info';
    }

    function normalizeToastTimeout(value, fallback = 5000) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      const clamped = Math.max(1000, Math.min(parsed, 20000));
      return clamped;
    }

    function dismissToast(el, immediate = false) {
      if (!el) return;
      const timeoutId = Number(el.dataset.toastTimeout || 0);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (immediate) {
        el.remove();
        return;
      }
      el.classList.remove('show');
      window.setTimeout(() => el.remove(), 200);
    }

    function pushToast({ title, message, level = 'info', timeoutMs = 5000 } = {}) {
      if (!toastDeck) return;
      const msg = String(message || '').trim();
      if (!msg) return;
      const toastId = ++toastCounter;
      const normalizedLevel = normalizeToastLevel(level);

      const toastEl = document.createElement('div');
      toastEl.className = `toast level-${normalizedLevel}`;
      toastEl.dataset.toastId = String(toastId);

      const content = document.createElement('div');
      if (title && String(title).trim() !== '') {
        const titleEl = document.createElement('div');
        titleEl.className = 'toast-title';
        titleEl.textContent = String(title).trim();
        content.appendChild(titleEl);
      }

      const bodyEl = document.createElement('div');
      bodyEl.className = 'toast-body';
      bodyEl.textContent = msg;
      content.appendChild(bodyEl);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'toast-close';
      closeBtn.setAttribute('aria-label', 'Dismiss');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', () => dismissToast(toastEl, true));

      toastEl.appendChild(content);
      toastEl.appendChild(closeBtn);
      toastDeck.appendChild(toastEl);

      while (toastDeck.children.length > 5) {
        dismissToast(toastDeck.firstElementChild, true);
      }

      requestAnimationFrame(() => toastEl.classList.add('show'));

      const ttl = normalizeToastTimeout(timeoutMs);
      const timeoutId = window.setTimeout(() => dismissToast(toastEl), ttl);
      toastEl.dataset.toastTimeout = String(timeoutId);
    }

    function toast(message, tone = 'warn', { timeoutMs = 3500, title = null } = {}) {
      pushToast({
        title,
        message,
        level: normalizeToastLevel(tone),
        timeoutMs,
      });
    }

    function toastFromEvent(eventOrPayload) {
      if (!eventOrPayload || typeof eventOrPayload !== 'object') return;
      const payload = (eventOrPayload.payload && typeof eventOrPayload.payload === 'object')
        ? eventOrPayload.payload
        : eventOrPayload;
      const message = payload.message ?? payload.body ?? payload.text ?? null;
      if (typeof message !== 'string' || message.trim() === '') return;
      const title = typeof payload.title === 'string' ? payload.title : null;
      const level = payload.level ?? payload.tone ?? payload.status ?? 'info';
      const timeoutMs = normalizeToastTimeout(payload.timeout_ms ?? payload.timeoutMs ?? payload.ttl_ms ?? 5000);
      const createdAt = payload.created_at ?? eventOrPayload.created_at ?? null;
      const relative = createdAt ? formatRelative(createdAt) : null;
      const messageWithTime = relative && relative !== '—'
        ? `${message} · ${relative}`
        : message;

      pushToast({
        title,
        message: messageWithTime,
        level,
        timeoutMs,
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

    function addBashEnv(cmd, envAssignment) {
      if (!cmd || !envAssignment) return cmd;
      if (cmd.includes(envAssignment)) return cmd;
      return cmd.replace(/\|\s*bash\b/, `| ${envAssignment} bash`);
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
        toast(`API toggle failed: ${err.message}`, 'error');
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
        toast(`Quota policy update failed: ${err.message}`, 'error');
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
      renderQuotaPartition();
      quotaLimitSlider.disabled = true;
      try {
        await api('/admin/quota-mode', {
          method: 'POST',
          json: { hard_fail: quotaHardFail, limit_percent: normalized, week_partition: quotaWeekPartition },
        });
      } catch (err) {
        toast(`Quota limit update failed: ${err.message}`, 'error');
        quotaLimitPercent = previous;
        renderQuotaLimit();
      } finally {
        quotaLimitSlider.disabled = false;
      }
    }

    async function setQuotaPartition(nextValue) {
      if (!quotaPartitionButtons.length) return;
      const normalized = normalizeQuotaPartition(nextValue);
      if (normalized === quotaWeekPartition) {
        renderQuotaPartition();
        return;
      }
      const previous = quotaWeekPartition;
      quotaWeekPartition = normalized;
      renderQuotaPartition();
      quotaPartitionButtons.forEach((btn) => { btn.disabled = true; });
      try {
        await api('/admin/quota-mode', {
          method: 'POST',
          json: { hard_fail: quotaHardFail, limit_percent: quotaLimitPercent, week_partition: normalized },
        });
      } catch (err) {
        toast(`Week partition update failed: ${err.message}`, 'error');
        quotaWeekPartition = previous;
        renderQuotaPartition();
      } finally {
        quotaPartitionButtons.forEach((btn) => { btn.disabled = false; });
      }
    }

    function renderCdxSilent() {
      if (!cdxSilentToggle || !cdxSilentLabel) return;
      cdxSilentToggle.checked = !!cdxSilent;
      cdxSilentLabel.textContent = cdxSilent ? 'Silent' : 'Verbose';
    }

    function renderReverseDns() {
      if (!reverseDnsToggle || !reverseDnsLabel) return;
      reverseDnsToggle.checked = !!reverseDnsEnabled;
      reverseDnsLabel.textContent = reverseDnsEnabled ? 'Enabled' : 'Disabled';
    }

    function renderInsecureApproval() {
      if (!insecureApprovalToggle || !insecureApprovalLabel) return;
      insecureApprovalToggle.checked = !!insecureApprovalEnabled;
      insecureApprovalLabel.textContent = insecureApprovalEnabled ? 'Enabled' : 'Disabled';
    }

    function renderAutoUpdate() {
      if (!autoUpdateToggle || !autoUpdateLabel) return;
      autoUpdateToggle.checked = !!autoUpdateEnabled;
      autoUpdateLabel.textContent = autoUpdateEnabled ? 'Enabled' : 'Disabled';
    }
    function showAccessBlock(title, body) {
      if (!accessBlockModal) return;
      if (accessBlockTitle && title) accessBlockTitle.textContent = title;
      if (accessBlockBody && body) accessBlockBody.textContent = body;
      accessBlockModal.classList.add('show');
    }

    function hideAccessBlock() {
      accessBlockModal?.classList.remove('show');
    }

    function maybeShowAccessBlock() {
      const mtlsRequired = currentOverview?.mtls?.required === true;
      const mtlsPresent = currentOverview?.mtls?.present === true;

      if (mtlsRequired && !mtlsPresent) {
        showAccessBlock('mTLS required', 'Present a valid client certificate to continue.');
        return;
      }

      hideAccessBlock();
    }

    function showInsecureApprovalModal(show) {
      if (!insecureApprovalModal) return;
      if (show) {
        insecureApprovalModal.classList.add('show');
      } else {
        insecureApprovalModal.classList.remove('show');
      }
    }

    function formatApprovalHostname(fqdn, hostId) {
      if (typeof fqdn === 'string' && fqdn.trim() !== '') {
        const trimmed = fqdn.trim();
        const parts = trimmed.split('.');
        return parts[0] || trimmed;
      }
      if (Number.isFinite(hostId) && hostId > 0) {
        return `host-${hostId}`;
      }
      return 'unknown';
    }

    function deriveApprovalDomain(fqdn) {
      if (typeof fqdn !== 'string') return '';
      const trimmed = fqdn.trim().toLowerCase();
      if (!trimmed) return '';
      const parts = trimmed.split('.').filter(Boolean);
      if (parts.length < 3) return '';
      return parts.slice(1).join('.');
    }

    function setInsecureApprovalFields(request) {
      if (!request) return;
      const fqdn = request.fqdn || '';
      const hostId = Number(request.hostId || 0);
      const hostname = formatApprovalHostname(fqdn, hostId);
      if (insecureApprovalHost) {
        insecureApprovalHost.textContent = hostname;
      }
      if (insecureApprovalFqdn) {
        insecureApprovalFqdn.textContent = fqdn || '—';
      }
      const timestamp = request.requestedAt || request.createdAt || '';
      if (insecureApprovalTime) {
        if (timestamp) {
          const absolute = formatTimestamp(timestamp);
          const relative = formatRelative(timestamp);
          insecureApprovalTime.textContent = relative && relative !== '—'
            ? `${absolute} · ${relative}`
            : absolute;
        } else {
          insecureApprovalTime.textContent = '—';
        }
      }
      if (insecureApprovalSubtitle) {
        const command = request.command ? ` (${request.command})` : '';
        insecureApprovalSubtitle.textContent = `Insecure host access request${command}.`;
      }
      if (insecureApprovalAllowDomain) {
        const domain = deriveApprovalDomain(fqdn);
        if (domain) {
          insecureApprovalAllowDomain.style.display = '';
          insecureApprovalAllowDomain.textContent = `Allow domain ${domain}`;
          insecureApprovalAllowDomain.dataset.domain = domain;
        } else {
          insecureApprovalAllowDomain.style.display = 'none';
          insecureApprovalAllowDomain.textContent = 'Allow domain';
          insecureApprovalAllowDomain.dataset.domain = '';
        }
      }
    }

    function presentInsecureApproval(request) {
      activeInsecureApproval = request;
      setInsecureApprovalFields(request);
      showInsecureApprovalModal(true);
    }

    function enqueueInsecureApproval(request) {
      if (!request || !request.id) return;
      if (activeInsecureApproval && activeInsecureApproval.id === request.id) return;
      if (insecureApprovalQueue.some((item) => item.id === request.id)) return;
      insecureApprovalQueue.push(request);
      if (!activeInsecureApproval) {
        const next = insecureApprovalQueue.shift();
        if (next) presentInsecureApproval(next);
      }
    }

    function resolveInsecureApproval(requestId) {
      if (!requestId) return;
      const remaining = [];
      insecureApprovalQueue.forEach((item) => {
        if (item.id !== requestId) remaining.push(item);
      });
      insecureApprovalQueue.length = 0;
      insecureApprovalQueue.push(...remaining);

      if (activeInsecureApproval && activeInsecureApproval.id === requestId) {
        activeInsecureApproval = null;
        showInsecureApprovalModal(false);
        const next = insecureApprovalQueue.shift();
        if (next) presentInsecureApproval(next);
      }
    }

    function setInsecureApprovalButtonsDisabled(disabled) {
      if (insecureApprovalApprove) insecureApprovalApprove.disabled = disabled;
      if (insecureApprovalDeny) insecureApprovalDeny.disabled = disabled;
      if (insecureApprovalAllowDomain) insecureApprovalAllowDomain.disabled = disabled;
    }

    async function approveInsecureApproval() {
      if (!activeInsecureApproval || insecureApprovalBusy) return;
      const requestId = activeInsecureApproval.id;
      insecureApprovalBusy = true;
      setInsecureApprovalButtonsDisabled(true);
      try {
        await api(`/admin/insecure-approvals/${requestId}/approve`, {
          method: 'POST',
          json: { duration_minutes: insecureWindowMinutes },
        });
        toast('Insecure host window enabled', 'ok');
        resolveInsecureApproval(requestId);
      } catch (err) {
        toast(`Enable failed: ${err.message}`, 'error');
      } finally {
        insecureApprovalBusy = false;
        setInsecureApprovalButtonsDisabled(false);
      }
    }

    async function approveInsecureApprovalDomain() {
      if (!activeInsecureApproval || insecureApprovalBusy) return;
      const requestId = activeInsecureApproval.id;
      const domain = insecureApprovalAllowDomain?.dataset?.domain || '';
      if (!domain) {
        toast('Domain unavailable for this host', 'error');
        return;
      }
      insecureApprovalBusy = true;
      setInsecureApprovalButtonsDisabled(true);
      try {
        await api(`/admin/insecure-approvals/${requestId}/allow-domain`, {
          method: 'POST',
          json: { domain, duration_minutes: insecureWindowMinutes },
        });
        toast(`Domain auto-allowed: ${domain}`, 'ok');
        resolveInsecureApproval(requestId);
      } catch (err) {
        toast(`Allow domain failed: ${err.message}`, 'error');
      } finally {
        insecureApprovalBusy = false;
        setInsecureApprovalButtonsDisabled(false);
      }
    }

    async function denyInsecureApproval() {
      if (!activeInsecureApproval || insecureApprovalBusy) return;
      const requestId = activeInsecureApproval.id;
      insecureApprovalBusy = true;
      setInsecureApprovalButtonsDisabled(true);
      try {
        await api(`/admin/insecure-approvals/${requestId}/deny`, { method: 'POST' });
        toast('Insecure host request cancelled', 'ok');
        resolveInsecureApproval(requestId);
      } catch (err) {
        toast(`Cancel failed: ${err.message}`, 'error');
      } finally {
        insecureApprovalBusy = false;
        setInsecureApprovalButtonsDisabled(false);
      }
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

    async function loadReverseDns() {
      if (!reverseDnsToggle) return;
      try {
        const res = await api('/admin/reverse-dns');
        reverseDnsEnabled = !!res?.data?.enabled;
        renderReverseDns();
      } catch (err) {
        console.warn('reverse dns state unavailable', err);
      }
    }

    async function loadInsecureApproval() {
      if (!insecureApprovalToggle) return;
      try {
        const res = await api('/admin/insecure-approval');
        insecureApprovalEnabled = !!res?.data?.enabled;
        renderInsecureApproval();
      } catch (err) {
        console.warn('insecure approval state unavailable', err);
      }
    }

    async function loadAutoUpdate() {
      if (!autoUpdateToggle) return;
      try {
        const res = await api('/admin/auto-update');
        autoUpdateEnabled = !!res?.data?.enabled;
        renderAutoUpdate();
      } catch (err) {
        console.warn('auto-update state unavailable', err);
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
        toast(`cdx silent update failed: ${err.message}`, 'error');
        cdxSilent = previous;
        renderCdxSilent();
      } finally {
        cdxSilentToggle.disabled = false;
      }
    }

    async function setReverseDns(nextValue) {
      if (!reverseDnsToggle) return;
      const previous = reverseDnsEnabled;
      reverseDnsEnabled = !!nextValue;
      renderReverseDns();
      reverseDnsToggle.disabled = true;
      try {
        await api('/admin/reverse-dns', {
          method: 'POST',
          json: { enabled: !!nextValue },
        });
      } catch (err) {
        toast(`Reverse DNS update failed: ${err.message}`, 'error');
        reverseDnsEnabled = previous;
        renderReverseDns();
      } finally {
        reverseDnsToggle.disabled = false;
      }
    }

    async function setInsecureApproval(nextValue) {
      if (!insecureApprovalToggle) return;
      const previous = insecureApprovalEnabled;
      insecureApprovalEnabled = !!nextValue;
      renderInsecureApproval();
      insecureApprovalToggle.disabled = true;
      try {
        await api('/admin/insecure-approval', {
          method: 'POST',
          json: { enabled: !!nextValue },
        });
      } catch (err) {
        toast(`Insecure approval update failed: ${err.message}`, 'error');
        insecureApprovalEnabled = previous;
        renderInsecureApproval();
      } finally {
        insecureApprovalToggle.disabled = false;
      }
    }

    async function setAutoUpdate(nextValue) {
      if (!autoUpdateToggle) return;
      const previous = autoUpdateEnabled;
      autoUpdateEnabled = !!nextValue;
      renderAutoUpdate();
      autoUpdateToggle.disabled = true;
      try {
        await api('/admin/auto-update', {
          method: 'POST',
          json: { enabled: !!nextValue },
        });
      } catch (err) {
        toast(`Auto-update setting failed: ${err.message}`, 'error');
        autoUpdateEnabled = previous;
        renderAutoUpdate();
      } finally {
        autoUpdateToggle.disabled = false;
      }
    }

    function setMtls(meta) {
      mtlsMeta = meta;
      if (window.__navStatus?.setMtls) {
        window.__navStatus.setMtls(meta);
      }
      if (mtlsSettingStatus) {
        let sentence = 'mTLS status unavailable.';
        if (meta) {
          if (meta.enforced) {
            sentence = 'mTLS is enforced; client certificates are required for admin access.';
          } else if (meta.present) {
            sentence = 'mTLS is optional; a client certificate is present for this session.';
          } else {
            sentence = 'mTLS is disabled for admin access.';
          }
        }
        mtlsSettingStatus.textContent = sentence;
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

	    function normalizeCodexVersion(value) {
	      if (typeof value !== 'string') return '';
	      let normalized = value.trim();
	      normalized = normalized.replace(/^(codex-cli|codex|rust-)/i, '');
	      normalized = normalized.replace(/^v/i, '');
	      return normalized;
	    }

	    function isFullCodexRelease(version) {
	      const normalized = normalizeCodexVersion(String(version || ''));
	      if (!normalized) return false;
	      const lower = normalized.toLowerCase();
	      if (lower.includes('alpha') || lower.includes('beta')) return false;
	      // Semver prereleases contain a hyphen (e.g., 0.80.0-rc.1).
	      if (/-[0-9a-z]/i.test(normalized)) return false;
	      return true;
	    }

	    async function fetchRecentCodexReleases(limit = 10) {
	      const now = Date.now();
	      if (cachedCodexReleases.versions && (now - cachedCodexReleases.fetchedAt) < CODEX_RELEASES_CACHE_MS) {
	        return cachedCodexReleases.versions;
	      }

	      const previous = cachedCodexReleases.versions;
	      try {
	        const perPage = Math.min(100, Math.max(limit * 10, 30));
	        const resp = await fetch(`https://api.github.com/repos/openai/codex/releases?per_page=${perPage}`, {
	          headers: { 'Accept': 'application/vnd.github+json' },
	        });
	        if (!resp.ok) {
	          throw new Error(`GitHub ${resp.status}`);
	        }
	        const json = await resp.json();
	        const versions = [];
	        const seen = new Set();
	        if (Array.isArray(json)) {
	          for (const item of json) {
	            if (!item || item.draft || item.prerelease) continue;
	            const raw = item?.tag_name || item?.name || '';
	            const normalized = normalizeCodexVersion(raw);
	            if (!isFullCodexRelease(normalized)) continue;
	            if (seen.has(normalized)) continue;
	            seen.add(normalized);
	            versions.push(normalized);
	            if (versions.length >= limit) break;
	          }
	        }
	        cachedCodexReleases = { fetchedAt: now, versions, error: null };
	        return versions;
	      } catch (err) {
	        cachedCodexReleases = { fetchedAt: now, versions: previous, error: err };
	        return Array.isArray(previous) ? previous : [];
      }
    }

    function renderCodexVersionMeta() {
      if (!codexVersionMeta) return;
      const lock = normalizeCodexVersion(currentOverview?.client_version_lock ?? '');
      const lockAt = currentOverview?.client_version_lock_updated_at ?? null;
      const target = normalizeCodexVersion(currentOverview?.versions?.client_version ?? '');
      const reported = normalizeCodexVersion(currentOverview?.versions?.reported_client_version ?? '');
      const checkedAt = currentOverview?.versions?.client_version_checked_at ?? null;

      if (lock) {
        const at = lockAt ? formatRelative(lockAt) : 'unknown time';
        const extra = reported && reported !== lock ? ` · Reported in use: ${reported}` : '';
        codexVersionMeta.textContent = `Pinned to ${lock} (set ${at})${extra}.`;
        return;
      }
      if (target) {
        const at = checkedAt ? formatRelative(checkedAt) : 'unknown time';
        const extra = reported && reported !== target ? ` · Reported in use: ${reported}` : '';
        codexVersionMeta.textContent = `Latest targeting ${target} (checked ${at})${extra}.`;
        return;
      }
      codexVersionMeta.textContent = 'Latest targeting: unknown (no GitHub version cached yet).';
    }

    async function loadCodexVersionControl() {
      if (!codexVersionSelect) return;

      const lock = normalizeCodexVersion(currentOverview?.client_version_lock ?? '');
      const target = normalizeCodexVersion(currentOverview?.versions?.client_version ?? '');
      const reported = normalizeCodexVersion(currentOverview?.versions?.reported_client_version ?? '');

      const selectedValue = lock || 'latest';

      let recent = [];
      recent = await fetchRecentCodexReleases(10);
      const githubLatest = recent[0] || '';
      const baseOptions = [
        { value: 'latest', label: githubLatest ? `Latest (${githubLatest})` : 'Latest' },
      ];

	      const orderedVersions = Array.from(new Set([
	        ...recent,
	        ...(target && !recent.includes(target) ? [target] : []),
	        ...(reported && !recent.includes(reported) && reported !== target ? [reported] : []),
	        ...(lock && lock !== target && !recent.includes(lock) ? [lock] : []),
	      ].filter(Boolean)));

      codexVersionSelect.innerHTML = '';
      for (const opt of baseOptions) {
        const el = document.createElement('option');
        el.value = opt.value;
        el.textContent = opt.label;
        codexVersionSelect.appendChild(el);
      }

      if (orderedVersions.length) {
        for (const version of orderedVersions) {
          const suffix = [];
          if (version && target && version === target) suffix.push('target');
          if (version && reported && version === reported) suffix.push('in use');
          if (version && lock && version === lock) suffix.push('pinned');
          const label = suffix.length ? `${version} (${suffix.join(', ')})` : version;
          const el = document.createElement('option');
          el.value = version;
          el.textContent = label;
          codexVersionSelect.appendChild(el);
        }
      } else if (target) {
        const el = document.createElement('option');
        el.value = target;
        el.textContent = `${target} (in use)`;
        codexVersionSelect.appendChild(el);
      }

      codexVersionSelect.value = selectedValue;
      renderCodexVersionMeta();
    }

    async function setCodexVersionSelection(selection) {
      if (!codexVersionSelect) return;
      const previous = normalizeCodexVersion(currentOverview?.client_version_lock ?? '') || 'latest';
      codexVersionSelect.disabled = true;
      try {
        await api('/admin/codex-version', {
          method: 'POST',
          json: { selection },
        });
        toast('Codex version policy updated', 'ok');
        await loadAll();
      } catch (err) {
        toast(`Codex version update failed: ${err.message}`, 'error');
        codexVersionSelect.value = previous;
      } finally {
        codexVersionSelect.disabled = false;
      }
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

    function renderVipCrown() {
      return '<span class="vip-crown" title="VIP host: quota hard-fail disabled">👑</span>';
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

    // One-time init guards for lazily loaded panels
    let clientLogsInited = false;
    let mcpLogsInited = false;
    let configInited = false;
    let memoriesInited = false;
    let hostsInited = false;
    let dataLoaded = false;
    let loadAllPromise = null;
    let currentOverview = null;

    window.__initClientLogs = () => {
      if (clientLogsInited) return;
      clientLogsInited = true;
      if (typeof initClientLogs === 'function') initClientLogs();
    };
    window.__initMcpLogs = () => {
      if (mcpLogsInited) return;
      mcpLogsInited = true;
      if (typeof initMcpLogs === 'function') initMcpLogs();
    };
    window.__initConfigBuilder = () => {
      if (configInited) return;
      configInited = true;
      if (typeof initConfigBuilder === 'function') initConfigBuilder();
    };
    window.__initMemoriesOnce = () => {
      if (memoriesInited) return;
      memoriesInited = true;
      loadMemories();
    };

    function renderAgents(doc) {
      currentAgents = doc || null;

      const status = doc?.status || 'missing';
      const updatedAt = doc?.updated_at ? formatTimestamp(doc.updated_at) : 'never';
      const size = Number(doc?.size_bytes);
      const sizeLabel = Number.isFinite(size) ? `${formatNumber(size)} bytes` : '—';
      const mode = typeof doc?.mode === 'string' ? doc.mode : 'latest';
      const servedId = Number.isFinite(Number(doc?.served_id)) ? Number(doc.served_id) : null;
      const latestId = Number.isFinite(Number(doc?.latest_id)) ? Number(doc.latest_id) : null;
      const activeId = Number.isFinite(Number(doc?.active_id)) ? Number(doc.active_id) : null;
      if (agentsStatus) {
        agentsStatus.textContent = status === 'ok'
          ? ''
          : (status === 'missing' ? 'No canonical AGENTS.md stored yet.' : `Status: ${status}`);
      }
      if (agentsMeta) {
        const parts = [];
        parts.push(`updated ${updatedAt}`);
        if (sizeLabel !== '—') parts.push(sizeLabel);
        agentsMeta.textContent = parts.join(' · ');
      }
      if (agentsServeLabel) {
        if (status === 'missing') {
          agentsServeLabel.textContent = 'Serving: none';
        } else if (mode === 'latest') {
          const suffix = latestId ? `v${latestId}` : 'latest';
          agentsServeLabel.textContent = `Serving: latest (${suffix})`;
        } else {
          const suffix = activeId ? `v${activeId}` : 'default';
          agentsServeLabel.textContent = `Serving: default (${suffix})`;
        }
      }
      if (agentsServeLatest) {
        agentsServeLatest.disabled = status === 'missing' || mode === 'latest';
      }

      if (agentsPreview) {
        const text = typeof doc?.content === 'string' ? doc.content : '';
        agentsPreview.textContent = text;
        agentsPreview.classList.toggle('muted', status === 'missing');
      }

      if (agentsEditorInline) {
        const editing = !agentsEditorInline.hidden;
        if (!editing && typeof doc?.content === 'string') {
          agentsEditorInline.value = doc.content;
        }
      }

      if (agentsVersionsBody) {
        const versions = Array.isArray(doc?.versions) ? doc.versions : [];
        const hostCounts = {};
        (Array.isArray(currentHosts) ? currentHosts : []).forEach((host) => {
          const versionId = normalizeAgentsVersionId(host?.agents_document_id_override);
          if (!versionId) return;
          hostCounts[versionId] = (hostCounts[versionId] || 0) + 1;
        });
        if (!versions.length) {
          agentsVersionsBody.innerHTML = '<tr><td class="muted" colspan="6">No versions yet.</td></tr>';
        } else {
          agentsVersionsBody.innerHTML = versions.map((version) => {
            const id = Number(version?.id);
            const sha = typeof version?.sha256 === 'string' ? version.sha256 : '';
            const updated = version?.updated_at ? formatRelative(version.updated_at) : '—';
            const bytes = Number(version?.size_bytes);
            const sizeText = Number.isFinite(bytes) ? `${formatNumber(bytes)} bytes` : '—';
            const hostCount = Number.isFinite(id) ? (hostCounts[id] || 0) : 0;
            const isServed = !!version?.is_served;
            const isLatest = !!version?.is_latest;
            const isActive = !!version?.is_active;
            const statusChips = [];
            if (isServed) statusChips.push('<span class="pill ok">Serving</span>');
            if (!isServed && isActive) statusChips.push('<span class="pill warn">Default</span>');
            if (isLatest) statusChips.push('<span class="pill">Latest</span>');
            const serveLabel = mode === 'latest' ? 'Default' : 'Serve';
            return `
              <tr data-version-id="${Number.isFinite(id) ? id : ''}">
                <td>#${Number.isFinite(id) ? id : '—'}</td>
                <td>${escapeHtml(updated)}</td>
                <td>${escapeHtml(sizeText)}</td>
                <td>${formatNumber(hostCount)}</td>
                <td class="agents-sha">${escapeHtml(sha ? sha.slice(0, 12) : '—')}</td>
                <td class="agents-version-actions">
                  ${statusChips.join(' ')}
                  ${isServed ? '' : `<button class="ghost tiny-btn" data-action="agents-serve" data-version-id="${id}">${serveLabel}</button>`}
                  ${isServed ? '<button class="ghost tiny-btn" disabled>Delete</button>' : `<button class="danger tiny-btn" data-action="agents-delete" data-version-id="${id}">Delete</button>`}
                </td>
              </tr>
            `;
          }).join('');
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

    function resolveResetTarget(seconds, resetAt) {
      const parsed = resetAt ? parseTimestamp(resetAt) : null;
      if (parsed) return parsed.toISOString();
      if (Number.isFinite(seconds)) {
        return new Date(Date.now() + (seconds * 1000)).toISOString();
      }
      return null;
    }

    let usageResetTicker = null;

    function updateUsageResetLabels() {
      if (!chatgptUsageCard) return;
      const lanes = chatgptUsageCard.querySelectorAll('.usage-lane');
      if (!lanes.length) return;
      const now = Date.now();
      lanes.forEach((lane) => {
        const resetAt = lane.dataset.resetAt || null;
        const resetAfterRaw = lane.dataset.resetAfter;
        const resetAfter = resetAfterRaw ? Number(resetAfterRaw) : null;
        const label = formatResetLabel(
          Number.isFinite(resetAfter) ? resetAfter : null,
          resetAt || null
        );
        const resetEl = lane.querySelector('.usage-reset');
        if (resetEl && resetEl.textContent !== label) {
          resetEl.textContent = label;
        }
        const limitSecondsRaw = lane.dataset.limitSeconds;
        const limitSeconds = limitSecondsRaw ? Number(limitSecondsRaw) : null;
        if (Number.isFinite(limitSeconds) && limitSeconds > 0) {
          let targetMs = null;
          if (resetAt) {
            const parsed = parseTimestamp(resetAt);
            if (parsed) targetMs = parsed.getTime();
          }
          if (targetMs === null && Number.isFinite(resetAfter)) {
            targetMs = now + (resetAfter * 1000);
          }
          if (targetMs !== null) {
            const remaining = Math.max(0, (targetMs - now) / 1000);
            const pct = Math.min(100, Math.max(0, Math.round(((limitSeconds - remaining) / limitSeconds) * 100)));
            const meterSpan = lane.querySelector('.meter.time span');
            if (meterSpan) {
              meterSpan.style.width = `${pct}%`;
            }
          }
        }
      });
    }

    function startUsageResetTicker() {
      if (usageResetTicker) return;
      usageResetTicker = window.setInterval(updateUsageResetLabels, 30000);
      updateUsageResetLabels();
    }

    function formatMoney(amount, currency = 'USD') {
      if (!Number.isFinite(amount)) return `${currency} —`;
      return `${currency} ${amount.toFixed(2)}`;
    }

    function hostPruneMeta(host) {
      if (!Number.isFinite(inactivityWindowDays) || inactivityWindowDays <= 0) {
        return { daysLeft: null };
      }
      const last = host?.last_refresh || host?.updated_at || null;
      const lastTs = parseTimestamp(last);
      if (!lastTs) return { daysLeft: null };
      const cutoff = lastTs.getTime() + (inactivityWindowDays * 24 * 60 * 60 * 1000);
      const daysLeft = (cutoff - Date.now()) / 86400000;
      return { daysLeft };
    }

    function normalizeVersionValue(version) {
      if (typeof version !== 'string') return null;
      const normalized = version.trim().replace(/^v/i, '');
      return normalized ? normalized : null;
    }

    function isVersionBehind(version, current) {
      const normalized = normalizeVersionValue(version);
      const target = normalizeVersionValue(current);
      if (!normalized || !target) return false;
      return compareVersions(normalized, target) === -1;
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

    function hostTablePill(host) {
      const secure = isHostSecure(host);
      const { enabledActive, graceActive } = insecureState(host);
      if (!secure && !enabledActive && !graceActive) {
        return { tone: 'warn', label: 'Locked' };
      }
      if (!secure && !enabledActive && graceActive) {
        return { tone: 'warn', label: 'Insecure grace window' };
      }
      const status = (host?.status || '').toLowerCase();
      if (status && status !== 'active') {
        return { tone: 'warn', label: 'Suspended' };
      }
      const { daysLeft } = hostPruneMeta(host);
      if (daysLeft !== null && daysLeft <= 3) {
        return { tone: 'warn', label: 'Pruning soon' };
      }
      if (daysLeft !== null && daysLeft <= 10) {
        return { tone: 'warn', label: 'Pruning soon' };
      }
      const authed = host?.authed === true;
      if (!authed) {
        return { tone: 'warn', label: 'No auth' };
      }
      const clientBehind = isVersionBehind(host.client_version, latestVersions.client);
      const wrapperBehind = isVersionBehind(host.wrapper_version, latestVersions.wrapper);
      if (clientBehind || wrapperBehind) {
        const authOutdated = secure && host.auth_outdated;
        return { tone: authOutdated ? 'warn' : 'ok', label: 'Outdated' };
      }
      if (secure && host.auth_outdated) {
        return { tone: 'warn', label: 'Outdated auth' };
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

    function hostListStatus(host) {
      const status = String(host?.status || '').toLowerCase();
      if (status && status !== 'active') {
        return { label: 'Suspended', tone: 'err', rank: 3 };
      }
      if (host?.authed !== true) {
        return { label: 'Unprovisioned', tone: 'warn', rank: 2 };
      }
      if (!isHostSecure(host)) {
        const { enabledActive, graceActive } = insecureState(host);
        if (!enabledActive && !graceActive) {
          return { label: 'Insecure closed', tone: 'warn', rank: 1 };
        }
      }
      return { label: 'Healthy', tone: 'ok', rank: 0 };
    }

    function applyHostFilters(list) {
      return list.filter(host => {
        if (!hostMatchesStatus(host)) return false;
        if (!hostFilterText) return true;
        const statusLabel = hostListStatus(host).label.toLowerCase();
        const haystacks = [host.fqdn, host.client_version, statusLabel]
          .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''));
        return haystacks.some(text => text.includes(hostFilterText));
      });
    }

    function hostSortValue(host, key) {
      switch (key) {
        case 'host':
          return (host.fqdn || '').toLowerCase();
        case 'status':
          return hostListStatus(host).rank;
        case 'last_seen': {
          const ts = parseTimestamp(host.updated_at);
          return ts ? ts.getTime() : -Infinity;
        }
        case 'client':
          return (host.client_version || '').toLowerCase();
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

    function normalizeReverseDnsMode(mode) {
      if (!mode) return 'global';
      const normalized = String(mode).trim().toLowerCase();
      if (normalized === 'enabled' || normalized === 'disabled' || normalized === 'global') {
        return normalized;
      }
      if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
        return 'enabled';
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
        return 'disabled';
      }
      return 'global';
    }

    function normalizeAgentsVersionId(value) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return Math.trunc(parsed);
    }

    function agentsGlobalLabel(doc) {
      if (!doc || doc.status === 'missing') {
        return 'Default (global - missing)';
      }
      const mode = typeof doc.mode === 'string' ? doc.mode : 'latest';
      const latestId = normalizeAgentsVersionId(doc.latest_id);
      const activeId = normalizeAgentsVersionId(doc.active_id);
      if (mode === 'latest') {
        return `Default (global - latest${latestId ? ` v${latestId}` : ''})`;
      }
      return `Default (global - default${activeId ? ` v${activeId}` : ''})`;
    }

    function buildAgentsVersionOptions(doc, { excludeId = null } = {}) {
      const versions = Array.isArray(doc?.versions) ? doc.versions : [];
      const options = [];
      options.push(`<option value="global">${agentsGlobalLabel(doc)}</option>`);
      versions.forEach((version) => {
        const id = normalizeAgentsVersionId(version?.id);
        if (!id) return;
        if (excludeId && id === excludeId) return;
        const tags = [];
        if (version?.is_served) tags.push('serving');
        if (!version?.is_served && version?.is_active) tags.push('default');
        if (version?.is_latest) tags.push('latest');
        const label = tags.length ? `v${id} (${tags.join(', ')})` : `v${id}`;
        options.push(`<option value="${id}">${label}</option>`);
      });
      return options.join('');
    }

    function isReverseDnsEffective(host) {
      const mode = normalizeReverseDnsMode(host?.reverse_dns_mode);
      if (mode === 'enabled') return true;
      if (mode === 'disabled') return false;
      return !!reverseDnsEnabled;
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
        state: host.allow_roaming_ips ? 'Roaming allowed (any IP)' : 'Locked to first IPv4/IPv6 pair',
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

      const hostAutoUpdateOverride = host.auto_update_override;
      const hostAutoUpdateEffective = hostAutoUpdateOverride !== null && hostAutoUpdateOverride !== undefined
        ? !!hostAutoUpdateOverride
        : autoUpdateEnabled;
      let autoUpdateState = 'Following fleet (' + (autoUpdateEnabled ? 'enabled' : 'disabled') + ')';
      if (hostAutoUpdateOverride === true) autoUpdateState = 'Force enabled (host override)';
      else if (hostAutoUpdateOverride === false) autoUpdateState = 'Force disabled (host override)';
      toggles.push(renderHostToggleRow({
        action: 'auto-update',
        checked: hostAutoUpdateEffective,
        disabled: false,
        title: 'Cron auto-update',
        state: autoUpdateState,
      }));

      const reverseDnsMode = normalizeReverseDnsMode(host?.reverse_dns_mode);
      const reverseDnsEffective = isReverseDnsEffective(host);
      const reverseDnsGlobalLabel = reverseDnsEnabled ? 'Global (enabled)' : 'Global (disabled)';
      const reverseDnsState = reverseDnsMode === 'global'
        ? reverseDnsGlobalLabel
        : (reverseDnsEffective ? 'Enabled (host override)' : 'Disabled (host override)');

      return `
        <div class="host-toggle-list">
          ${toggles.join('')}
        </div>
        <div class="host-agents-version" style="margin-top:12px;">
          <div class="muted" style="font-weight:600; margin-bottom:6px;">Agents.md version</div>
          <div class="inline-group" style="gap:10px; align-items:flex-end;">
            <div class="field" style="min-width:240px;">
              <label for="hostAgentsVersionSelect">Version</label>
              <select id="hostAgentsVersionSelect">
                ${buildAgentsVersionOptions(currentAgents)}
              </select>
            </div>
          </div>
          <div class="muted-note" style="margin-top:6px;">
            Default follows the fleet AGENTS.md setting; choose a version to pin this host.
            <span id="hostAgentsVersionSaveState" class="muted" style="margin-left:10px;"></span>
          </div>
        </div>
        <div class="host-inline-row">
          <div class="host-inline-block">
            <div class="muted" style="font-weight:600; margin-bottom:6px;">Reverse DNS enforcement</div>
            <div class="host-inline-toggle">
              <label class="toggle">
                <input type="checkbox" id="hostReverseDnsToggle" ${reverseDnsEffective ? 'checked' : ''}>
                <span class="track"><span class="thumb"></span></span>
              </label>
              <span class="host-toggle-state">${escapeHtml(reverseDnsState)}</span>
            </div>
            <div class="muted-note" style="margin-top:6px;">
              Effective: ${reverseDnsEffective ? 'Enabled' : 'Disabled'}.
              <span id="hostReverseDnsSaveState" class="muted" style="margin-left:10px;"></span>
            </div>
          </div>
          <div class="host-inline-block">
            <div class="muted" style="font-weight:600; margin-bottom:6px;">Codex CLI version</div>
            <div class="inline-group" style="gap:10px; align-items:flex-end;">
              <div class="field" style="min-width:240px;">
                <label for="hostCodexVersionSelect">Version</label>
                <select id="hostCodexVersionSelect">
                  <option value="global">Global (fleet)</option>
                </select>
              </div>
            </div>
            <div class="muted-note" style="margin-top:6px;">
              “Global” follows the fleet setting; picking a version pins this host and forces upgrade/downgrade on the next run.
              <span id="hostCodexVersionSaveState" class="muted" style="margin-left:10px;"></span>
            </div>
          </div>
        </div>
        <div class="host-model-overrides" style="margin-top:12px;">
          <div class="muted" style="font-weight:600; margin-bottom:6px;">Model &amp; reasoning overrides</div>
          <div class="inline-group" style="gap:10px; align-items:flex-end;">
            <div class="field" style="min-width:240px;">
              <label for="hostModelOverrideSelect">Model</label>
              <select id="hostModelOverrideSelect">
                <option value="">Standard (global)</option>
                <option value="gpt-5.4">gpt-5.4</option>
                <option value="gpt-5.3-codex">gpt-5.3-codex</option>
                <option value="gpt-5.3-codex-spark">gpt-5.3-codex-spark</option>
                <option value="gpt-5.2-codex">gpt-5.2-codex</option>
                <option value="gpt-5.2">gpt-5.2</option>
                <option value="gpt-5.1-codex-max">gpt-5.1-codex-max</option>
                <option value="gpt-5.1-codex-mini">gpt-5.1-codex-mini</option>
              </select>
            </div>
            <div class="field" style="min-width:180px;">
              <label for="hostReasoningEffortSelect">Reasoning effort</label>
              <select id="hostReasoningEffortSelect">
                <option value="">Standard (global)</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh (Extra high)</option>
              </select>
            </div>
          </div>
          <div class="muted-note" style="margin-top:6px;">
            Overrides affect the baked <code>cdx</code> wrapper for this host. “Standard” = use fleet-wide config.
            <span id="hostModelOverrideSaveState" class="muted" style="margin-left:10px;"></span>
          </div>
        </div>
        <div class="host-action-buttons">
          <button class="ghost secondary" data-action="install">Install script</button>
          <button class="ghost" data-action="clear">Clear auth</button>
          <button class="danger" data-action="remove">Remove</button>
        </div>
      `;
    }

    async function bindHostDetailActions(host) {
      if (!hostDetailActions) return;
      hostDetailActions.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.onclick = (ev) => {
          ev.stopPropagation();
          const action = btn.getAttribute('data-action');
          if (action === 'install') {
            regenerateInstaller(host.fqdn, host.id);
          } else if (action === 'clear') {
            if (!confirm(`Clear auth for ${host.fqdn}?`)) return;
            confirmClear(host.id);
          } else if (action === 'remove') {
            if (!confirm(`Remove ${host.fqdn}? This cannot be undone.`)) return;
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
            } else if (action === 'auto-update') {
              await toggleAutoUpdate(host, desired);
            }
          } catch (err) {
            console.error('host toggle failed', { action, err });
            input.checked = !desired;
          } finally {
            input.disabled = false;
          }
        });
      });

      const reverseDnsToggle = hostDetailActions.querySelector('#hostReverseDnsToggle');
      const reverseDnsSaveState = hostDetailActions.querySelector('#hostReverseDnsSaveState');
      if (reverseDnsToggle) {
        reverseDnsToggle.checked = isReverseDnsEffective(host);
        const saveReverseDnsMode = async () => {
          const desired = !!reverseDnsToggle.checked;
          const mode = desired === !!reverseDnsEnabled ? 'global' : (desired ? 'enabled' : 'disabled');
          if (reverseDnsSaveState) reverseDnsSaveState.textContent = 'Saving…';
          reverseDnsToggle.disabled = true;
          try {
            await api(`/admin/hosts/${host.id}/reverse-dns`, {
              method: 'POST',
              json: { mode },
            });
            if (reverseDnsSaveState) reverseDnsSaveState.textContent = 'Saved';
            await loadAll();
          } catch (err) {
            if (reverseDnsSaveState) reverseDnsSaveState.textContent = 'Save failed';
            console.error('save host reverse dns mode failed', err);
          } finally {
            reverseDnsToggle.disabled = false;
            if (reverseDnsSaveState) {
              window.setTimeout(() => {
                if (reverseDnsSaveState.textContent === 'Saved') reverseDnsSaveState.textContent = '';
              }, 1500);
            }
          }
        };

        reverseDnsToggle.addEventListener('change', async (ev) => {
          ev.stopPropagation();
          await saveReverseDnsMode();
        });
      }

      const agentsSelect = hostDetailActions.querySelector('#hostAgentsVersionSelect');
      const agentsSaveState = hostDetailActions.querySelector('#hostAgentsVersionSaveState');
      if (agentsSelect) {
        const overrideId = normalizeAgentsVersionId(host.agents_document_id_override);
        if (overrideId && !Array.from(agentsSelect.options).some(opt => opt.value === String(overrideId))) {
          const missingOption = document.createElement('option');
          missingOption.value = String(overrideId);
          missingOption.textContent = `v${overrideId} (missing)`;
          agentsSelect.appendChild(missingOption);
        }
        agentsSelect.value = overrideId ? String(overrideId) : 'global';

        const saveAgentsOverride = async () => {
          const selection = agentsSelect ? String(agentsSelect.value || 'global') : 'global';
          if (agentsSaveState) agentsSaveState.textContent = 'Saving…';
          if (agentsSelect) agentsSelect.disabled = true;
          try {
            await api(`/admin/hosts/${host.id}/agents-version`, {
              method: 'POST',
              json: { selection },
            });
            if (agentsSaveState) agentsSaveState.textContent = 'Saved';
            await loadAll();
          } catch (err) {
            if (agentsSaveState) agentsSaveState.textContent = 'Save failed';
            console.error('save host agents version override failed', err);
          } finally {
            if (agentsSelect) agentsSelect.disabled = false;
            if (agentsSaveState) {
              window.setTimeout(() => {
                if (agentsSaveState.textContent === 'Saved') agentsSaveState.textContent = '';
              }, 1500);
            }
          }
        };

        agentsSelect.addEventListener('change', async (ev) => {
          ev.stopPropagation();
          await saveAgentsOverride();
        });
      }

      const codexSelect = hostDetailActions.querySelector('#hostCodexVersionSelect');
      const codexSaveState = hostDetailActions.querySelector('#hostCodexVersionSaveState');
      if (codexSelect) {
        const override = normalizeCodexVersion(host.client_version_override || '');
        const target = normalizeCodexVersion(currentOverview?.versions?.client_version ?? '');
        const hostReported = normalizeCodexVersion(host.client_version || '');
        codexSelect.disabled = true;
        try {
          const recent = await fetchRecentCodexReleases(10);
          const githubLatest = recent[0] || '';
	          const orderedVersions = Array.from(new Set([
	            ...recent,
	            ...(target && !recent.includes(target) ? [target] : []),
	            ...(hostReported && !recent.includes(hostReported) && hostReported !== target ? [hostReported] : []),
	            ...(override && !recent.includes(override) && override !== target && override !== hostReported ? [override] : []),
	          ].filter(Boolean)));

          codexSelect.innerHTML = '';
          const globalLabel = target ? `Global (fleet · ${target})` : 'Global (fleet)';
          const globalOpt = document.createElement('option');
          globalOpt.value = 'global';
          globalOpt.textContent = globalLabel;
          codexSelect.appendChild(globalOpt);

          for (const version of orderedVersions) {
            const suffix = [];
            if (githubLatest && version === githubLatest) suffix.push('latest');
            if (target && version === target) suffix.push('fleet');
            if (hostReported && version === hostReported) suffix.push('host');
            if (override && version === override) suffix.push('pinned');
            const label = suffix.length ? `${version} (${suffix.join(', ')})` : version;
            const el = document.createElement('option');
            el.value = version;
            el.textContent = label;
            codexSelect.appendChild(el);
          }
        } catch (err) {
          console.warn('Unable to load Codex releases for host override', err);
        } finally {
          codexSelect.disabled = false;
          codexSelect.value = override || 'global';
        }

        const saveCodexOverride = async () => {
          const selection = codexSelect ? String(codexSelect.value || 'global') : 'global';
          if (codexSaveState) codexSaveState.textContent = 'Saving…';
          if (codexSelect) codexSelect.disabled = true;
          try {
            await api(`/admin/hosts/${host.id}/codex-version`, {
              method: 'POST',
              json: { selection },
            });
            if (codexSaveState) codexSaveState.textContent = 'Saved';
            await loadAll();
          } catch (err) {
            if (codexSaveState) codexSaveState.textContent = 'Save failed';
            console.error('save host codex version override failed', err);
          } finally {
            if (codexSelect) codexSelect.disabled = false;
            if (codexSaveState) {
              window.setTimeout(() => {
                if (codexSaveState.textContent === 'Saved') codexSaveState.textContent = '';
              }, 1500);
            }
          }
        };

        codexSelect.addEventListener('change', async (ev) => {
          ev.stopPropagation();
          await saveCodexOverride();
        });
      }

      const modelSelect = hostDetailActions.querySelector('#hostModelOverrideSelect');
      const effortSelect = hostDetailActions.querySelector('#hostReasoningEffortSelect');
      const saveState = hostDetailActions.querySelector('#hostModelOverrideSaveState');
      if (modelSelect) {
        modelSelect.value = (host.model_override || '').trim();
      }
      const initialEffort = (host.reasoning_effort_override || '').trim();
      rebuildHostReasoningOptions(effortSelect, modelSelect ? modelSelect.value : '', initialEffort);
      const saveOverrides = async () => {
        const modelVal = modelSelect ? String(modelSelect.value || '') : '';
        const effortVal = effortSelect ? String(effortSelect.value || '') : '';
        if (saveState) saveState.textContent = 'Saving…';
        if (modelSelect) modelSelect.disabled = true;
        if (effortSelect) effortSelect.disabled = true;
        try {
          await api(`/admin/hosts/${host.id}/model`, {
            method: 'POST',
            json: {
              model_override: modelVal === '' ? null : modelVal,
              reasoning_effort_override: effortVal === '' ? null : effortVal,
            },
          });
          if (saveState) saveState.textContent = 'Saved';
          await loadAll();
        } catch (err) {
          if (saveState) saveState.textContent = 'Save failed';
          console.error('save host model overrides failed', err);
        } finally {
          if (modelSelect) modelSelect.disabled = false;
          if (effortSelect) effortSelect.disabled = false;
          if (saveState) {
            window.setTimeout(() => {
              if (saveState.textContent === 'Saved') saveState.textContent = '';
            }, 1500);
          }
        }
      };

      if (modelSelect) {
        modelSelect.addEventListener('change', async (ev) => {
          ev.stopPropagation();
          rebuildHostReasoningOptions(effortSelect, modelSelect.value, effortSelect ? effortSelect.value : '');
          await saveOverrides();
        });
      }
      if (effortSelect) {
        effortSelect.addEventListener('change', async (ev) => {
          ev.stopPropagation();
          await saveOverrides();
        });
      }
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
      const primaryIp = host.ip4 ?? host.ip6 ?? null;
      const secondaryIp = host.ip4 && host.ip6 ? host.ip6 : null;
      const rows = [
        {
          key: 'Status',
          value: `${renderStatusPill(host.status)} ${securityChip} ${insecureStatus}`,
          desc: 'Host entry state; suspended hosts cannot authenticate. Insecure hosts purge auth.json after each run.',
        },
        { key: 'Health', value: `<span class="chip ${health.tone === 'ok' ? 'ok' : 'warn'}">${health.label}</span>`, desc: healthDesc },
        { key: 'Last seen', value: `${formatRelativeWithTimestamp(host.updated_at)}${apiCallsLabel}`, desc: 'Timestamp of the most recent API call from this host.' },
        { key: 'Auth refresh', value: formatRelativeWithTimestamp(host.last_refresh), desc: 'When auth.json was last uploaded or fetched.' },
        { key: 'Last cron check', value: host.last_cron_check ? formatRelativeWithTimestamp(host.last_cron_check) : 'Never', desc: 'Last time the cron auto-update checked in.' },
        {
          key: 'IP binding',
          value: `
            <div class="kv-stack">
              <div class="kv-rowline">
                ${primaryIp ? `<code>${escapeHtml(primaryIp)}</code>` : 'Not yet bound'}
                <span class="chip ${host.allow_roaming_ips ? 'warn' : 'ok'}">${host.allow_roaming_ips ? 'Roaming enabled' : 'IP locked'}</span>
                ${ipv4Chip}
              </div>
              ${secondaryIp ? `
                <div class="kv-rowline" style="margin-top:4px;">
                  <span class="muted">Secondary</span>
                  <code>${escapeHtml(secondaryIp)}</code>
                </div>
              ` : ''}
            </div>
          `,
          desc: host.allow_roaming_ips
            ? 'Roaming enabled; host may authenticate from any IP.'
            : 'First IPv4 and IPv6 callers are locked; toggle roaming to permit moves.',
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

      const agentsOverrideId = normalizeAgentsVersionId(host.agents_document_id_override);
      let agentsLabel = agentsGlobalLabel(currentAgents);
      if (agentsOverrideId) {
        agentsLabel = `Default v${agentsOverrideId}`;
      }
      rows.push({
        key: 'Agents.md',
        value: `<span class="muted">${escapeHtml(agentsLabel)}</span>`,
        desc: 'Default follows the fleet AGENTS.md mode; pin to serve a specific version to this host.',
        full: true,
      });

      const modelOverride = (host.model_override || '').trim();
      const reasoningOverride = (host.reasoning_effort_override || '').trim();
      rows.push({
        key: 'Model overrides',
        value: `
          <div class="kv-stack">
            <div class="kv-rowline">
              <span class="muted">Model</span>
              ${modelOverride ? `<code>${escapeHtml(modelOverride)}</code>` : '<span class="muted">Standard (global)</span>'}
            </div>
            <div class="kv-rowline" style="margin-top:4px;">
              <span class="muted">Reasoning effort</span>
              ${reasoningOverride ? `<code>${escapeHtml(reasoningOverride)}</code>` : '<span class="muted">Standard (global)</span>'}
            </div>
          </div>
        `,
        desc: 'Optional per-host model + reasoning-effort overrides. “Standard” means use fleet-wide config.',
        full: true,
      });

      return rows;
    }

    function isHostDetailView() {
      return (document.body?.dataset?.viewMode || '').toLowerCase() === 'host-detail';
    }

    function clearHostDetailContent() {
      if (hostDetailGrid) hostDetailGrid.innerHTML = '';
      if (hostDetailSummary) hostDetailSummary.innerHTML = '';
      if (hostDetailPills) hostDetailPills.innerHTML = '';
      if (hostDetailActions) hostDetailActions.innerHTML = '';
      if (hostDetailProblems) {
        hostDetailProblems.innerHTML = '';
        hostDetailProblems.hidden = true;
      }
      if (hostDetailProblemsEmpty) {
        hostDetailProblemsEmpty.hidden = false;
      }
    }

    function showHostDetailEmpty(title, body) {
      if (hostDetailLayout) {
        hostDetailLayout.hidden = true;
      }
      if (hostDetailEmptyState) {
        hostDetailEmptyState.hidden = false;
      }
      if (hostDetailEmptyTitle) {
        hostDetailEmptyTitle.textContent = title;
      }
      if (hostDetailEmptyBody) {
        hostDetailEmptyBody.textContent = body;
      }
    }

    function showHostDetailContent() {
      if (hostDetailEmptyState) {
        hostDetailEmptyState.hidden = true;
      }
      if (hostDetailLayout) {
        hostDetailLayout.hidden = false;
      }
    }

    function hostProblems(host) {
      const issues = [];
      const secure = isHostSecure(host);
      const status = String(host?.status || '').toLowerCase();
      const authed = host?.authed === true;
      const { enabledActive, graceActive } = insecureState(host);

      if (status && status !== 'active') {
        issues.push({ tone: 'err', title: 'Suspended', body: 'Host cannot authenticate while suspended.' });
      }
      if (!authed) {
        issues.push({ tone: 'warn', title: 'Not provisioned', body: 'Host has not stored canonical auth yet.' });
      }
      if (!secure && !enabledActive && !graceActive) {
        issues.push({ tone: 'warn', title: 'Insecure window closed', body: 'Open the insecure API window to allow /auth.' });
      }
      if (secure && host?.auth_outdated) {
        issues.push({ tone: 'warn', title: 'Outdated auth', body: 'Host has an older digest than canonical.' });
      }
      if (isVersionBehind(host?.client_version, latestVersions.client) || isVersionBehind(host?.wrapper_version, latestVersions.wrapper)) {
        issues.push({ tone: 'warn', title: 'Outdated versions', body: 'Client and/or wrapper is behind the fleet latest.' });
      }
      if (runnerSummary?.enabled && runnerSummary?.latest_validation) {
        const st = String(runnerSummary.latest_validation.status || '').toLowerCase();
        if (st && st !== 'ok') {
          issues.push({ tone: 'warn', title: 'Runner not OK', body: `Latest runner validation: ${runnerSummary.latest_validation.status}` });
        }
      }

      return issues;
    }

    function renderHostProblems(host) {
      if (!hostDetailProblems) return;
      const issues = hostProblems(host);
      if (!issues.length) {
        hostDetailProblems.innerHTML = '';
        hostDetailProblems.hidden = true;
        if (hostDetailProblemsEmpty) {
          hostDetailProblemsEmpty.hidden = false;
        }
        return;
      }
      if (hostDetailProblemsEmpty) {
        hostDetailProblemsEmpty.hidden = true;
      }
      hostDetailProblems.hidden = false;
      hostDetailProblems.innerHTML = `
        <div class="problems-head">
          <div class="problems-title">Problems</div>
          <div class="muted problems-sub">Only shown when something needs attention.</div>
        </div>
        <div class="problems-grid">
          ${issues.map((it) => `
            <div class="problem ${it.tone}">
              <div class="problem-title">${escapeHtml(it.title)}</div>
              <div class="problem-body">${escapeHtml(it.body)}</div>
            </div>
          `).join('')}
        </div>
      `;
    }

    function renderHostDetail(host) {
      if (!host) return;
      activeHostId = host.id;
      if (document.body) {
        document.body.dataset.hostId = String(host.id);
      }
      showHostDetailContent();
      if (hostDetailTitle) {
        hostDetailTitle.textContent = host.fqdn || `Host #${host.id}`;
      }
      if (hostDetailBack) {
        hostDetailBack.setAttribute('href', '/admin/hosts');
      }
      if (hostDetailPills) {
        const pills = [];
        if (host.vip) {
          pills.push(renderVipCrown());
        }
        if (isHostSecure(host) && host.auth_outdated) {
          pills.push('<span class="chip warn">Outdated auth</span>');
        }
        if (!isHostSecure(host)) {
          pills.push('<span class="chip warn">Insecure</span>');
        }
        hostDetailPills.innerHTML = pills.join('');
      }
      renderHostProblems(host);
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
    }

    function renderActiveHostDetail() {
      if (!isHostDetailView()) return;
      if (!activeHostId) {
        if (hostDetailTitle) {
          hostDetailTitle.textContent = 'Unknown host';
        }
        clearHostDetailContent();
        showHostDetailEmpty('Host not found', 'This host link is invalid.');
        return;
      }
      if (!dataLoaded) {
        if (hostDetailTitle) {
          hostDetailTitle.textContent = `Host #${activeHostId}`;
        }
        clearHostDetailContent();
        showHostDetailEmpty('Loading host…', 'Fetching host details.');
        return;
      }
      const host = currentHosts.find((entry) => entry.id === activeHostId);
      if (!host) {
        if (hostDetailTitle) {
          hostDetailTitle.textContent = `Host #${activeHostId}`;
        }
        clearHostDetailContent();
        showHostDetailEmpty('Host not found', 'This host was deleted or is no longer visible.');
        return;
      }
      renderHostDetail(host);
    }

    function openHostDetail(hostId) {
      const numericId = Number(hostId);
      if (!Number.isFinite(numericId) || numericId <= 0) return;
      window.location.assign(`/admin/hosts/${Math.trunc(numericId)}`);
    }

    function isInsecureActive(host) {
      const state = insecureState(host);
      return state.enabledActive || state.graceActive;
    }

    function createHostRow(host) {
      const tr = document.createElement('tr');
      const isSecure = isHostSecure(host);
      const authSourceMarker = host.auth_source
        ? '<span class="host-auth-source" title="Current canonical auth.json source host" aria-label="Current canonical auth.json source host">🍪</span>'
        : '';
      const insecureStateNow = insecureState(host);
      const minutesActive = countdownMinutes(host.insecure_enabled_until);
      const minutesGrace = countdownMinutes(host.insecure_grace_until);
      let insecureLabel = 'Open insecure window';
      if (!isSecure && insecureStateNow.enabledActive) {
        insecureLabel = `Close insecure window (${minutesActive ?? 0} min left)`;
      } else if (!isSecure && insecureStateNow.graceActive) {
        const graceText = minutesGrace !== null ? `${minutesGrace} min` : 'grace';
        insecureLabel = `Open insecure window (${graceText} left in grace)`;
      }
      const status = hostListStatus(host);
      const statusChip = `<span class="chip ${status.tone}">${status.label}</span>`;
      const lastSeenText = host.updated_at ? formatRelative(host.updated_at) : 'Never';
      tr.classList.add('host-row');
      tr.setAttribute('data-id', host.id);
      tr.tabIndex = 0;
      const insecureToggleCell = isSecure
        ? '<span class="muted">—</span>'
        : `
            <label class="toggle insecure-inline-toggle" data-id="${host.id}" title="${insecureLabel}">
              <input type="checkbox" ${insecureStateNow.enabledActive ? 'checked' : ''} aria-label="${insecureLabel}">
              <span class="track"><span class="thumb"></span></span>
            </label>
          `;
      tr.innerHTML = `
        <td data-label="Host">
          <strong class="host-primary">${escapeHtml(host.fqdn || `Host #${host.id}`)}${authSourceMarker}</strong>
        </td>
        <td data-label="Status" class="status-cell">${statusChip}</td>
        <td data-label="Last Seen"><span class="host-secondary">${escapeHtml(lastSeenText)}</span></td>
        <td data-label="Codex">${renderVersionTag(host.client_version, latestVersions.client)}</td>
        <td class="actions-cell insecure-cell" data-label="Insecure Window">${insecureToggleCell}</td>
      `;
      tr.addEventListener('click', () => openHostDetail(host.id));
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openHostDetail(host.id);
        }
      });
      const insecureToggle = tr.querySelector('.insecure-inline-toggle input');
      if (insecureToggle) {
        insecureToggle.addEventListener('click', (ev) => ev.stopPropagation());
        insecureToggle.addEventListener('change', (ev) => {
          ev.stopPropagation();
          const targetId = Number(insecureToggle.closest('.insecure-inline-toggle')?.getAttribute('data-id'));
          const targetHost = currentHosts.find(h => h.id === targetId);
          if (targetHost) {
            toggleInsecureApi(targetHost, insecureToggle);
          }
        });
      }
      return tr;
    }

    function paintHosts() {
      if (!Array.isArray(currentHosts)) return;
      const filtered = applyHostFilters(currentHosts);

      hostsTbody.innerHTML = '';
      const cols = 5;
      if (!filtered.length) {
        hostsTbody.innerHTML = `<tr class="empty-row"><td colspan="${cols}">No hosts match your filters yet.</td></tr>`;
        updateSortIndicators();
        return;
      }

      const sorted = sortHosts(filtered);
      sorted.forEach((host) => hostsTbody.appendChild(createHostRow(host)));
      updateSortIndicators();
    }

    function renderHosts(hosts) {
      currentHosts = Array.isArray(hosts) ? hosts : [];
      updateHostTabVisibility(currentHosts);
      // Populate upload host select
      if (uploadHostSelect) {
        uploadHostSelect.innerHTML = '<option value="system">System (no host attribution)</option>' + currentHosts.map(h => `<option value="${h.id}">${escapeHtml(h.fqdn)}</option>`).join('');
        uploadHostSelect.value = 'system';
      }
      setMemoriesHostOptions();
      if (isHostDetailView()) {
        renderActiveHostDetail();
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
        promptsTbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:14px;">No slash commands stored</td></tr>`;
        return;
      }
      promptsTbody.innerHTML = currentPrompts.map((p) => {
        const desc = (p.description || '').replace(/</g, '&lt;');
        const retired = p.deleted_at ? '<span class="muted">(retired)</span>' : '';
        return `<tr>
          <td data-label="Filename"><code>${p.filename}</code> ${retired}</td>
          <td data-label="Description">${desc || '—'}</td>
          <td data-label="Argument">${(p.argument_hint || '').replace(/</g, '&lt;') || '—'}</td>
          <td data-label="Actions">
            <div class="table-actions">
              <button class="ghost tiny-btn prompt-edit" data-filename="${p.filename}">Edit</button>
              <button class="ghost tiny-btn danger prompt-delete" data-filename="${p.filename}" ${p.deleted_at ? 'disabled' : ''}>Retire</button>
            </div>
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

    function renderSkills(skills) {
      currentSkills = Array.isArray(skills) ? skills : [];
      if (!skillsTbody) return;
      if (currentSkills.length === 0) {
        skillsTbody.innerHTML = `<tr><td colspan="4" class="muted" style="padding:14px;">No skills stored</td></tr>`;
        return;
      }

      skillsTbody.innerHTML = currentSkills.map((skill) => {
        const retired = skill.deleted_at ? '<span class="muted">(retired)</span>' : '';
        const managed = skill.managed ? '<span class="muted">(managed)</span>' : '';
        const managedDisabled = skill.managed ? 'disabled title="Managed by the Projects module"' : '';
        return `<tr>
          <td data-label="Slug"><code>${skill.slug}</code> ${retired} ${managed}</td>
          <td data-label="Display name">${(skill.display_name || '—').replace(/</g, '&lt;')}</td>
          <td data-label="Description">${(skill.description || '—').replace(/</g, '&lt;')}</td>
          <td data-label="Actions">
            <div class="table-actions">
              <button class="ghost tiny-btn skill-edit" data-slug="${skill.slug}" ${managedDisabled}>Edit</button>
              <button class="ghost tiny-btn danger skill-delete" data-slug="${skill.slug}" ${skill.deleted_at ? 'disabled' : managedDisabled}>Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      skillsTbody.querySelectorAll('.skill-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slug = btn.getAttribute('data-slug');
          openSkillModal(slug);
        });
      });
      skillsTbody.querySelectorAll('.skill-delete').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slug = btn.getAttribute('data-slug');
          deleteSkill(slug);
        });
      });
    }

    function slugifySkillSource(value) {
      return (value || '')
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63);
    }

    function maybeAutofillSkillSlug({ force = false } = {}) {
      if (!skillNameInput || !skillSlug) return;
      const suggestion = slugifySkillSource(skillNameInput.value);
      if (!suggestion) {
        if (force && !skillSlug.value.trim()) {
          skillSlug.value = 'skill';
        }
        return;
      }
      if (!force && !skillSlugAutofill && skillSlug.value.trim()) {
        return;
      }
      skillSlug.value = suggestion;
    }

    function setSkillModalMode(mode, slugLabel = '') {
      const isEdit = mode === 'edit';
      skillModalMode = isEdit ? 'edit' : 'new';
      if (!isEdit) {
        skillEditingSlug = '';
      }
      if (skillModalTitle) {
        skillModalTitle.textContent = isEdit ? 'Edit skill' : 'New skill';
      }
      if (skillModalSubtitle) {
        skillModalSubtitle.textContent = isEdit
          ? `Updating ${slugLabel || 'this skill'} in cdx and refreshing the synced fallback copy on every host.`
          : 'cdx is the primary skill source; hosts also get a synced ~/.agents/skills fallback copy.';
      }
      if (skillSave) {
        skillSave.textContent = isEdit ? 'Save changes' : 'Save';
      }
      if (skillSlug) {
        skillSlug.readOnly = isEdit;
        skillSlug.setAttribute('aria-readonly', isEdit ? 'true' : 'false');
      }
      if (skillSlugSuggest) {
        skillSlugSuggest.hidden = isEdit;
      }
      if (skillDelete) {
        skillDelete.hidden = !isEdit;
      }
      if (skillSlugNote) {
        skillSlugNote.innerHTML = isEdit
          ? 'Slug is locked during edit. Use <strong>New</strong> to create a separate skill.'
          : 'cdx serves this skill canonically; hosts also sync <code>~/.agents/skills/&lt;slug&gt;/SKILL.md</code> as the fallback copy.';
      }
    }

    function setSkillBadges(meta) {
      const sha = meta?.sha256 || '';
      const updatedAt = meta?.updated_at || '';
      if (skillDigestBadge) {
        if (sha) {
          skillDigestBadge.hidden = false;
          skillDigestBadge.textContent = `SHA ${sha}`;
        } else {
          skillDigestBadge.hidden = true;
        }
      }
      if (skillUpdatedBadge) {
        if (updatedAt) {
          skillUpdatedBadge.hidden = false;
          skillUpdatedBadge.textContent = `Updated ${formatTimestamp(updatedAt)}`;
        } else {
          skillUpdatedBadge.hidden = true;
        }
      }
    }

    function setSkillTags(tags) {
      skillTags = Array.isArray(tags)
        ? tags.map((tag) => (typeof tag === 'string' ? tag.trim() : '')).filter((tag) => tag.length > 0)
        : [];
      renderSkillTags();
    }

    function addSkillTag(tag) {
      const normalized = (tag || '').trim();
      if (!normalized) return;
      if (!skillTags.includes(normalized)) {
        skillTags.push(normalized);
        renderSkillTags();
      }
    }

    function removeSkillTag(index) {
      if (!Array.isArray(skillTags) || index < 0 || index >= skillTags.length) return;
      skillTags.splice(index, 1);
      renderSkillTags();
    }

    function renderSkillTags() {
      if (!skillTagsList) return;
      if (!skillTags.length) {
        skillTagsList.innerHTML = '<span class="muted">No tags yet</span>';
        return;
      }
      skillTagsList.innerHTML = skillTags.map((tag, idx) => `
        <span class="skill-tag">
          ${escapeHtml(tag)}
          <button type="button" data-tag-index="${idx}" aria-label="Remove tag ${escapeHtml(tag)}">×</button>
        </span>
      `).join('');
      skillTagsList.querySelectorAll('button[data-tag-index]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const index = Number(btn.getAttribute('data-tag-index'));
          removeSkillTag(Number.isFinite(index) ? index : -1);
        });
      });
    }

    function commitSkillTagInput() {
      if (!skillTagsInput) return;
      const value = skillTagsInput.value.trim();
      if (!value) return;
      addSkillTag(value);
      skillTagsInput.value = '';
    }

    function parseSkillManifest(manifest) {
      const result = {
        name: '',
        description: '',
        tags: [],
        sections: {
          what: '',
          when: '',
          steps: '',
        },
      };
      if (typeof manifest !== 'string' || manifest.trim() === '') {
        return result;
      }
      const trimmed = manifest.replace(/\r\n/g, '\n').trim();
      const fmMatch = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*/);
      let body = trimmed;
      if (fmMatch) {
        const frontMatter = parseSkillFrontMatter(fmMatch[1]);
        result.name = frontMatter.name || '';
        result.description = frontMatter.description || '';
        if (Array.isArray(frontMatter.tags)) {
          result.tags = frontMatter.tags;
        }
        body = trimmed.slice(fmMatch[0].length);
      }
      const sections = parseSkillSections(body);
      result.sections = sections;
      return result;
    }

    function parseSkillFrontMatter(text) {
      const data = {};
      let currentKey = null;
      text.split('\n').forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if ((trimmed.startsWith('- ') || trimmed.startsWith('* ')) && currentKey) {
          const value = trimmed.replace(/^[-*]\s*/, '');
          if (!Array.isArray(data[currentKey])) data[currentKey] = [];
          data[currentKey].push(stripYamlQuotes(value));
          return;
        }
        if (trimmed.startsWith('#')) return;
        const separator = line.indexOf(':');
        if (separator === -1) return;
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();
        currentKey = key;
        if (value === '') {
          data[key] = [];
        } else {
          data[key] = stripYamlQuotes(value);
        }
      });
      return data;
    }

    function stripYamlQuotes(value) {
      if (typeof value !== 'string') return value;
      const trimmed = value.trim();
      if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1).replace(/\\(["'])/g, '$1');
      }
      return trimmed;
    }

    function parseSkillSections(body) {
      const sections = {
        what: '',
        when: '',
        steps: '',
      };
      const headings = [
        { key: 'what', label: '# What this skill does' },
        { key: 'when', label: '## When to use this skill' },
        { key: 'steps', label: '## Step-by-Step Instructions' },
      ];
      const normalized = body.replace(/\r\n/g, '\n');
      headings.forEach((heading, index) => {
        const startIdx = normalized.indexOf(heading.label);
        if (startIdx === -1) return;
        const contentStart = startIdx + heading.label.length;
        let contentEnd = normalized.length;
        for (let i = index + 1; i < headings.length; i += 1) {
          const nextIdx = normalized.indexOf(headings[i].label, contentStart);
          if (nextIdx !== -1 && nextIdx < contentEnd) {
            contentEnd = nextIdx;
            break;
          }
        }
        const sectionBody = normalized.slice(contentStart, contentEnd).trim();
        sections[heading.key] = sectionBody;
      });
      return sections;
    }

    function buildSkillManifestFromFields() {
      const name = (skillNameInput?.value || '').trim();
      const description = (skillDescriptionInput?.value || '').trim();
      const tags = Array.isArray(skillTags) ? skillTags : [];
      const what = normalizeSkillSection(skillWhatInput?.value);
      const when = normalizeSkillSection(skillWhenInput?.value);
      const steps = normalizeSkillSection(skillStepsInput?.value);

      const lines = ['---'];
      if (name) lines.push(`name: ${quoteYaml(name)}`);
      if (description) lines.push(`description: ${quoteYaml(description)}`);
      if (tags.length) {
        lines.push('tags:');
        tags.forEach((tag) => lines.push(`  - ${quoteYaml(tag)}`));
      }
      lines.push('---', '');
      lines.push('# What this skill does', '', what || '');
      lines.push('', '## When to use this skill', '', when || '');
      lines.push('', '## Step-by-Step Instructions', '', steps || '');
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    function normalizeSkillSection(value) {
      if (typeof value !== 'string') return '';
      return value.replace(/\r\n/g, '\n').trim();
    }

    function quoteYaml(value, wrap = true) {
      const sanitized = String(value).replace(/"/g, '\\"');
      return wrap ? `"${sanitized}"` : sanitized;
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
      const memoriesEmptyState = document.getElementById('memoriesEmptyState');
      if (currentMemories.length === 0) {
        memoriesTableBody.innerHTML = '';
        if (memoriesEmptyState) memoriesEmptyState.hidden = false;
        if (memoriesTableWrap) memoriesTableWrap.hidden = true;
        return;
      }
      if (memoriesEmptyState) memoriesEmptyState.hidden = true;
      if (memoriesTableWrap) memoriesTableWrap.hidden = false;

      memoriesTableBody.innerHTML = currentMemories.map((row) => {
        const memoryKey = row.id || '—';
        const recordId = Number.isFinite(row.record_id) ? row.record_id : null;
        const content = clipText(row.content || '', 180).replace(/</g, '&lt;');
        const updated = row.updated_at ? formatTimestamp(row.updated_at) : '—';
        const tags = Array.isArray(row.tags) && row.tags.length
          ? row.tags.map(t => `<span class="tag-badge">${escapeHtml(t)}</span>`).join('')
          : '—';
        const hostLabel = row.host ? `<span class="memories-host">${escapeHtml(row.host)}</span>` : '';
        const keyLabel = memoryKey && memoryKey !== '—' ? `<code class="memories-key">${escapeHtml(memoryKey)}</code>` : '';
        const metaParts = [hostLabel, keyLabel].filter(Boolean).join(' · ');
        const deleteTitle = recordId === null ? 'Delete unavailable (missing record id)' : `Delete memory ${memoryKey}`;
        const deleteButton = `<button class="ghost tiny-btn danger memories-delete"
          title="${deleteTitle}"
          data-memory-key="${escapeHtml(memoryKey)}"
          ${recordId === null ? 'disabled' : `data-delete-record-id="${recordId}"`}
        >Delete</button>`;
        const meta = `<div class="muted memories-meta">
          <span class="memories-meta-left">${metaParts}</span>
          ${deleteButton}
        </div>`;

        return `<tr>
          <td data-label="Content">${content || '—'}${meta}</td>
          <td data-label="Tags">${tags}</td>
          <td data-label="Updated">${updated}</td>
        </tr>`;
      }).join('');

      memoriesTableBody.querySelectorAll('button[data-delete-record-id]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.preventDefault();
          const recordId = btn.getAttribute('data-delete-record-id');
          const memoryKey = btn.getAttribute('data-memory-key') || recordId;
          const label = memoryKey ? `memory ${memoryKey}` : `record #${recordId}`;
          if (!recordId || !confirm(`Delete ${label}? This cannot be undone.`)) return;
          try {
            btn.disabled = true;
            await api(`/admin/mcp/memories/${encodeURIComponent(recordId)}`, 'DELETE');
            await loadMemories();
          } catch (err) {
            alert(err.message || 'Delete failed');
            btn.disabled = false;
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
      const memoriesEmptyState = document.getElementById('memoriesEmptyState');

      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (hostId) params.set('host_id', hostId);
      if (tags.length) params.set('tags', tags.join(','));
      params.set('limit', String(limit));

      memoriesLoading = true;
      try {
        const res = await api(`/admin/mcp/memories?${params.toString()}`);
        renderMemories(res?.data?.matches || []);
      } catch (err) {
        console.error('memories', err);
        if (memoriesTableBody) {
          memoriesTableBody.innerHTML = `<tr><td colspan="3" class="muted" style="padding:12px;">Error: ${escapeHtml(err.message)}</td></tr>`;
        }
        if (memoriesEmptyState) memoriesEmptyState.hidden = true;
      } finally {
        memoriesLoading = false;
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
      const canonicalAuth = info.canonical_auth || null;
      const canonicalSource = canonicalAuth?.source_host || null;
      const canonicalSourceLabel = escapeHtml(
        canonicalSource?.fqdn
          || (canonicalAuth ? (canonicalAuth.source_host_id ? `host #${canonicalAuth.source_host_id}` : 'system') : '—')
      );
      const canonicalStoredWhen = canonicalAuth?.created_at ? formatRelative(canonicalAuth.created_at) : null;
      const lastRun = hasValidation ? validationWhen : (info.enabled ? 'No runs yet' : '—');
      const statusLabel = (hasValidation ? validationStatus : (info.enabled ? 'VALID' : 'DISABLED')).toString().toUpperCase();
      return `
        <div class="card runner-card">
          <div class="stat-head">
            <span class="stat-label">Validation Service</span>
          </div>
          <div class="stat-value">${statusLabel}</div>
          <small class="muted">Timeout ${info.timeout_seconds ?? '—'}s, Last run ${lastRun}${validationLatency ? ` · ${validationLatency}` : ''}</small>
          <small class="muted">Auth source ${canonicalSourceLabel}${canonicalStoredWhen ? ` · stored ${canonicalStoredWhen}` : ''}</small>
          <div class="runner-meta" style="margin-top:12px;">
            ${validationReason ? `<div><div class="label">Notes</div><div>${validationReason}</div></div>` : ''}
          </div>
        </div>
      `;
    }

    function renderUsageLane(label, data, windowKey = null) {
      const used = Number.isFinite(data?.used_percent) ? Math.min(100, Math.max(0, data.used_percent)) : null;
      const limitLabel = Number.isFinite(data?.limit_seconds) ? formatDurationSeconds(data.limit_seconds) : '';
      const resetAt = resolveResetTarget(data?.reset_after_seconds ?? null, data?.reset_at ?? null);
      const resetLabel = formatResetLabel(data?.reset_after_seconds ?? null, resetAt ?? data?.reset_at ?? null);
      const timePercentRaw = Number.isFinite(data?.limit_seconds) && Number.isFinite(data?.reset_after_seconds)
        ? Math.round(((data.limit_seconds - data.reset_after_seconds) / data.limit_seconds) * 100)
        : null;
      const timePercent = Number.isFinite(timePercentRaw)
        ? Math.min(100, Math.max(0, timePercentRaw))
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
      const usedLabel = used !== null ? `${used}% used` : 'n/a';
      const meterLabel = `${label}: ${usedLabel}, ${resetLabel}`;
      const meter = `
        <div class="meter ${tone}" role="img" aria-label="${meterLabel}">
          <div class="fill" style="width:${used !== null ? used : 0}%"></div>
          ${timePercent !== null ? `<div class="marker" style="left:${timePercent}%"></div>` : ''}
        </div>
      `;
      return `
        <div class="usage-lane"
          data-reset-at="${resetAt ?? ''}"
          data-reset-after="${Number.isFinite(data?.reset_after_seconds) ? data.reset_after_seconds : ''}"
          data-limit-seconds="${Number.isFinite(data?.limit_seconds) ? data.limit_seconds : ''}">
          <div class="label">
            <span>${label}</span>
            ${chartBtn}
          </div>
          <div class="value">
            <span>${used !== null ? `${used}% used` : 'n/a'}</span>
            <small>${limitLabel}</small>
          </div>
          ${meter}
          <small class="usage-reset">${resetLabel}</small>
        </div>
      `;
    }

    function renderUsageWindowCard(label, rows = []) {
      const lanes = Array.isArray(rows)
        ? rows.map((row) => renderUsageLane(row.label, row.data, row.windowKey)).join('')
        : '';
      return `
        <div class="usage-bar">
          <div class="label usage-window-label">
            <span>${label}</span>
          </div>
          <div class="usage-lanes">
            ${lanes}
          </div>
        </div>
      `;
    }

    function hasWindowData(data) {
      if (!data || typeof data !== 'object') return false;
      return ['used_percent', 'limit_seconds', 'reset_after_seconds', 'reset_at'].some((key) => {
        const value = data[key];
        return value !== null && typeof value !== 'undefined' && value !== '';
      });
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
      const normalPrimary = {
        used_percent: snapshot.primary_used_percent ?? null,
        limit_seconds: snapshot.primary_limit_seconds ?? null,
        reset_after_seconds: snapshot.primary_reset_after_seconds ?? null,
        reset_at: snapshot.primary_reset_at ?? null,
      };
      const normalSecondary = {
        used_percent: snapshot.secondary_used_percent ?? null,
        limit_seconds: snapshot.secondary_limit_seconds ?? null,
        reset_after_seconds: snapshot.secondary_reset_after_seconds ?? null,
        reset_at: snapshot.secondary_reset_at ?? null,
      };
      const sparkPrimary = {
        used_percent: snapshot.spark_primary_used_percent ?? null,
        limit_seconds: snapshot.spark_primary_limit_seconds ?? null,
        reset_after_seconds: snapshot.spark_primary_reset_after_seconds ?? null,
        reset_at: snapshot.spark_primary_reset_at ?? null,
      };
      const sparkSecondary = {
        used_percent: snapshot.spark_secondary_used_percent ?? null,
        limit_seconds: snapshot.spark_secondary_limit_seconds ?? null,
        reset_after_seconds: snapshot.spark_secondary_reset_after_seconds ?? null,
        reset_at: snapshot.spark_secondary_reset_at ?? null,
      };
      const hasSpark = hasWindowData(sparkPrimary) || hasWindowData(sparkSecondary);
      const laneRaw = usage?.active_lane
        || usage?.summary?.active_quota_lane
        || snapshot.active_quota_lane
        || 'normal';
      const activeLane = typeof laneRaw === 'string' && laneRaw.toLowerCase() === 'spark' ? 'spark' : 'normal';
      const isPro = typeof plan === 'string' && plan.toLowerCase().includes('pro');
      const planLabel = plan;
      const sparkMeta = [snapshot.spark_limit_name, snapshot.spark_metered_feature].filter((part) => typeof part === 'string' && part.trim() !== '').join(' · ');
      const laneChip = `<span class="chip ${activeLane === 'spark' ? 'warn' : ''}">Active lane: ${activeLane}</span>`;
      const primaryRows = [
        { label: 'Normal', data: normalPrimary, windowKey: 'normal:primary' },
      ];
      const secondaryRows = [
        { label: 'Normal', data: normalSecondary, windowKey: 'normal:secondary' },
      ];
      if (hasSpark) {
        primaryRows.push({ label: 'Spark', data: sparkPrimary, windowKey: 'spark:primary' });
        secondaryRows.push({ label: 'Spark', data: sparkSecondary, windowKey: 'spark:secondary' });
      }

      chatgptUsageCard.innerHTML = `
        <div class="usage-head">
          <div>
            <div class="stat-label">ChatGPT Account</div>
            <div class="usage-plan ${isPro ? 'pro-plan' : ''}">${planLabel} ${isPro ? '🎉' : ''}</div>
            <div class="usage-meta">
              <span>Last check ${fetched}</span>
              ${next ? `<span>Next ${next}</span>` : ''}
              ${laneChip}
              ${snapshot.rate_limit_reached ? '<span class="chip warn">Limit reached</span>' : ''}
              ${hasSpark && sparkMeta ? `<span>${escapeHtml(sparkMeta)}</span>` : ''}
            </div>
          </div>
        </div>
        ${status !== 'ok' ? `<div class="usage-error">Usage unavailable: ${snapshot.error ?? 'Unknown error'}</div>` : ''}
        <div class="usage-bars">
          ${renderUsageWindowCard('5-hour limit', primaryRows)}
          ${renderUsageWindowCard('Weekly limit', secondaryRows)}
        </div>
      `;

      wireChatGptControls();
      startUsageResetTicker();
    }

    function isDashboardView() {
      const viewMode = (document.body?.dataset?.viewMode || '').toLowerCase();
      return viewMode === 'dashboard';
    }

    const DASHBOARD_LIVE_DOMAINS = new Set([
      'overview',
      'hosts',
      'settings-general',
      'prompts',
      'skills',
      'projects',
      'agents',
      'memories',
    ]);
    const WS_UNKNOWN_ACTION_FALLBACK_DOMAINS = ['overview', 'hosts'];
    const WS_UNKNOWN_ACTION_FALLBACK_DELAY_MS = 1500;
    const OVERVIEW_HOST_LIVE_ACTIONS = new Set([
      'register',
      'token.usage',
      'chatgpt.usage',
    ]);
    const OVERVIEW_HOST_LIVE_PREFIXES = [
      'auth.',
      'host.',
      'admin.host.',
      'pricing.',
      'admin.insecure.',
    ];
    const SETTINGS_GENERAL_LIVE_ACTIONS = new Set([
      'admin.api.state',
      'admin.cdx_silent',
      'admin.reverse_dns',
      'admin.insecure_approval',
      'admin.auto_update',
      'admin.codex_version',
      'admin.quota_mode',
      'admin.prune_policy',
    ]);
    const PROMPT_LIVE_ACTIONS = new Set(['slash.store', 'slash.delete']);
    const SKILL_LIVE_ACTIONS = new Set(['skill.store', 'skill.delete']);
    const PROJECT_LIVE_PREFIXES = ['project.', 'admin.project.'];
    const AGENTS_LIVE_ACTIONS = new Set(['agents.store', 'agents.delete']);
    const MEMORY_LIVE_ACTIONS = new Set([
      'memory.store',
      'memory.delete',
      'memory.admin.delete',
    ]);

    function actionDomainsForLiveRefresh(action) {
      const normalized = String(action || '').trim().toLowerCase();
      const domains = new Set();
      if (!normalized) return domains;
      const refreshesOverviewAndHosts = OVERVIEW_HOST_LIVE_ACTIONS.has(normalized)
        || OVERVIEW_HOST_LIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix));

      if (refreshesOverviewAndHosts) {
        domains.add('overview');
        domains.add('hosts');
      }

      if (SETTINGS_GENERAL_LIVE_ACTIONS.has(normalized)) {
        domains.add('settings-general');
      }

      if (PROMPT_LIVE_ACTIONS.has(normalized)) {
        domains.add('prompts');
      }

      if (SKILL_LIVE_ACTIONS.has(normalized)) {
        domains.add('skills');
      }

      if (PROJECT_LIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        domains.add('projects');
      }

      if (AGENTS_LIVE_ACTIONS.has(normalized) || normalized === 'admin.host.agents_version_override') {
        domains.add('agents');
      }

      if (MEMORY_LIVE_ACTIONS.has(normalized)) {
        domains.add('memories');
      }

      if (normalized === 'config.store') {
        domains.add('config');
        domains.add('profiles');
        domains.add('settings-general');
      }

      if (normalized.startsWith('admin.user.') || normalized.startsWith('admin.auth.')) {
        domains.add('users');
      }

      return domains;
    }

    function shouldRefreshOverviewForAction(action) {
      return actionDomainsForLiveRefresh(action).has('overview');
    }

    function emitAdminDataDirty(action, domains) {
      window.dispatchEvent(new CustomEvent('admin-data-dirty', {
        detail: {
          action: String(action || ''),
          domains: Array.isArray(domains) ? domains : [],
          source: 'websocket',
          created_at: new Date().toISOString(),
        },
      }));
    }

    function queueLiveRefreshDomains(domains) {
      const values = Array.isArray(domains) ? domains : [];
      values.forEach((domain) => {
        const normalized = String(domain || '').trim().toLowerCase();
        if (normalized) {
          liveRefreshPendingDomains.add(normalized);
        }
      });
    }

    async function runLiveRefreshDomains(domainsInput) {
      const requested = new Set(Array.isArray(domainsInput) ? domainsInput : []);
      if (requested.has('settings-general')) {
        requested.add('overview');
      }
      if (requested.has('overview')) {
        requested.add('hosts');
      }
      if (requested.has('agents')) {
        requested.add('hosts');
      }

      const needOverview = requested.has('overview');
      const needHosts = requested.has('hosts');
      const needRunner = needOverview;
      const needPrompts = requested.has('prompts');
      const needSkills = requested.has('skills');
      const needAgents = requested.has('agents');
      const needMemories = requested.has('memories');
      const needSettingsGeneral = requested.has('settings-general');

      let overviewResponse = null;
      let hostsResponse = null;
      let runnerResponse = null;
      let promptsResponse = null;
      let skillsResponse = null;
      let agentsResponse = null;
      const requests = [];

      if (needOverview) {
        requests.push(api('/admin/overview')
          .then((res) => { overviewResponse = res; })
          .catch((err) => console.warn('Live overview update failed', err)));
      }
      if (needHosts) {
        requests.push(api('/admin/hosts')
          .then((res) => { hostsResponse = res; })
          .catch((err) => console.warn('Live host refresh failed', err)));
      }
      if (needRunner) {
        requests.push(api('/admin/runner')
          .then((res) => { runnerResponse = res; })
          .catch((err) => console.warn('Runner status unavailable', err)));
      }
      if (needPrompts) {
        requests.push(api('/admin/slash-commands')
          .then((res) => { promptsResponse = res; })
          .catch((err) => console.warn('Live slash-command refresh failed', err)));
      }
      if (needSkills) {
        requests.push(api('/admin/skills')
          .then((res) => { skillsResponse = res; })
          .catch((err) => console.warn('Live skills refresh failed', err)));
      }
      if (needAgents) {
        requests.push(api('/admin/agents')
          .then((res) => { agentsResponse = res; })
          .catch((err) => console.warn('Live AGENTS refresh failed', err)));
      }

      if (requests.length) {
        await Promise.all(requests);
      }

      if (hostsResponse) {
        const hostsList = hostsResponse?.data?.hosts || [];
        renderHosts(hostsList);
        renderInsecureHostsQuickButton(hostsList);
      }

      if (overviewResponse) {
        currentOverview = overviewResponse?.data || {};
        setMtls(currentOverview.mtls);
        if (typeof currentOverview.inactivity_window_days !== 'undefined') {
          inactivityWindowDays = clampInactivityWindowDays(currentOverview.inactivity_window_days);
          renderInactivityWindowDays();
        }
        if (typeof currentOverview.quota_limit_percent !== 'undefined') {
          quotaLimitPercent = clampQuotaLimitPercent(currentOverview.quota_limit_percent);
        }
        if (typeof currentOverview.quota_week_partition !== 'undefined') {
          quotaWeekPartition = normalizeQuotaPartition(currentOverview.quota_week_partition);
        }
        if (typeof currentOverview.quota_hard_fail !== 'undefined') {
          quotaHardFail = !!currentOverview.quota_hard_fail;
        }
        if (typeof currentOverview.cdx_silent !== 'undefined') {
          cdxSilent = !!currentOverview.cdx_silent;
          renderCdxSilent();
        }
        if (typeof currentOverview.reverse_dns_enabled !== 'undefined') {
          reverseDnsEnabled = !!currentOverview.reverse_dns_enabled;
          renderReverseDns();
        }
        if (typeof currentOverview.insecure_approval_enabled !== 'undefined') {
          insecureApprovalEnabled = !!currentOverview.insecure_approval_enabled;
          renderInsecureApproval();
        }
        if (typeof currentOverview.auto_update_enabled !== 'undefined') {
          autoUpdateEnabled = !!currentOverview.auto_update_enabled;
          renderAutoUpdate();
        }
      }

      const runnerInfo = runnerResponse?.data || runnerSummary || null;
      if (runnerResponse?.data) {
        runnerSummary = runnerResponse.data;
      }

      if (needSettingsGeneral) {
        await loadApiState();
      }

      if (needOverview && currentOverview) {
        renderQuotaMode();
        renderStats(currentOverview, runnerInfo, currentHosts);
        renderDashboardGrid(currentOverview, runnerInfo, currentHosts);
        evaluateSeedRequirement(currentOverview, currentHosts);
      }

      if (needSettingsGeneral && currentOverview) {
        await loadCodexVersionControl();
      }

      if (needPrompts && promptsResponse) {
        renderPrompts(promptsResponse?.data?.commands || []);
      }
      if (needSkills && skillsResponse) {
        renderSkills(skillsResponse?.data?.skills || []);
      }
      if (needAgents && agentsResponse) {
        renderAgents(agentsResponse?.data || { status: 'missing' });
      }
      if (needMemories) {
        await loadMemories();
      }
    }

    function scheduleLiveDataRefresh(domains, delay = 1000) {
      queueLiveRefreshDomains(domains);
      if (liveRefreshInFlight) {
        liveRefreshQueued = true;
        return;
      }
      if (liveRefreshTimer) return;
      liveRefreshTimer = window.setTimeout(async () => {
        liveRefreshTimer = null;
        const domainsToRefresh = Array.from(liveRefreshPendingDomains);
        liveRefreshPendingDomains.clear();
        if (!domainsToRefresh.length) return;
        liveRefreshInFlight = true;
        try {
          await runLiveRefreshDomains(domainsToRefresh);
        } finally {
          liveRefreshInFlight = false;
          if (liveRefreshQueued || liveRefreshPendingDomains.size > 0) {
            liveRefreshQueued = false;
            scheduleLiveDataRefresh([], 750);
          }
        }
      }, delay);
    }

    async function refreshOverviewLive() {
      await runLiveRefreshDomains(['overview', 'hosts']);
    }

    function scheduleOverviewLiveRefresh(delay = 1000) {
      scheduleLiveDataRefresh(['overview', 'hosts'], delay);
    }

    function wireChatGptControls() {
      document.querySelectorAll('.usage-history-btn').forEach((el) => {
        el.onclick = (ev) => {
          ev.preventDefault();
          const raw = (el.getAttribute('data-window') || '').trim().toLowerCase();
          const [laneRaw, windowRaw] = raw.includes(':') ? raw.split(':', 2) : ['normal', raw];
          const laneKey = laneRaw === 'spark' ? 'spark' : 'normal';
          const windowKey = windowRaw === 'secondary' ? 'secondary' : 'primary';
          openUsageHistory(laneKey, windowKey);
        };
      });
      document.querySelectorAll('.cost-history-btn').forEach((el) => {
        el.onclick = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const inline = document.getElementById('dashboardCostCanvas');
          if (inline) {
            inline.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
          }
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

    function buildUsageSeries(points, laneKey, windowKey) {
      const lane = laneKey === 'spark' ? 'spark' : 'normal';
      const key = (() => {
        if (lane === 'spark' && windowKey === 'secondary') return 'spark_secondary_used_percent';
        if (lane === 'spark') return 'spark_primary_used_percent';
        if (windowKey === 'secondary') return 'secondary_used_percent';
        return 'primary_used_percent';
      })();
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

    function getChartHeight(defaultHeight = 260) {
      return document.body?.dataset?.view === 'mobile' ? 220 : defaultHeight;
    }

    function getPlotSize(container, height) {
      if (!container) return { width: 0, height };
      const rect = container.getBoundingClientRect();
      const width = Math.max(240, Math.floor(rect.width || 0));
      return { width, height };
    }

    function destroyPlot(plot, observer) {
      if (observer) observer.disconnect();
      if (plot && typeof plot.destroy === 'function') plot.destroy();
    }

    function attachPlotResizeObserver(plot, container, height) {
      if (!plot || !container || typeof ResizeObserver === 'undefined') return null;
      let frame = null;
      const observer = new ResizeObserver(() => {
        if (frame) return;
        frame = window.requestAnimationFrame(() => {
          frame = null;
          const { width } = getPlotSize(container, height);
          if (width > 0 && typeof plot.setSize === 'function') {
            plot.setSize({ width, height });
          }
        });
      });
      observer.observe(container);
      return observer;
    }

    function getCssVar(name, fallback) {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name);
      return value && value.trim() ? value.trim() : fallback;
    }

    function renderUsageHistoryChart(series, laneKey, windowKey) {
      if (!usageHistoryChart) return;
      destroyPlot(usageHistoryPlot, usageHistoryResizeObserver);
      usageHistoryPlot = null;
      usageHistoryResizeObserver = null;
      if (!Array.isArray(series) || series.length === 0) {
        usageHistoryChart.innerHTML = '<div class="muted">No quota history yet.</div>';
        return;
      }

      if (window.uPlot) {
        try {
          const plotHeight = getChartHeight(260);
          const accent = getCssVar('--accent-2', '#0b7c73');
          const accentRgb = getCssVar('--accent-rgb', '15, 156, 146');
          const gridStroke = 'rgba(15,23,42,0.08)';
          const Plot = window.uPlot;
          const xVals = series.map((pt) => pt.x);
          const yVals = series.map((pt) => pt.y);
          const maxY = Math.max(100, ...yVals);
          const tickMax = Math.ceil(maxY / 25) * 25;
          const yTicks = [];
          for (let value = 0; value <= tickMax; value += 25) {
            yTicks.push(value);
          }

          usageHistoryChart.innerHTML = `
            <div data-usage-plot></div>
            <div class="usage-history-tooltip" data-usage-tooltip hidden></div>
          `;
          const plotRoot = usageHistoryChart.querySelector('[data-usage-plot]');
          const tooltip = usageHistoryChart.querySelector('[data-usage-tooltip]');
          if (!plotRoot) return;
          plotRoot.setAttribute('role', 'img');
          const laneLabel = laneKey === 'spark' ? 'Spark' : 'Normal';
          const windowLabel = windowKey === 'secondary' ? 'weekly' : '5-hour';
          plotRoot.setAttribute('aria-label', `${laneLabel} ${windowLabel} quota history`);

          const { width } = getPlotSize(plotRoot, plotHeight);
          const data = [xVals, yVals];
          const opts = {
            width,
            height: plotHeight,
            series: [
              {},
              {
                label: `${laneKey === 'spark' ? 'Spark' : 'Normal'} ${windowKey === 'secondary' ? 'weekly' : '5-hour'} quota`,
                stroke: accent,
                width: 2,
                fill: `rgba(${accentRgb},0.18)`,
                points: { show: false },
              },
            ],
            scales: {
              x: { time: true },
              y: {
                range: () => [0, tickMax],
              },
            },
            axes: [
              {
                stroke: '#64748b',
                grid: { stroke: gridStroke },
                ticks: { stroke: gridStroke },
                values: (u, ticks) => ticks.map((v) => formatShortDate(new Date(v))),
              },
              {
                stroke: '#64748b',
                grid: { stroke: gridStroke },
                ticks: { stroke: gridStroke },
                splits: () => yTicks,
                values: (u, ticks) => ticks.map((v) => `${Math.round(v)}%`),
              },
            ],
            cursor: {
              y: false,
              points: { show: true },
            },
            legend: {
              show: false,
            },
          };

          const plot = new Plot(opts, data, plotRoot);
          const observer = attachPlotResizeObserver(plot, plotRoot, plotHeight);
          usageHistoryPlot = plot;
          usageHistoryResizeObserver = observer;

          if (tooltip) {
            let lockedIdx = null;
            let lastClientX = null;

            const showTooltip = (idx, clientX) => {
              if (idx === null || idx === undefined) return;
              const point = series[idx];
              if (!point) return;
              const dateLabel = formatShortDate(new Date(point.x), true);
              const valueLabel = `${Math.round(point.raw ?? point.y)}%`;
              tooltip.innerHTML = `
                <span class="label">${dateLabel}</span>
                <span class="value">${valueLabel}</span>
              `;
              tooltip.hidden = false;
              const rect = plotRoot.getBoundingClientRect();
              const safeClientX = Number.isFinite(clientX) ? clientX : rect.left + (usageHistoryPlot?.cursor?.left ?? 0);
              lastClientX = safeClientX;
              const relative = rect.width > 0 ? clamp((safeClientX - rect.left) / rect.width, 0, 1) : 0.5;
              const tipWidth = tooltip.offsetWidth || 0;
              const xPos = clamp((relative * rect.width) - (tipWidth / 2), 0, Math.max(rect.width - tipWidth, 0));
              tooltip.style.left = `${xPos}px`;
              tooltip.style.top = '10px';
            };

            const hideTooltip = () => {
              tooltip.hidden = true;
              tooltip.innerHTML = '';
            };

            plotRoot.addEventListener('pointermove', (event) => {
              if (lockedIdx !== null) return;
              const idx = usageHistoryPlot?.cursor?.idx;
              if (idx === null || idx === undefined) return;
              showTooltip(idx, event.clientX);
            });
            plotRoot.addEventListener('mouseleave', () => {
              if (lockedIdx !== null) {
                showTooltip(lockedIdx, lastClientX);
                return;
              }
              hideTooltip();
            });
            plotRoot.addEventListener('click', (event) => {
              const idx = usageHistoryPlot?.cursor?.idx;
              if (idx === null || idx === undefined) return;
              lockedIdx = lockedIdx === idx ? null : idx;
              if (lockedIdx === null) {
                hideTooltip();
                return;
              }
              showTooltip(lockedIdx, event.clientX);
            });
          }
          return;
        } catch (err) {
          console.warn('uPlot render failed, falling back to SVG usage history.', err);
          destroyPlot(usageHistoryPlot, usageHistoryResizeObserver);
          usageHistoryPlot = null;
          usageHistoryResizeObserver = null;
        }
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
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${laneKey === 'spark' ? 'Spark' : 'Normal'} ${windowKey === 'secondary' ? 'weekly' : '5-hour'} quota history">
          <g class="grid">${gridLines}</g>
          ${areaPath ? `<path d="${areaPath}" class="area"></path>` : ''}
          ${path ? `<path d="${path}" class="line"></path>` : ''}
          ${latest ? `<circle cx="${latest.x.toFixed(2)}" cy="${latest.y.toFixed(2)}" r="4" class="dot"></circle>` : ''}
        </svg>
      `;
    }

    function normalizeUsageHistoryOptions(options = {}) {
      const source = options && typeof options === 'object' ? options : {};
      const days = Number.isFinite(Number(source.days))
        ? Math.max(1, Math.min(180, Math.round(Number(source.days))))
        : USAGE_HISTORY_DAYS;
      const intervalRaw = String(source.interval || '').trim().toLowerCase();
      const interval = ['raw', 'hour', 'day'].includes(intervalRaw) ? intervalRaw : 'day';
      const laneRaw = String(source.lane || '').trim().toLowerCase();
      const lane = ['normal', 'spark', 'both'].includes(laneRaw) ? laneRaw : 'both';
      const windowRaw = String(source.window || '').trim().toLowerCase();
      const window = ['primary', 'secondary', 'both'].includes(windowRaw) ? windowRaw : 'both';
      const from = parseTimestamp(source.from) || null;
      const until = parseTimestamp(source.until) || null;
      return {
        days,
        from: from ? from.toISOString() : null,
        until: until ? until.toISOString() : null,
        interval,
        lane,
        window,
      };
    }

    function usageHistoryCacheKey(options = {}) {
      const normalized = normalizeUsageHistoryOptions(options);
      return JSON.stringify(normalized);
    }

    function usageHistoryQueryString(options = {}) {
      const normalized = normalizeUsageHistoryOptions(options);
      const params = new URLSearchParams();
      params.set('days', String(normalized.days));
      params.set('interval', normalized.interval);
      params.set('lane', normalized.lane);
      params.set('window', normalized.window);
      if (normalized.from) params.set('from', normalized.from);
      if (normalized.until) params.set('until', normalized.until);
      return params.toString();
    }

    async function loadUsageHistory(force = false, options = {}) {
      const hasCustomOptions = options && Object.keys(options).length > 0;
      const cacheKey = usageHistoryCacheKey(options);
      if (!force && !hasCustomOptions && chatgptUsageHistory) return chatgptUsageHistory;
      if (!force && !hasCustomOptions && chatgptUsageHistoryPromise) return chatgptUsageHistoryPromise;
      if (!force && chatgptUsageHistoryCache.has(cacheKey)) return chatgptUsageHistoryCache.get(cacheKey);
      if (!force && chatgptUsageHistoryPromiseCache.has(cacheKey)) return chatgptUsageHistoryPromiseCache.get(cacheKey);

      const url = `/admin/chatgpt/usage/history?${usageHistoryQueryString(options)}`;
      const request = api(url).then((res) => {
        const data = res?.data || {};
        const result = {
          points: Array.isArray(data.points) ? data.points : [],
          series: Array.isArray(data.series) ? data.series : [],
          days: data.days ?? USAGE_HISTORY_DAYS,
          since: data.since || null,
          from: data.from || data.since || null,
          until: data.until || null,
          interval: typeof data.interval === 'string' ? data.interval : 'day',
          lane: typeof data.lane === 'string' ? data.lane : 'both',
          window: typeof data.window === 'string' ? data.window : 'both',
        };
        chatgptUsageHistoryCache.set(cacheKey, result);
        if (!hasCustomOptions) {
          chatgptUsageHistory = result;
        }
        return result;
      }).finally(() => {
        chatgptUsageHistoryPromiseCache.delete(cacheKey);
        if (!hasCustomOptions) {
          chatgptUsageHistoryPromise = null;
        }
      });

      chatgptUsageHistoryPromiseCache.set(cacheKey, request);
      if (!hasCustomOptions) {
        chatgptUsageHistoryPromise = request;
      }
      return request;
    }

    async function openUsageHistory(laneKey = 'normal', windowKey = 'primary') {
      if (!usageHistoryModal) return;
      const laneLabel = laneKey === 'spark' ? 'Spark' : 'Normal';
      const label = `${laneLabel} ${windowKey === 'secondary' ? 'weekly quota' : '5-hour quota'}`;
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
        const series = buildUsageSeries(history.points, laneKey, windowKey);
        if (series.length === 0) {
          if (usageHistorySubtitle) {
            usageHistorySubtitle.textContent = `${label} · no history yet`;
          }
          if (usageHistoryChart) {
            usageHistoryChart.innerHTML = '<div class="muted">No recorded quota data.</div>';
          }
          return;
        }

        renderUsageHistoryChart(series, laneKey, windowKey);
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
      destroyPlot(costHistoryPlot, costHistoryResizeObserver);
      costHistoryPlot = null;
      costHistoryResizeObserver = null;
      const series = buildCostSeries(history);
      const allPoints = series.flatMap((s) => s.values);
      if (allPoints.length === 0) {
        costHistoryChart.innerHTML = '<div class="muted">No cost history yet.</div>';
        return;
      }
      const pointIndex = buildCostPointIndex(history);
      if (!pointIndex.length) {
        costHistoryChart.innerHTML = '<div class="muted">No cost history yet.</div>';
        return;
      }
      const currency = history?.currency || 'USD';

      if (window.uPlot) {
        try {
          const Plot = window.uPlot;
          const plotHeight = getChartHeight(260);
          const gridStroke = 'rgba(15,23,42,0.08)';

          const seriesData = series.map((s) => {
            const byDate = new Map(s.values.map((value) => [value.date, value.y]));
            return pointIndex.map((pt) => byDate.get(pt.date) ?? null);
          });
          const xVals = pointIndex.map((pt) => pt.x);
          const data = [xVals, ...seriesData];
          let maxY = 0;
          seriesData.forEach((values) => {
            values.forEach((val) => {
              if (Number.isFinite(val) && val > maxY) maxY = val;
            });
          });
          const yMax = Math.max(1, maxY);
          const ticks = buildCostTicks(yMax);
          const tickMax = ticks[ticks.length - 1] ?? yMax;

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
              <div data-cost-plot></div>
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

          const plotRoot = costHistoryChart.querySelector('[data-cost-plot]');
          if (!plotRoot) return;
          plotRoot.setAttribute('role', 'img');
          plotRoot.setAttribute('aria-label', 'Cost history over time');
          const { width } = getPlotSize(plotRoot, plotHeight);
          const opts = {
            width,
            height: plotHeight,
            series: [
              {},
              {
                label: 'Total',
                stroke: '#312e81',
                width: 3,
                points: { show: false },
              },
              {
                label: 'Input',
                stroke: '#0ea5e9',
                width: 2,
                points: { show: false },
              },
              {
                label: 'Output',
                stroke: '#16a34a',
                width: 2,
                points: { show: false },
              },
              {
                label: 'Cached',
                stroke: '#f97316',
                width: 2,
                points: { show: false },
              },
            ],
            scales: {
              x: { time: true },
              y: {
                range: () => [0, tickMax],
              },
            },
            axes: [
              {
                stroke: '#64748b',
                grid: { stroke: gridStroke },
                ticks: { stroke: gridStroke },
                values: (u, ticks) => ticks.map((v) => formatShortDate(new Date(v))),
              },
              {
                stroke: '#64748b',
                grid: { stroke: gridStroke },
                ticks: { stroke: gridStroke },
                splits: () => ticks,
                values: (u, ticks) => ticks.map((v) => formatMoney(v, currency)),
              },
            ],
            cursor: {
              y: false,
              points: { show: true },
            },
            legend: {
              show: false,
            },
          };

          const plot = new Plot(opts, data, plotRoot);
          const observer = attachPlotResizeObserver(plot, plotRoot, plotHeight);
          costHistoryPlot = plot;
          costHistoryResizeObserver = observer;

          attachCostHistoryInteractions(costHistoryChart, {
            plot: costHistoryPlot,
            points: pointIndex,
            currency,
          });
          return;
        } catch (err) {
          console.warn('uPlot render failed, falling back to SVG cost history.', err);
          destroyPlot(costHistoryPlot, costHistoryResizeObserver);
          costHistoryPlot = null;
          costHistoryResizeObserver = null;
        }
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
      const { points, currency, minX, spanX, plot } = config || {};
      if (!root || !Array.isArray(points) || points.length === 0) return;
      const tooltip = root.querySelector('[data-cost-tooltip]');
      const detailEl = root.querySelector('[data-cost-detail]');
      const tableBody = root.querySelector('[data-cost-table]');
      if (!detailEl || !tableBody) return;

      const dateLookup = new Map(points.map((pt, idx) => [pt.date, { point: pt, idx }]));
      let selectedIdx = points.length - 1;
      let lockedIdx = selectedIdx;
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

      function setSelection(idx, opts = {}) {
        if (!Number.isFinite(idx) || idx < 0 || idx >= points.length) return null;
        const point = points[idx];
        const force = opts.force ?? false;
        if (!force && selectedIdx === idx) {
          if (opts.lock) lockedIdx = idx;
          return point;
        }
        selectedIdx = idx;
        if (opts.lock) lockedIdx = idx;
        if (detailEl) {
          detailEl.innerHTML = renderCostDetail(point, currency);
        }
        updateRowSelection(point.date);
        return point;
      }

      function showTooltip(point, clientX, chartRect) {
        if (!tooltip || !point) return;
        tooltip.innerHTML = renderCostTooltip(point, currency);
        tooltip.hidden = false;
        if (!chartRect) return;
        const tipWidth = tooltip.offsetWidth || 0;
        const leftPx = clamp(clientX - chartRect.left - (tipWidth / 2), 0, Math.max(chartRect.width - tipWidth, 0));
        tooltip.style.left = `${leftPx}px`;
        tooltip.style.top = '12px';
      }

      function hideTooltip() {
        if (!tooltip) return;
        tooltip.hidden = true;
        tooltip.innerHTML = '';
      }

      setSelection(selectedIdx, { lock: true, force: true });

      if (plot) {
        const plotRoot = plot.root;

        const syncCursorToIdx = (idx) => {
          if (!plot || typeof plot.valToPos !== 'function' || typeof plot.setCursor !== 'function') return;
          const point = points[idx];
          if (!point) return;
          const left = plot.valToPos(point.x, 'x');
          if (!Number.isFinite(left)) return;
          plot.setCursor({ left, top: 0 }, false, false);
        };

        if (plotRoot) {
          plotRoot.addEventListener('pointermove', (event) => {
            const idx = plot?.cursor?.idx;
            if (idx === null || idx === undefined) return;
            const point = setSelection(idx, { lock: false });
            if (!point) return;
            const rect = plotRoot.getBoundingClientRect();
            showTooltip(point, event.clientX, rect);
          });
          plotRoot.addEventListener('mouseleave', () => {
            hideTooltip();
            if (lockedIdx !== null) {
              setSelection(lockedIdx, { lock: false, force: true });
            }
          });
          plotRoot.addEventListener('click', (event) => {
            const idx = plot?.cursor?.idx;
            if (idx === null || idx === undefined) return;
            lockedIdx = idx;
            const point = setSelection(idx, { lock: true, force: true });
            if (!point) return;
            const rect = plotRoot.getBoundingClientRect();
            showTooltip(point, event.clientX, rect);
          });
        }

        const handleRowFocus = (event, lock = false) => {
          const row = event.target.closest('tr[data-cost-row]');
          if (!row) return;
          const date = row.dataset.costRow;
          const lookup = dateLookup.get(date);
          if (!lookup) return;
          setSelection(lookup.idx, { lock, force: lock });
          if (!lock) hideTooltip();
          if (lock) lockedIdx = lookup.idx;
          syncCursorToIdx(lookup.idx);
        };

        tableBody.addEventListener('mouseover', (event) => handleRowFocus(event, false));
        tableBody.addEventListener('focusin', (event) => handleRowFocus(event, false));
        tableBody.addEventListener('mouseleave', () => {
          hideTooltip();
          if (lockedIdx !== null) {
            setSelection(lockedIdx, { lock: false, force: true });
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
        return;
      }

      const overlay = root.querySelector('[data-chart-overlay]');
      const crosshair = root.querySelector('[data-cost-crosshair]');

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

      function setSelectionByDate(date, opts = {}) {
        const lookup = dateLookup.get(date);
        if (!lookup) return null;
        const force = opts.force ?? false;
        if (!force && selectedIdx === lookup.idx) {
          if (opts.lock) lockedIdx = lookup.idx;
          return lookup.point;
        }
        selectedIdx = lookup.idx;
        if (opts.lock) lockedIdx = lookup.idx;
        if (detailEl) {
          detailEl.innerHTML = renderCostDetail(lookup.point, currency);
        }
        updateRowSelection(lookup.point.date);
        positionCrosshair(lookup.point);
        return lookup.point;
      }

      function showOverlayTooltip(point, clientX) {
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

      setSelectionByDate(points[selectedIdx]?.date, { lock: true, force: true });

      if (overlay) {
        overlay.addEventListener('pointermove', (ev) => {
          const rect = overlay.getBoundingClientRect();
          if (rect.width <= 0) return;
          const relative = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const targetX = minX + ((spanX || 1) * relative);
          const point = findNearestCostPoint(points, targetX);
          if (!point) return;
          const lookup = dateLookup.get(point.date);
          if (!lookup) return;
          setSelection(lookup.idx, { lock: false });
          showOverlayTooltip(point, ev.clientX);
        });
        overlay.addEventListener('pointerleave', () => {
          hideTooltip();
          if (lockedIdx !== null) {
            setSelection(lockedIdx, { lock: false, force: true });
          }
        });
        overlay.addEventListener('click', (ev) => {
          const rect = overlay.getBoundingClientRect();
          if (rect.width <= 0) return;
          const relative = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
          const targetX = minX + ((spanX || 1) * relative);
          const point = findNearestCostPoint(points, targetX);
          if (point) {
            const lookup = dateLookup.get(point.date);
            if (!lookup) return;
            setSelection(lookup.idx, { lock: true, force: true });
            showOverlayTooltip(point, ev.clientX);
          }
        });
      }

      const handleRowFocus = (event, lock = false) => {
        const row = event.target.closest('tr[data-cost-row]');
        if (!row) return;
        const date = row.dataset.costRow;
        if (!date) return;
        const lookup = dateLookup.get(date);
        if (!lookup) return;
        setSelection(lookup.idx, { lock, force: lock });
        if (!lock) hideTooltip();
      };

      tableBody.addEventListener('mouseover', (event) => handleRowFocus(event, false));
      tableBody.addEventListener('focusin', (event) => handleRowFocus(event, false));
      tableBody.addEventListener('mouseleave', () => {
        hideTooltip();
        if (lockedIdx !== null) {
          setSelection(lockedIdx, { lock: false, force: true });
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

    function normalizeCostHistoryOptions(options = {}) {
      const source = options && typeof options === 'object' ? options : {};
      const days = Number.isFinite(Number(source.days))
        ? Math.max(1, Math.min(180, Math.round(Number(source.days))))
        : USAGE_HISTORY_DAYS;
      const intervalRaw = String(source.interval || '').trim().toLowerCase();
      const interval = ['day', 'week'].includes(intervalRaw) ? intervalRaw : 'day';
      const groupByRaw = String(source.group_by || source.groupBy || '').trim().toLowerCase();
      const groupBy = ['component', 'total'].includes(groupByRaw) ? groupByRaw : 'component';
      const includeTokens = source.include_tokens === false || source.includeTokens === false
        ? false
        : true;
      const from = parseTimestamp(source.from) || null;
      const until = parseTimestamp(source.until) || null;
      return {
        days,
        interval,
        group_by: groupBy,
        include_tokens: includeTokens,
        from: from ? from.toISOString() : null,
        until: until ? until.toISOString() : null,
      };
    }

    function costHistoryCacheKey(options = {}) {
      const normalized = normalizeCostHistoryOptions(options);
      return JSON.stringify(normalized);
    }

    function costHistoryQueryString(options = {}) {
      const normalized = normalizeCostHistoryOptions(options);
      const params = new URLSearchParams();
      params.set('days', String(normalized.days));
      params.set('interval', normalized.interval);
      params.set('group_by', normalized.group_by);
      params.set('include_tokens', normalized.include_tokens ? '1' : '0');
      if (normalized.from) params.set('from', normalized.from);
      if (normalized.until) params.set('until', normalized.until);
      return params.toString();
    }

    async function loadCostHistory(force = false, options = {}) {
      const hasCustomOptions = options && Object.keys(options).length > 0;
      const cacheKey = costHistoryCacheKey(options);
      if (!force && !hasCustomOptions && costHistory) return costHistory;
      if (!force && !hasCustomOptions && costHistoryPromise) return costHistoryPromise;
      if (!force && costHistoryCache.has(cacheKey)) return costHistoryCache.get(cacheKey);
      if (!force && costHistoryPromiseCache.has(cacheKey)) return costHistoryPromiseCache.get(cacheKey);

      const url = `/admin/usage/cost-history?${costHistoryQueryString(options)}`;
      const request = api(url).then((res) => {
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
          series: Array.isArray(data.series) ? data.series : [],
          currency: data.currency || 'USD',
          has_pricing: data.has_pricing ?? false,
          pricing: data.pricing || {},
          since: data.since || null,
          from: data.from || data.since || null,
          until: data.until || null,
          interval: typeof data.interval === 'string' ? data.interval : 'day',
          group_by: typeof data.group_by === 'string' ? data.group_by : 'component',
          include_tokens: data.include_tokens !== false,
          days: data.days ?? USAGE_HISTORY_DAYS,
        };
        costHistoryCache.set(cacheKey, result);
        if (!hasCustomOptions) {
          costHistory = result;
        }
        return result;
      }).finally(() => {
        costHistoryPromiseCache.delete(cacheKey);
        if (!hasCustomOptions) {
          costHistoryPromise = null;
        }
      });

      costHistoryPromiseCache.set(cacheKey, request);
      if (!hasCustomOptions) {
        costHistoryPromise = request;
      }
      return request;
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

    function computeDailyAllowance(limitPercent, partitionDays) {
      const limit = clampQuotaLimitPercent(limitPercent);
      const days = Number(partitionDays);
      if (!Number.isFinite(days) || (days !== 5 && days !== 7)) return null;
      // Match bash rounding: (limit + days/2) / days
      return Math.max(1, Math.round((limit + days / 2) / days));
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
      if (quotaPartitionLabel) {
        let label = 'Off';
        if (quotaWeekPartition === QUOTA_WEEK_PARTITION_SEVEN) {
          const perDay = computeDailyAllowance(quotaLimitPercent, 7);
          label = perDay ? `7 days (${quotaLimitPercent}/${7} daily ≈ ${perDay}%)` : '7 days';
        } else if (quotaWeekPartition === QUOTA_WEEK_PARTITION_FIVE) {
          const perDay = computeDailyAllowance(quotaLimitPercent, 5);
          label = perDay ? `5 days (${quotaLimitPercent}/${5} daily ≈ ${perDay}%)` : '5 days';
        }
        quotaPartitionLabel.textContent = label;
      }

      // Keep buttons in sync with the live quota slider + selection.
      if (quotaPartitionButtons.length) {
        quotaPartitionButtons.forEach((btn) => {
          const days = Number(btn.getAttribute('data-days'));
          const isSelected = days === quotaWeekPartition;
          btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
          if (days === 7 || days === 5) {
            const perDay = computeDailyAllowance(quotaLimitPercent, days);
            const base = days === 7 ? '7 days' : 'Mon-Fri';
            btn.textContent = perDay ? `${base} (${quotaLimitPercent}/${days} ≈ ${perDay}%)` : base;
          } else if (days === 0) {
            btn.textContent = 'Off';
          }
        });
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

    function formatInsecureWindowLabel(value) {
      const minutes = clampInsecureWindowMinutes(value);
      if (minutes <= 0) return '0 min';
      if (minutes < 60) return `${minutes} min`;
      const hours = Math.floor(minutes / 60);
      const remainder = minutes % 60;
      if (remainder === 0) return `${hours}h`;
      return `${hours}h ${remainder}m`;
    }

    function insecureSliderValueToMinutes(value) {
      const raw = Number(value);
      if (!Number.isFinite(raw)) return INSECURE_WINDOW_DEFAULT;
      const min = INSECURE_WINDOW_SLIDER_MIN;
      const max = INSECURE_WINDOW_SLIDER_MAX;
      const clamped = Math.min(max, Math.max(min, raw));
      const ratio = max === min ? 0 : (clamped - min) / (max - min);
      const curve = INSECURE_WINDOW_LOG_CURVE;
      const scaled = curve > 0
        ? Math.expm1(curve * ratio) / Math.expm1(curve)
        : ratio;
      return clampInsecureWindowMinutes(Math.round(scaled * INSECURE_WINDOW_MAX));
    }

    function insecureMinutesToSliderValue(value) {
      const minutes = clampInsecureWindowMinutes(value);
      const ratio = INSECURE_WINDOW_MAX > 0 ? minutes / INSECURE_WINDOW_MAX : 0;
      const curve = INSECURE_WINDOW_LOG_CURVE;
      const scaled = curve > 0
        ? Math.log1p(ratio * Math.expm1(curve)) / curve
        : ratio;
      const min = INSECURE_WINDOW_SLIDER_MIN;
      const max = INSECURE_WINDOW_SLIDER_MAX;
      return Math.round(min + scaled * (max - min));
    }

    function clampInactivityWindowDays(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return PRUNE_WINDOW_DEFAULT;
      if (num < PRUNE_WINDOW_MIN) return PRUNE_WINDOW_MIN;
      if (num > PRUNE_WINDOW_MAX) return PRUNE_WINDOW_MAX;
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
      const sliderValue = String(insecureMinutesToSliderValue(insecureWindowMinutes));
      if (insecureWindowSlider && insecureWindowSlider.value !== sliderValue) {
        insecureWindowSlider.value = sliderValue;
      }
      if (insecureWindowLabel) {
        insecureWindowLabel.textContent = formatInsecureWindowLabel(insecureWindowMinutes);
      }
      if (persist) {
        try {
          window.localStorage.setItem(INSECURE_WINDOW_STORAGE_KEY, String(insecureWindowMinutes));
        } catch {
          // ignore storage failures
        }
      }
    }

    function renderInactivityWindowDays() {
      if (pruneWindowSlider && pruneWindowSlider.value !== String(inactivityWindowDays)) {
        pruneWindowSlider.value = String(inactivityWindowDays);
      }
      if (pruneWindowLabel) {
        pruneWindowLabel.textContent = inactivityWindowDays === 0 ? 'Never' : `${inactivityWindowDays} days`;
      }
    }

    async function updateInactivityWindowDays(nextValue) {
      if (!pruneWindowSlider) return;
      const normalized = clampInactivityWindowDays(nextValue);
      if (normalized === inactivityWindowDays) {
        renderInactivityWindowDays();
        return;
      }
      const previous = inactivityWindowDays;
      inactivityWindowDays = normalized;
      renderInactivityWindowDays();
      pruneWindowSlider.disabled = true;
      try {
        await api('/admin/prune-policy', {
          method: 'POST',
          json: { inactivity_days: normalized },
        });
      } catch (err) {
        toast(`Prune policy update failed: ${err.message}`, 'error');
        inactivityWindowDays = previous;
        renderInactivityWindowDays();
      } finally {
        pruneWindowSlider.disabled = false;
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

    function summarizeDashboardHosts(hostsList = []) {
      const summary = {
        total: 0,
        secure: 0,
        insecure: 0,
        provisioned: 0,
        unprovisioned: 0,
        locked: 0,
        grace: 0,
        staleAuth: 0,
        vip: 0,
        temporary: 0,
        roaming: 0,
        ipv4Only: 0,
        behindVersion: 0,
      };

      if (!Array.isArray(hostsList)) return summary;

      hostsList.forEach((host) => {
        if (!host || typeof host !== 'object') return;
        summary.total += 1;

        const secure = isHostSecure(host);
        const insecureNow = insecureState(host);
        if (secure) {
          summary.secure += 1;
        } else {
          summary.insecure += 1;
          if (!insecureNow.enabledActive && !insecureNow.graceActive) summary.locked += 1;
          if (!insecureNow.enabledActive && insecureNow.graceActive) summary.grace += 1;
        }

        if (host.authed === true) {
          summary.provisioned += 1;
        } else {
          summary.unprovisioned += 1;
        }

        if (secure && host.auth_outdated) summary.staleAuth += 1;
        if (host.vip) summary.vip += 1;
        if (host.expires_at) summary.temporary += 1;
        if (host.allow_roaming_ips) summary.roaming += 1;
        if (host.force_ipv4) summary.ipv4Only += 1;

        if (isVersionBehind(host.client_version, latestVersions.client) || isVersionBehind(host.wrapper_version, latestVersions.wrapper)) {
          summary.behindVersion += 1;
        }
      });

      return summary;
    }

    function computeDashboardPulse(fleetSummary, {
      runnerInfo = null,
      monthPercentOfPlan = null,
      quotaHardStop = false,
      quotaLimit = QUOTA_LIMIT_DEFAULT,
    } = {}) {
      let score = 100;
      const radar = [];
      const plural = (value, singular, pluralValue = `${singular}s`) => `${value} ${value === 1 ? singular : pluralValue}`;
      const addRadar = (tone, title, detail) => {
        radar.push({ tone, title, detail });
      };

      if (fleetSummary.locked > 0) {
        score -= Math.min(42, fleetSummary.locked * 11);
        addRadar(
          'danger',
          `${plural(fleetSummary.locked, 'locked insecure window')}`,
          'These hosts cannot complete /auth until an insecure window is opened.'
        );
      } else if (fleetSummary.insecure > 0) {
        addRadar('ok', 'Insecure hosts reachable', 'No insecure hosts are blocked by a closed window.');
      }

      if (fleetSummary.staleAuth > 0) {
        score -= Math.min(28, fleetSummary.staleAuth * 7);
        addRadar(
          'warn',
          `${plural(fleetSummary.staleAuth, 'stale auth digest')}`,
          'Secure hosts should refresh against canonical auth.json.'
        );
      }

      if (fleetSummary.unprovisioned > 0) {
        score -= Math.min(16, fleetSummary.unprovisioned * 4);
        addRadar(
          'warn',
          `${plural(fleetSummary.unprovisioned, 'unprovisioned host')}`,
          'Hosts are registered but have not completed their first successful /auth.'
        );
      }

      if (fleetSummary.behindVersion > 0) {
        score -= Math.min(16, fleetSummary.behindVersion * 4);
        addRadar(
          'warn',
          `${plural(fleetSummary.behindVersion, 'host')} behind target version`,
          'Wrapper or Codex client version drift detected.'
        );
      }

      const validation = runnerInfo?.latest_validation || null;
      const validationStatus = String(validation?.status || '').toLowerCase();
      const runnerState = String(runnerInfo?.runner_state || '').toLowerCase();
      if (runnerInfo?.enabled) {
        if (validationStatus && validationStatus !== 'ok') {
          score -= 12;
          addRadar('danger', `Runner validation ${validationStatus}`, 'Validation service reported a non-ok state.');
        } else if (runnerState === 'fail') {
          score -= 10;
          addRadar('danger', 'Runner state fail', 'Validation worker failed during the latest run.');
        } else {
          addRadar('ok', 'Runner validation healthy', validation?.created_at ? `Last validation ${formatRelative(validation.created_at)}.` : 'Ready for the next validation run.');
        }
      } else {
        addRadar('neutral', 'Runner disabled', 'Auth uploads are accepted without live runner validation.');
      }

      if (Number.isFinite(monthPercentOfPlan)) {
        if (monthPercentOfPlan >= 100) {
          score -= 8;
          addRadar('warn', `${formatPercent(monthPercentOfPlan, 0)} of plan consumed`, 'Estimated monthly spend is at or above plan baseline.');
        } else if (monthPercentOfPlan >= 85) {
          score -= 4;
          addRadar('warn', `${formatPercent(monthPercentOfPlan, 0)} of plan consumed`, 'Spend is approaching plan baseline.');
        } else if (monthPercentOfPlan <= 55) {
          addRadar('ok', `Spend efficiency ${formatPercent(monthPercentOfPlan, 0)}`, 'Current API spend remains well below plan baseline.');
        }
      }

      if (quotaHardStop) {
        if (quotaLimit <= 85) {
          score -= 6;
          addRadar('warn', `Hard-stop quota at ${quotaLimit}%`, 'Non-VIP hosts will refuse launch once this threshold is reached.');
        } else {
          addRadar('neutral', `Hard-stop quota at ${quotaLimit}%`, 'Quota guardrail is enforced for non-VIP hosts.');
        }
      } else {
        addRadar('ok', `Warn-only quota at ${quotaLimit}%`, 'Hosts continue launching after warnings.');
      }

      score = Math.max(0, Math.min(100, Math.round(score)));
      const tone = score >= 85 ? 'ok' : (score >= 70 ? 'warn' : 'danger');
      const label = score >= 85 ? 'Stable' : (score >= 70 ? 'Watch' : 'Action Needed');

      return {
        score,
        tone,
        label,
        radar: radar.slice(0, 6),
      };
    }

    function renderStats(data, runnerInfo = null, hostsList = currentHosts) {
      lastOverview = data;
      if (!statsEl) return;

      const safeData = data || {};
      const versions = safeData.versions || {};
      const hostTotalFromOverview = Number(safeData?.totals?.hosts);

      latestVersions = {
        client: typeof versions.client_version === 'string'
          ? versions.client_version.trim().replace(/^v/i, '')
          : null,
        wrapper: typeof versions.wrapper_version === 'string'
          ? versions.wrapper_version.trim().replace(/^v/i, '')
          : null,
      };

      tokensSummary = safeData.tokens || null;

      const codexVersion = typeof versions.client_version === 'string'
        ? versions.client_version.trim()
        : null;
      const codexVersionDisplay = codexVersion && codexVersion !== '' ? codexVersion.replace(/^v/i, '') : 'n/a';
      const checkedAt = formatRelative(versions.client_version_checked_at);

      const fleetSummary = summarizeDashboardHosts(Array.isArray(hostsList) ? hostsList : []);
      const hostTotal = Number.isFinite(hostTotalFromOverview) ? hostTotalFromOverview : fleetSummary.total;
      const hostDenominator = hostTotal > 0 ? hostTotal : 1;
      const secureRatio = hostTotal > 0 ? (fleetSummary.secure / hostDenominator) * 100 : 0;

      const tokensMonth = safeData.tokens_month || {};
      const tokensWeek = safeData.tokens_week || {};
      const tokensDay = safeData.tokens_day || {};
      const getToken = (bucket, key) => {
        const v = Number(bucket?.[key]);
        return Number.isFinite(v) ? v : 0;
      };
      const monthInput = getToken(tokensMonth, 'input');
      const monthOutput = getToken(tokensMonth, 'output');
      const monthCached = getToken(tokensMonth, 'cached');
      const monthReasoning = getToken(tokensMonth, 'reasoning');
      const monthTotal = getToken(tokensMonth, 'total') || (monthInput + monthOutput + monthCached + monthReasoning);
      const weekTotal = getToken(tokensWeek, 'total') || (getToken(tokensWeek, 'input') + getToken(tokensWeek, 'output') + getToken(tokensWeek, 'cached') + getToken(tokensWeek, 'reasoning'));
      const dayTotal = getToken(tokensDay, 'total') || (getToken(tokensDay, 'input') + getToken(tokensDay, 'output') + getToken(tokensDay, 'cached') + getToken(tokensDay, 'reasoning'));
      const averageTokensPerHost = hostTotal > 0 ? (monthTotal / hostTotal) : 0;

      const topTokenHost = (Array.isArray(hostsList) ? hostsList : []).reduce((best, host) => {
        const hostTokens = Number(host?.token_usage?.total);
        if (!Number.isFinite(hostTokens)) return best;
        const bestTokens = Number(best?.token_usage?.total);
        if (!best || !Number.isFinite(bestTokens) || hostTokens > bestTokens) return host;
        return best;
      }, null);
      const topHostLabel = topTokenHost
        ? `${clipText(topTokenHost.fqdn || `host #${topTokenHost.id}`, 24)} · ${formatCompactNumber(topTokenHost.token_usage.total)}`
        : 'No host usage yet';

      const currency = typeof safeData?.pricing?.currency === 'string'
        ? safeData.pricing.currency.toUpperCase()
        : 'USD';
      const normalizeCost = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };
      const dayCost = normalizeCost(safeData?.pricing_day_cost);
      const weekCost = normalizeCost(safeData?.pricing_week_cost);
      const monthCost = normalizeCost(safeData?.pricing_month_cost);
      const subscriptionPlans = safeData?.subscription_plans || {};
      const planCurrency = typeof subscriptionPlans?.currency === 'string' && subscriptionPlans.currency.trim() !== ''
        ? subscriptionPlans.currency.trim().toUpperCase()
        : currency;
      const planPlusCost = normalizeCost(subscriptionPlans?.plus_cost);
      const planProCost = normalizeCost(subscriptionPlans?.pro_cost);
      const planOptions = [];
      if (planPlusCost > 0) planOptions.push({ key: 'plus', label: 'Plus', cost: planPlusCost });
      if (planProCost > 0) planOptions.push({ key: 'pro', label: 'Pro', cost: planProCost });
      const planKeyFromStats = (() => {
        const planType = safeData?.chatgpt_usage?.plan_type;
        if (typeof planType !== 'string') return null;
        const lower = planType.toLowerCase();
        if (lower.includes('pro')) return 'pro';
        if (lower.includes('plus')) return 'plus';
        return null;
      })();
      const selectedPlanKey = planOptions.some((p) => p.key === planKeyFromStats)
        ? planKeyFromStats
        : (planOptions.some((p) => p.key === 'pro') ? 'pro' : (planOptions[0]?.key ?? null));
      const selectedPlan = selectedPlanKey ? (planOptions.find((p) => p.key === selectedPlanKey) || null) : null;
      const planCost = selectedPlan ? selectedPlan.cost : 0;
      const monthPercentOfPlan = planCost > 0 ? (monthCost / planCost) * 100 : null;
      const isOverpaying = planCost > 0 && monthCost < planCost;
      const overpayAmount = isOverpaying ? (planCost - monthCost) : 0;
      const costLevelClass = (() => {
        if (planCost <= 0) return '';
        if (monthPercentOfPlan !== null && monthPercentOfPlan >= 100) return 'cost-red';
        if (monthPercentOfPlan !== null && monthPercentOfPlan >= 85) return 'cost-yellow';
        return isOverpaying ? '' : 'cost-green';
      })();

      runnerSummary = runnerInfo;
      const validation = runnerInfo?.latest_validation || null;
      const validationStatus = validation?.status ?? (runnerInfo?.enabled ? 'no runs' : 'disabled');
      const runnerState = String(runnerInfo?.runner_state || (runnerInfo?.enabled ? 'unknown' : 'disabled')).toLowerCase();
      const runnerTone = (() => {
        if (runnerState === 'ok') return 'ok';
        if (runnerState === 'fail') return 'danger';
        if (!runnerInfo?.enabled) return 'neutral';
        if (String(validationStatus).toLowerCase() !== 'ok') return 'warn';
        return 'warn';
      })();
      const runnerToneLabel = runnerTone === 'ok'
        ? 'Healthy'
        : (runnerTone === 'danger' ? 'Failing' : (runnerTone === 'neutral' ? 'Disabled' : 'Watching'));
      const runnerLast = validation?.created_at
        ? formatRelative(validation.created_at)
        : (runnerInfo?.runner_last_check ? formatRelative(runnerInfo.runner_last_check) : '—');
      const validationLatency = Number.isFinite(Number(validation?.latency_ms))
        ? `${Number(validation.latency_ms)}ms`
        : 'n/a';

      const quotaMode = quotaHardFail ? 'Hard-stop' : 'Warn-only';
      const apiState = apiDisabled === true ? 'Disabled' : (apiDisabled === false ? 'Enabled' : 'Unknown');
      const pulse = computeDashboardPulse(fleetSummary, {
        runnerInfo,
        monthPercentOfPlan,
        quotaHardStop: quotaHardFail,
        quotaLimit: quotaLimitPercent,
      });

      const plural = (value, singular, pluralValue = `${singular}s`) => `${value} ${value === 1 ? singular : pluralValue}`;

      if (dashboardSignalStrip) {
        const signalItems = [
          { tone: 'neutral', label: `${formatNumber(hostTotal)} hosts tracked` },
          {
            tone: fleetSummary.locked > 0 ? 'danger' : 'ok',
            label: fleetSummary.locked > 0
              ? `${plural(fleetSummary.locked, 'locked window')}`
              : 'No locked insecure windows',
          },
          {
            tone: fleetSummary.staleAuth > 0 ? 'warn' : 'ok',
            label: fleetSummary.staleAuth > 0
              ? `${plural(fleetSummary.staleAuth, 'stale auth digest')}`
              : 'Auth digests aligned',
          },
          { tone: runnerTone, label: `Runner ${runnerToneLabel}` },
          {
            tone: quotaHardFail ? 'warn' : 'ok',
            label: `${quotaMode} @ ${quotaLimitPercent}%`,
          },
          {
            tone: apiDisabled === true ? 'danger' : (apiDisabled === false ? 'ok' : 'neutral'),
            label: `API ${apiState}`,
          },
        ];
        dashboardSignalStrip.innerHTML = signalItems.map((item) => `
          <span class="signal-chip ${item.tone}">${escapeHtml(item.label)}</span>
        `).join('');
      }

      if (dashboardRadarCard) {
        const radarItems = pulse.radar.length
          ? pulse.radar
          : [{ tone: 'ok', title: 'No active blockers', detail: 'Everything looks quiet. Keep shipping.' }];
        dashboardRadarCard.innerHTML = `
          <div class="radar-head">
            <div>
              <div class="stat-label">Ops Radar</div>
              <h3>${radarItems[0]?.title ? escapeHtml(radarItems[0].title) : 'Operational highlights'}</h3>
              <p class="muted">Critical context for on-call and operators.</p>
            </div>
          </div>
          <ul class="radar-list">
            ${radarItems.map((item) => `
              <li class="radar-item ${item.tone}">
                <span class="radar-dot" aria-hidden="true"></span>
                <div>
                  <div class="radar-title">${escapeHtml(item.title)}</div>
                  <div class="radar-copy">${escapeHtml(item.detail)}</div>
                </div>
              </li>
            `).join('')}
          </ul>
        `;
      }

      const cards = [
        `
          <div class="card stat-card stat-card-2026 posture-card dashboard-equal-card dashboard-stat-card">
            <div class="stat-head">
              <span class="stat-label">Fleet posture</span>
              <span class="stat-kicker">${formatPercent(secureRatio, 0)} secure</span>
            </div>
            <div class="stat-value">${formatNumber(hostTotal)}</div>
            <small>Registered hosts</small>
            <div class="stat-breakdown">
              <div class="stat-row">
                <span>Secure</span>
                <strong>${formatNumber(fleetSummary.secure)}</strong>
              </div>
              <div class="stat-row">
                <span>Insecure</span>
                <strong>${formatNumber(fleetSummary.insecure)}</strong>
              </div>
              <div class="stat-row">
                <span>Locked windows</span>
                <strong>${formatNumber(fleetSummary.locked)}</strong>
              </div>
              <div class="stat-row">
                <span>Stale auth</span>
                <strong>${formatNumber(fleetSummary.staleAuth)}</strong>
              </div>
            </div>
          </div>
        `,
        `
          <div class="card stat-card stat-card-2026 throughput-card dashboard-equal-card dashboard-stat-card">
            <div class="stat-head">
              <span class="stat-label">Token throughput</span>
              <span class="stat-kicker">${formatCompactNumber(averageTokensPerHost)}/host</span>
            </div>
            <div class="stat-value">${formatCompactNumber(monthTotal)}</div>
            <small>Month-to-date tokens</small>
            <div class="stat-trend">
              <span class="trend-chip">Today ${formatCompactNumber(dayTotal)}</span>
              <span class="trend-chip">Week ${formatCompactNumber(weekTotal)}</span>
              <span class="trend-chip">Month ${formatCompactNumber(monthTotal)}</span>
            </div>
            <div class="stat-breakdown">
              <div class="stat-row">
                <span>Input</span>
                <strong>${formatCompactNumber(monthInput)}</strong>
              </div>
              <div class="stat-row">
                <span>Output</span>
                <strong>${formatCompactNumber(monthOutput)}</strong>
              </div>
              <div class="stat-row">
                <span>Cached</span>
                <strong>${formatCompactNumber(monthCached)}</strong>
              </div>
            </div>
            <div class="stat-note">Top emitter: ${escapeHtml(topHostLabel)}</div>
          </div>
        `,
        `
          <div class="card cost-card stat-card-2026 ${costLevelClass} dashboard-equal-card dashboard-stat-card">
            <div class="stat-head">
              <span class="stat-label">Spend intelligence</span>
              <span class="stat-sub cost-head-actions">
                <span class="cost-currency">${planCurrency}</span>
                <button class="ghost tiny-btn cost-history-btn cost-history-emoji" type="button" aria-label="Open cost trend">📊</button>
              </span>
            </div>
            <div class="stat-value">${formatCurrency(monthCost, planCurrency)}</div>
            <small>Estimated month total</small>
            ${selectedPlan && monthPercentOfPlan !== null ? `
              <div class="cost-meta">
                <span class="cost-chip">${selectedPlan.label} ${formatCurrency(planCost, planCurrency)}</span>
                <span class="cost-chip">${formatPercent(monthPercentOfPlan, 0)} of plan</span>
              </div>
              ${isOverpaying ? `<div class="stat-note">Overpaying by ${formatCurrency(overpayAmount, planCurrency)}</div>` : ''}
            ` : '<div class="stat-note">Plan baseline unavailable.</div>'}
            <div class="stat-trend">
              <span class="trend-chip">Today ${formatCurrency(dayCost, planCurrency)}</span>
              <span class="trend-chip">Week ${formatCurrency(weekCost, planCurrency)}</span>
              <span class="trend-chip">Month ${formatCurrency(monthCost, planCurrency)}</span>
            </div>
          </div>
        `,
        `
          <div class="card stat-card stat-card-2026 runtime-card dashboard-equal-card dashboard-stat-card">
            <div class="stat-head">
              <span class="stat-label">Runtime guardrails</span>
              <span class="stat-kicker tone-${runnerTone}">${runnerToneLabel}</span>
            </div>
            <div class="stat-value tone-${runnerTone}">${runnerToneLabel}</div>
            <small>Runner ${escapeHtml(String(validationStatus))} · ${escapeHtml(runnerLast)}</small>
            <div class="stat-breakdown">
              <div class="stat-row">
                <span>Validation latency</span>
                <strong>${escapeHtml(validationLatency)}</strong>
              </div>
              <div class="stat-row">
                <span>Quota mode</span>
                <strong>${escapeHtml(quotaMode)} @ ${escapeHtml(String(quotaLimitPercent))}%</strong>
              </div>
              <div class="stat-row">
                <span>API state</span>
                <strong>${escapeHtml(apiState)}</strong>
              </div>
              <div class="stat-row">
                <span>Codex target</span>
                <strong>${codexVersion ? `<span class="upgrade-trigger clickable" data-version="${escapeHtml(codexVersion)}">v${escapeHtml(codexVersionDisplay)}</span>` : 'n/a'}</strong>
              </div>
            </div>
            <div class="stat-note">Wrapper ${escapeHtml(versions.wrapper_version ?? 'n/a')} · checked ${escapeHtml(checkedAt)}</div>
          </div>
        `,
      ];

      statsEl.innerHTML = cards.join('\n');
      wireRunnerCardControls();
      wireUpgradeNotesControls();

      chatgptUsage = {
        snapshot: safeData.chatgpt_usage || null,
        summary: safeData.chatgpt_usage_summary || null,
        active_lane: safeData?.chatgpt_usage_summary?.active_quota_lane || safeData?.chatgpt_usage?.active_quota_lane || null,
        cached: safeData.chatgpt_cached || false,
        next_eligible_at: safeData.chatgpt_next_eligible_at || null,
      };
      renderChatGptUsage(chatgptUsage);
    }

    function destroyDashboardCharts() {
      if (dashboardQuotaChart && typeof dashboardQuotaChart.destroy === 'function') {
        dashboardQuotaChart.destroy();
      }
      if (dashboardCostChart && typeof dashboardCostChart.destroy === 'function') {
        dashboardCostChart.destroy();
      }
      dashboardQuotaChart = null;
      dashboardCostChart = null;
      dashboardQuotaPoints = [];
      dashboardCostPoints = [];
      dashboardQuotaPinnedIndex = null;
      dashboardCostPinnedIndex = null;
    }

    function colorWithAlpha(color, alpha = 1) {
      const safeAlpha = clamp(Number(alpha), 0, 1);
      const source = String(color || '').trim();
      if (/^#([0-9a-f]{6})$/i.test(source)) {
        const hex = source.slice(1);
        const r = Number.parseInt(hex.slice(0, 2), 16);
        const g = Number.parseInt(hex.slice(2, 4), 16);
        const b = Number.parseInt(hex.slice(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
      }
      if (/^#([0-9a-f]{3})$/i.test(source)) {
        const hex = source.slice(1);
        const r = Number.parseInt(hex.charAt(0) + hex.charAt(0), 16);
        const g = Number.parseInt(hex.charAt(1) + hex.charAt(1), 16);
        const b = Number.parseInt(hex.charAt(2) + hex.charAt(2), 16);
        return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
      }
      return source;
    }

    function dashboardRangeWindow(days) {
      const safeDays = clampRangeDays(days);
      const until = new Date();
      const from = new Date(until.getTime());
      from.setUTCDate(from.getUTCDate() - safeDays + 1);
      from.setUTCHours(0, 0, 0, 0);
      return {
        days: safeDays,
        from,
        until,
        fromIso: from.toISOString(),
        untilIso: until.toISOString(),
        shiftMs: until.getTime() - from.getTime(),
      };
    }

    function normalizeQuotaHistorySeries(history) {
      const palette = new Map(QUOTA_SERIES_META.map((item) => [item.key, item]));
      const result = [];
      const pushSeries = (key, label, values) => {
        const points = (values || [])
          .map((pt) => {
            const ts = parseTimestamp(pt?.ts || pt?.fetched_at || null);
            const val = Number(pt?.value ?? pt?.y);
            if (!ts || !Number.isFinite(val)) return null;
            return { x: ts.getTime(), y: clamp(val, 0, 130) };
          })
          .filter(Boolean)
          .sort((a, b) => a.x - b.x);
        if (!points.length) return;
        const style = palette.get(key);
        result.push({
          key,
          label: label || style?.label || key,
          color: style?.color || '#0b7c73',
          points,
        });
      };

      const series = Array.isArray(history?.series) ? history.series : [];
      if (series.length) {
        series.forEach((item) => {
          const key = String(item?.key || '').trim().toLowerCase();
          pushSeries(key, item?.label, item?.points);
        });
        if (result.length) return result;
      }

      const fallbackDefs = [
        { key: 'normal_primary', label: 'Normal 5-hour', lane: 'normal', window: 'primary' },
        { key: 'normal_secondary', label: 'Normal weekly', lane: 'normal', window: 'secondary' },
        { key: 'spark_primary', label: 'Spark 5-hour', lane: 'spark', window: 'primary' },
        { key: 'spark_secondary', label: 'Spark weekly', lane: 'spark', window: 'secondary' },
      ];
      fallbackDefs.forEach((definition) => {
        const values = buildUsageSeries(history?.points || [], definition.lane, definition.window);
        pushSeries(definition.key, definition.label, values);
      });
      return result;
    }

    function normalizeCostHistorySeries(history) {
      const palette = new Map(COST_SERIES.map((item) => [item.key, item]));
      const result = [];
      const pushSeries = (key, label, values) => {
        const points = (values || [])
          .map((pt) => {
            const ts = parseTimestamp(pt?.ts || null) || parseDateOnly(pt?.date || null);
            const val = Number(pt?.value ?? pt?.y);
            if (!ts || !Number.isFinite(val)) return null;
            return { x: ts.getTime(), y: Math.max(0, val) };
          })
          .filter(Boolean)
          .sort((a, b) => a.x - b.x);
        if (!points.length) return;
        const style = palette.get(key);
        result.push({
          key,
          label: label || style?.label || key,
          color: style?.color || '#2563eb',
          points,
        });
      };

      const series = Array.isArray(history?.series) ? history.series : [];
      if (series.length) {
        series.forEach((item) => {
          const key = String(item?.key || '').trim().toLowerCase();
          pushSeries(key, item?.label, item?.points);
        });
        if (result.length) return result;
      }

      const fallback = buildCostSeries(history);
      fallback.forEach((item) => {
        pushSeries(item.key, item.label, item.values);
      });
      return result;
    }

    function buildSeriesPointIndex(series) {
      const byX = new Map();
      (series || []).forEach((item) => {
        (item?.points || []).forEach((point) => {
          const x = Number(point?.x);
          const y = Number(point?.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          if (!byX.has(x)) {
            byX.set(x, { x, values: {} });
          }
          byX.get(x).values[item.key] = y;
        });
      });
      return Array.from(byX.values()).sort((a, b) => a.x - b.x);
    }

    function selectedVisibleKeys(current, available) {
      const safeAvailable = Array.isArray(available) ? available : [];
      const preferred = Array.isArray(current) ? current.filter((key) => safeAvailable.includes(key)) : [];
      if (preferred.length > 0) return preferred;
      return safeAvailable.slice();
    }

    function buildCompareSeries(series, shiftMs) {
      return (series || []).map((item) => ({
        ...item,
        points: (item?.points || []).map((point) => ({
          x: point.x + shiftMs,
          y: point.y,
        })),
      }));
    }

    function renderDashboardQuotaMeta(index = null) {
      const el = document.getElementById('dashboardQuotaMeta');
      if (!el) return;
      if (!Array.isArray(dashboardQuotaPoints) || dashboardQuotaPoints.length === 0) {
        el.textContent = 'No quota data in the selected range.';
        return;
      }
      const lastIdx = dashboardQuotaPoints.length - 1;
      const idx = Number.isFinite(index) ? clamp(Math.round(index), 0, lastIdx) : lastIdx;
      const point = dashboardQuotaPoints[idx];
      const dateText = formatShortDate(new Date(point.x), true);
      const parts = QUOTA_SERIES_META
        .map((item) => {
          const value = point?.values?.[item.key];
          return Number.isFinite(value) ? `${item.label} ${Math.round(value)}%` : null;
        })
        .filter(Boolean);
      el.textContent = `${dateText} · ${parts.join(' · ') || 'No lane values'}`;
    }

    function renderDashboardCostMeta(index = null) {
      const el = document.getElementById('dashboardCostMeta');
      if (!el) return;
      if (!Array.isArray(dashboardCostPoints) || dashboardCostPoints.length === 0) {
        el.textContent = 'No cost data in the selected range.';
        return;
      }
      const lastIdx = dashboardCostPoints.length - 1;
      const idx = Number.isFinite(index) ? clamp(Math.round(index), 0, lastIdx) : lastIdx;
      const point = dashboardCostPoints[idx];
      const dateText = point?.dateObj ? formatShortDate(point.dateObj) : point?.date || '—';
      const total = formatMoney(point?.costs?.total ?? 0, dashboardCostCurrency);
      const tokens = formatNumber(point?.tokens?.total ?? 0);
      el.textContent = `${dateText} · Total ${total} · ${tokens} tokens`;
    }

    function syncVisibleSeriesPreference(chart, kind) {
      if (!chart || !Array.isArray(chart?.data?.datasets)) return;
      const visible = [];
      chart.data.datasets.forEach((dataset, idx) => {
        if (dataset?.compare === true) return;
        if (dataset?.seriesKey && chart.isDatasetVisible(idx)) {
          visible.push(dataset.seriesKey);
        }
      });
      if (kind === 'quota') {
        dashboardChartPrefs.quota_visible = visible;
      } else {
        dashboardChartPrefs.cost_visible = visible;
      }
      writeDashboardChartPrefs();
    }

    function wireDashboardChartCanvas(chart, kind) {
      if (!chart || !chart.canvas) return;
      const canvas = chart.canvas;
      canvas.tabIndex = 0;
      canvas.onkeydown = (event) => {
        const points = kind === 'quota' ? dashboardQuotaPoints : dashboardCostPoints;
        if (!Array.isArray(points) || points.length === 0) return;
        if (event.key === 'Escape') {
          if (kind === 'quota') {
            dashboardQuotaPinnedIndex = null;
            chart.$pinnedIndex = null;
            renderDashboardQuotaMeta();
          } else {
            dashboardCostPinnedIndex = null;
            chart.$pinnedIndex = null;
            renderDashboardCostMeta();
          }
          chart.update('none');
          return;
        }
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowLeft' ? -1 : 1;
        const current = kind === 'quota' ? dashboardQuotaPinnedIndex : dashboardCostPinnedIndex;
        const next = clamp((current ?? (points.length - 1)) + delta, 0, points.length - 1);
        chart.$pinnedIndex = next;
        if (kind === 'quota') {
          dashboardQuotaPinnedIndex = next;
          renderDashboardQuotaMeta(next);
        } else {
          dashboardCostPinnedIndex = next;
          renderDashboardCostMeta(next);
        }
        chart.update('none');
      };
      canvas.onclick = (event) => {
        const items = chart.getElementsAtEventForMode(event, 'nearest', { intersect: false }, false);
        if (!items.length) {
          chart.$pinnedIndex = null;
          if (kind === 'quota') {
            dashboardQuotaPinnedIndex = null;
            renderDashboardQuotaMeta();
          } else {
            dashboardCostPinnedIndex = null;
            renderDashboardCostMeta();
          }
          chart.update('none');
          return;
        }
        const idx = items[0].index;
        if (kind === 'quota') {
          dashboardQuotaPinnedIndex = dashboardQuotaPinnedIndex === idx ? null : idx;
          chart.$pinnedIndex = dashboardQuotaPinnedIndex;
          renderDashboardQuotaMeta(dashboardQuotaPinnedIndex);
        } else {
          dashboardCostPinnedIndex = dashboardCostPinnedIndex === idx ? null : idx;
          chart.$pinnedIndex = dashboardCostPinnedIndex;
          renderDashboardCostMeta(dashboardCostPinnedIndex);
        }
        chart.update('none');
      };
      canvas.onmouseleave = () => {
        if (kind === 'quota' && dashboardQuotaPinnedIndex === null) {
          renderDashboardQuotaMeta();
        }
        if (kind === 'cost' && dashboardCostPinnedIndex === null) {
          renderDashboardCostMeta();
        }
      };
    }

    function buildDashboardChartCsv(kind) {
      const points = kind === 'quota' ? dashboardQuotaPoints : dashboardCostPoints;
      if (!Array.isArray(points) || points.length === 0) return null;
      const visible = kind === 'quota'
        ? selectedVisibleKeys(dashboardChartPrefs?.quota_visible, QUOTA_SERIES_META.map((item) => item.key))
        : selectedVisibleKeys(dashboardChartPrefs?.cost_visible, COST_SERIES.map((item) => item.key));
      if (!visible.length) return null;
      const labelMap = kind === 'quota'
        ? new Map(QUOTA_SERIES_META.map((item) => [item.key, item.label]))
        : new Map(COST_SERIES.map((item) => [item.key, item.label]));
      const header = ['timestamp_utc', ...visible.map((key) => labelMap.get(key) || key)];
      const rows = points.map((point) => {
        const date = new Date(point.x);
        const values = visible.map((key) => {
          const value = point?.values?.[key];
          return Number.isFinite(value) ? String(value) : '';
        });
        return [date.toISOString(), ...values];
      });
      return [header, ...rows].map((row) => row.join(',')).join('\n');
    }

    function exportDashboardChartCsv(kind) {
      const csv = buildDashboardChartCsv(kind);
      if (!csv) {
        showToast({
          title: 'Export',
          message: 'No chart data available for CSV export.',
          level: 'warn',
        });
        return;
      }
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const today = new Date().toISOString().slice(0, 10);
      const range = clampRangeDays(dashboardChartPrefs?.range_days);
      const filename = `dashboard-${kind}-${range}d-${today}.csv`;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    }

    function updateDashboardChartControls() {
      if (!dashboardGrid) return;
      const range = clampRangeDays(dashboardChartPrefs?.range_days);
      dashboardGrid.querySelectorAll('[data-dashboard-range]').forEach((btn) => {
        const value = Number(btn.getAttribute('data-dashboard-range'));
        const active = value === range;
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      const compareBtn = document.getElementById('dashboardCompareBtn');
      if (compareBtn) {
        compareBtn.setAttribute('aria-pressed', dashboardChartPrefs?.compare_previous ? 'true' : 'false');
      }
      const typeBtn = document.getElementById('dashboardTypeBtn');
      if (typeBtn) {
        const type = normalizeChartType(dashboardChartPrefs?.chart_type);
        typeBtn.setAttribute('aria-pressed', type === 'stacked' ? 'true' : 'false');
        typeBtn.textContent = type === 'stacked' ? 'Stacked' : 'Line';
      }
    }

    function wireDashboardChartControls() {
      if (!dashboardGrid) return;
      dashboardGrid.querySelectorAll('[data-dashboard-range]').forEach((btn) => {
        btn.onclick = () => {
          const value = Number(btn.getAttribute('data-dashboard-range'));
          const next = clampRangeDays(value);
          if (next === dashboardChartPrefs.range_days) return;
          dashboardChartPrefs.range_days = next;
          writeDashboardChartPrefs();
          updateDashboardChartControls();
          refreshDashboardCharts(true);
        };
      });
      const compareBtn = document.getElementById('dashboardCompareBtn');
      if (compareBtn) {
        compareBtn.onclick = () => {
          dashboardChartPrefs.compare_previous = !dashboardChartPrefs.compare_previous;
          writeDashboardChartPrefs();
          updateDashboardChartControls();
          refreshDashboardCharts(true);
        };
      }
      const typeBtn = document.getElementById('dashboardTypeBtn');
      if (typeBtn) {
        typeBtn.onclick = () => {
          dashboardChartPrefs.chart_type = normalizeChartType(dashboardChartPrefs?.chart_type) === 'line' ? 'stacked' : 'line';
          writeDashboardChartPrefs();
          updateDashboardChartControls();
          refreshDashboardCharts(true);
        };
      }
      const quotaReset = document.getElementById('dashboardQuotaReset');
      if (quotaReset) {
        quotaReset.onclick = () => {
          if (dashboardQuotaChart && typeof dashboardQuotaChart.resetZoom === 'function') {
            dashboardQuotaChart.resetZoom();
          }
        };
      }
      const costReset = document.getElementById('dashboardCostReset');
      if (costReset) {
        costReset.onclick = () => {
          if (dashboardCostChart && typeof dashboardCostChart.resetZoom === 'function') {
            dashboardCostChart.resetZoom();
          }
        };
      }
      const quotaExport = document.getElementById('dashboardQuotaExport');
      if (quotaExport) quotaExport.onclick = () => exportDashboardChartCsv('quota');
      const costExport = document.getElementById('dashboardCostExport');
      if (costExport) costExport.onclick = () => exportDashboardChartCsv('cost');
      dashboardChartsWired = true;
      updateDashboardChartControls();
    }

    function ensureChartJsReady() {
      if (!window.Chart) return false;
      const Chart = window.Chart;
      if (!Chart.__dashboardZoomRegistered) {
        const zoomPlugin = window.chartjsPluginZoom || window.ChartZoom || window['chartjs-plugin-zoom'] || null;
        if (zoomPlugin) {
          try {
            Chart.register(zoomPlugin);
          } catch (_) {
            // Already registered or incompatible build.
          }
        }
        Chart.__dashboardZoomRegistered = true;
      }
      if (!Chart.__dashboardPinnedCrosshairRegistered) {
        const plugin = {
          id: 'dashboardPinnedCrosshair',
          afterDatasetsDraw(chart) {
            const idx = Number.isFinite(chart.$pinnedIndex) ? chart.$pinnedIndex : null;
            if (idx === null) return;
            const datasets = chart.data?.datasets || [];
            let xPixel = null;
            datasets.some((dataset) => {
              const point = dataset?.data?.[idx];
              if (!point || typeof point !== 'object') return false;
              const x = Number(point.x);
              if (!Number.isFinite(x)) return false;
              const xScale = chart.scales?.x;
              if (!xScale || typeof xScale.getPixelForValue !== 'function') return false;
              xPixel = xScale.getPixelForValue(x);
              return Number.isFinite(xPixel);
            });
            if (!Number.isFinite(xPixel)) return;
            const area = chart.chartArea;
            if (!area) return;
            const ctx = chart.ctx;
            ctx.save();
            ctx.strokeStyle = 'rgba(15,23,42,0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(xPixel, area.top);
            ctx.lineTo(xPixel, area.bottom);
            ctx.stroke();
            ctx.restore();
          },
        };
        try {
          Chart.register(plugin);
        } catch (_) {
          // ignore duplicate registration
        }
        Chart.__dashboardPinnedCrosshairRegistered = true;
      }
      return true;
    }

    async function refreshDashboardCharts(force = false) {
      if (!dashboardGrid || !isDashboardView()) return;
      if (!ensureChartJsReady()) {
        dashboardGrid.querySelectorAll('.dashboard-chart-status').forEach((el) => {
          el.textContent = 'Chart.js assets failed to load.';
          el.classList.add('error');
        });
        return;
      }

      const renderToken = ++dashboardChartRenderToken;
      const range = dashboardRangeWindow(dashboardChartPrefs?.range_days);
      const rangeDays = range.days;
      const quotaInterval = rangeDays <= 14 ? 'hour' : 'day';
      const costInterval = rangeDays <= 90 ? 'day' : 'week';
      const useCompare = !!dashboardChartPrefs?.compare_previous;
      const chartType = normalizeChartType(dashboardChartPrefs?.chart_type);

      const quotaStatus = document.getElementById('dashboardQuotaStatus');
      const costStatus = document.getElementById('dashboardCostStatus');
      if (quotaStatus) quotaStatus.textContent = 'Loading quota history…';
      if (costStatus) costStatus.textContent = 'Loading cost history…';

      const currentQuotaOpts = {
        days: rangeDays,
        from: range.fromIso,
        until: range.untilIso,
        interval: quotaInterval,
        lane: 'both',
        window: 'both',
      };
      const currentCostOpts = {
        days: rangeDays,
        from: range.fromIso,
        until: range.untilIso,
        interval: costInterval,
        group_by: 'component',
        include_tokens: true,
      };

      const previousWindow = dashboardRangeWindow(rangeDays);
      previousWindow.until = new Date(range.from.getTime() - 1000);
      previousWindow.from = new Date(previousWindow.until.getTime());
      previousWindow.from.setUTCDate(previousWindow.from.getUTCDate() - rangeDays + 1);
      previousWindow.from.setUTCHours(0, 0, 0, 0);
      previousWindow.fromIso = previousWindow.from.toISOString();
      previousWindow.untilIso = previousWindow.until.toISOString();
      previousWindow.shiftMs = range.from.getTime() - previousWindow.from.getTime();

      try {
        const requests = [
          loadUsageHistory(force, currentQuotaOpts),
          loadCostHistory(force, currentCostOpts),
        ];
        if (useCompare) {
          requests.push(
            loadUsageHistory(force, {
              ...currentQuotaOpts,
              from: previousWindow.fromIso,
              until: previousWindow.untilIso,
            }),
            loadCostHistory(force, {
              ...currentCostOpts,
              from: previousWindow.fromIso,
              until: previousWindow.untilIso,
            })
          );
        }
        const [quotaCurrent, costCurrent, quotaPrevious, costPrevious] = await Promise.all(requests);
        if (renderToken !== dashboardChartRenderToken) return;

        const quotaSeries = normalizeQuotaHistorySeries(quotaCurrent);
        const costSeries = normalizeCostHistorySeries(costCurrent);
        const quotaKeys = quotaSeries.map((item) => item.key);
        const costKeys = costSeries.map((item) => item.key);
        dashboardChartPrefs.quota_visible = selectedVisibleKeys(dashboardChartPrefs?.quota_visible, quotaKeys);
        dashboardChartPrefs.cost_visible = selectedVisibleKeys(dashboardChartPrefs?.cost_visible, costKeys);
        writeDashboardChartPrefs();

        const includeFill = chartType === 'stacked';
        const visibleQuota = new Set(dashboardChartPrefs.quota_visible);
        const visibleCost = new Set(dashboardChartPrefs.cost_visible);

        const quotaDatasets = quotaSeries.map((item) => ({
          label: item.label,
          data: item.points.map((point) => ({ x: point.x, y: point.y })),
          borderColor: item.color,
          backgroundColor: includeFill ? colorWithAlpha(item.color, 0.16) : colorWithAlpha(item.color, 0.08),
          borderWidth: 2.2,
          tension: 0.25,
          fill: includeFill ? 'origin' : false,
          pointRadius: 0,
          pointHitRadius: 10,
          hidden: !visibleQuota.has(item.key),
          parsing: false,
          seriesKey: item.key,
          compare: false,
          stack: includeFill ? 'quota' : undefined,
        }));
        if (useCompare && quotaPrevious) {
          const shifted = buildCompareSeries(normalizeQuotaHistorySeries(quotaPrevious), previousWindow.shiftMs);
          shifted.forEach((item) => {
            quotaDatasets.push({
              label: `${item.label} (prev)`,
              data: item.points.map((point) => ({ x: point.x, y: point.y })),
              borderColor: colorWithAlpha(item.color, 0.55),
              borderDash: [6, 5],
              borderWidth: 1.6,
              tension: 0.25,
              fill: false,
              pointRadius: 0,
              pointHitRadius: 8,
              hidden: !visibleQuota.has(item.key),
              parsing: false,
              seriesKey: item.key,
              compare: true,
            });
          });
        }

        const costDatasets = costSeries.map((item) => ({
          label: item.label,
          data: item.points.map((point) => ({ x: point.x, y: point.y })),
          borderColor: item.color,
          backgroundColor: includeFill ? colorWithAlpha(item.color, 0.14) : colorWithAlpha(item.color, 0.08),
          borderWidth: item.key === 'total' ? 2.8 : 2,
          tension: 0.2,
          fill: includeFill ? 'origin' : false,
          pointRadius: 0,
          pointHitRadius: 10,
          hidden: !visibleCost.has(item.key),
          parsing: false,
          seriesKey: item.key,
          compare: false,
          stack: includeFill ? 'cost' : undefined,
        }));
        if (useCompare && costPrevious) {
          const shifted = buildCompareSeries(normalizeCostHistorySeries(costPrevious), previousWindow.shiftMs);
          shifted.forEach((item) => {
            costDatasets.push({
              label: `${item.label} (prev)`,
              data: item.points.map((point) => ({ x: point.x, y: point.y })),
              borderColor: colorWithAlpha(item.color, 0.5),
              borderDash: [6, 5],
              borderWidth: 1.6,
              tension: 0.2,
              fill: false,
              pointRadius: 0,
              pointHitRadius: 8,
              hidden: !visibleCost.has(item.key),
              parsing: false,
              seriesKey: item.key,
              compare: true,
            });
          });
        }

        dashboardQuotaPoints = buildSeriesPointIndex(quotaSeries);
        dashboardCostPoints = buildCostPointIndex(costCurrent);
        dashboardCostCurrency = costCurrent?.currency || 'USD';

        const quotaCanvas = document.getElementById('dashboardQuotaCanvas');
        const costCanvas = document.getElementById('dashboardCostCanvas');
        if (!quotaCanvas || !costCanvas) return;

        if (dashboardQuotaChart) dashboardQuotaChart.destroy();
        if (dashboardCostChart) dashboardCostChart.destroy();

        const defaultLegendClick = window.Chart.defaults.plugins.legend.onClick;
        dashboardQuotaChart = new window.Chart(quotaCanvas.getContext('2d'), {
          type: 'line',
          data: { datasets: quotaDatasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            normalized: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
              legend: {
                labels: {
                  filter(item, chartData) {
                    return chartData.datasets[item.datasetIndex]?.compare !== true;
                  },
                },
                onClick: (event, legendItem, legend) => {
                  defaultLegendClick(event, legendItem, legend);
                  syncVisibleSeriesPreference(legend.chart, 'quota');
                },
              },
              tooltip: {
                callbacks: {
                  label(context) {
                    const value = Number(context.parsed?.y);
                    return `${context.dataset.label}: ${Math.round(value)}%`;
                  },
                },
              },
              decimation: {
                enabled: true,
                algorithm: 'lttb',
                samples: 900,
              },
              zoom: {
                pan: { enabled: true, mode: 'x' },
                zoom: {
                  wheel: { enabled: true },
                  pinch: { enabled: true },
                  mode: 'x',
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                ticks: {
                  maxTicksLimit: 8,
                  callback(value) {
                    return formatShortDate(new Date(Number(value)));
                  },
                },
              },
              y: {
                min: 0,
                max: 130,
                stacked: includeFill,
                ticks: {
                  callback(value) {
                    return `${Math.round(Number(value))}%`;
                  },
                },
              },
            },
            onHover(event, elements, chart) {
              if (dashboardQuotaPinnedIndex !== null) return;
              if (!elements || !elements.length) return;
              renderDashboardQuotaMeta(elements[0].index);
            },
          },
        });

        dashboardCostChart = new window.Chart(costCanvas.getContext('2d'), {
          type: 'line',
          data: { datasets: costDatasets },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            normalized: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
              legend: {
                labels: {
                  filter(item, chartData) {
                    return chartData.datasets[item.datasetIndex]?.compare !== true;
                  },
                },
                onClick: (event, legendItem, legend) => {
                  defaultLegendClick(event, legendItem, legend);
                  syncVisibleSeriesPreference(legend.chart, 'cost');
                },
              },
              tooltip: {
                callbacks: {
                  label(context) {
                    return `${context.dataset.label}: ${formatMoney(context.parsed?.y ?? 0, dashboardCostCurrency)}`;
                  },
                },
              },
              decimation: {
                enabled: true,
                algorithm: 'lttb',
                samples: 900,
              },
              zoom: {
                pan: { enabled: true, mode: 'x' },
                zoom: {
                  wheel: { enabled: true },
                  pinch: { enabled: true },
                  mode: 'x',
                },
              },
            },
            scales: {
              x: {
                type: 'linear',
                ticks: {
                  maxTicksLimit: 8,
                  callback(value) {
                    return formatShortDate(new Date(Number(value)));
                  },
                },
              },
              y: {
                min: 0,
                stacked: includeFill,
                ticks: {
                  callback(value) {
                    return formatMoney(value, dashboardCostCurrency);
                  },
                },
              },
            },
            onHover(event, elements, chart) {
              if (dashboardCostPinnedIndex !== null) return;
              if (!elements || !elements.length) return;
              renderDashboardCostMeta(elements[0].index);
            },
          },
        });

        wireDashboardChartCanvas(dashboardQuotaChart, 'quota');
        wireDashboardChartCanvas(dashboardCostChart, 'cost');
        renderDashboardQuotaMeta();
        renderDashboardCostMeta();
        if (quotaStatus) quotaStatus.textContent = `Range ${rangeDays} days · interval ${quotaInterval}`;
        if (costStatus) costStatus.textContent = `Range ${rangeDays} days · interval ${costInterval}`;
      } catch (err) {
        if (quotaStatus) quotaStatus.textContent = `Failed loading quota history: ${err.message}`;
        if (costStatus) costStatus.textContent = `Failed loading cost history: ${err.message}`;
      }
    }

    function renderDashboardGrid(data, runnerInfo = null, hostsList = []) {
      if (!dashboardGrid) return;
      dashboardChartsWired = false;
      dashboardGrid.innerHTML = `
        <section class="card dashboard-chart-shell">
          <div class="dashboard-chart-controls">
            <div class="dashboard-chart-ranges" role="group" aria-label="History range">
              ${DASHBOARD_RANGE_PRESETS.map((days) => `<button type="button" class="ghost tiny-btn dashboard-range-btn" data-dashboard-range="${days}" aria-pressed="false">${days}D</button>`).join('')}
            </div>
            <div class="dashboard-chart-actions">
              <button type="button" class="ghost tiny-btn" id="dashboardCompareBtn" aria-pressed="false">Compare previous</button>
              <button type="button" class="ghost tiny-btn" id="dashboardTypeBtn" aria-pressed="false">Line</button>
            </div>
          </div>
          <div class="dashboard-chart-panels">
            <section class="dashboard-chart-card">
              <div class="dashboard-chart-head">
                <div>
                  <div class="stat-label">Quota trend</div>
                  <h3>ChatGPT lane utilization</h3>
                </div>
                <div class="dashboard-chart-head-actions">
                  <button type="button" class="ghost tiny-btn" id="dashboardQuotaReset">Reset zoom</button>
                  <button type="button" class="ghost tiny-btn" id="dashboardQuotaExport">Export CSV</button>
                </div>
              </div>
              <div class="dashboard-chart-canvas-wrap">
                <canvas id="dashboardQuotaCanvas" aria-label="ChatGPT quota trend"></canvas>
              </div>
              <div class="muted dashboard-chart-meta" id="dashboardQuotaMeta">Loading quota details…</div>
              <div class="muted dashboard-chart-status" id="dashboardQuotaStatus">Loading…</div>
            </section>
            <section class="dashboard-chart-card">
              <div class="dashboard-chart-head">
                <div>
                  <div class="stat-label">Cost trend</div>
                  <h3>Token spend over time</h3>
                </div>
                <div class="dashboard-chart-head-actions">
                  <button type="button" class="ghost tiny-btn" id="dashboardCostReset">Reset zoom</button>
                  <button type="button" class="ghost tiny-btn" id="dashboardCostExport">Export CSV</button>
                </div>
              </div>
              <div class="dashboard-chart-canvas-wrap">
                <canvas id="dashboardCostCanvas" aria-label="Cost trend"></canvas>
              </div>
              <div class="muted dashboard-chart-meta" id="dashboardCostMeta">Loading cost details…</div>
              <div class="muted dashboard-chart-status" id="dashboardCostStatus">Loading…</div>
            </section>
          </div>
        </section>
      `;
      wireDashboardChartControls();
      refreshDashboardCharts();
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
        const [overview, hosts, runner, prompts, skills, agents] = await Promise.all([
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
          api('/admin/skills').catch(err => {
            console.warn('Skills unavailable', err);
            return null;
          }),
          api('/admin/agents').catch(err => {
            console.warn('AGENTS.md unavailable', err);
            return null;
          }),
        ]);

        currentOverview = overview.data || {};
        const hostsList = hosts?.data?.hosts || [];

        setMtls(currentOverview.mtls);

        if (typeof currentOverview.inactivity_window_days !== 'undefined') {
          inactivityWindowDays = clampInactivityWindowDays(currentOverview.inactivity_window_days);
          renderInactivityWindowDays();
        }

        renderStats(currentOverview, runner?.data || null, hostsList);
        renderDashboardGrid(currentOverview, runner?.data || null, hostsList);
        renderHosts(hostsList);
        renderInsecureHostsQuickButton(hostsList);
        renderPrompts(prompts?.data?.commands || []);
        renderSkills(skills?.data?.skills || []);
        renderAgents(agents?.data || { status: 'missing' });
        await loadMemories();

        if (typeof currentOverview.quota_limit_percent !== 'undefined') {
          quotaLimitPercent = clampQuotaLimitPercent(currentOverview.quota_limit_percent);
        }
        if (typeof currentOverview.quota_week_partition !== 'undefined') {
          quotaWeekPartition = normalizeQuotaPartition(currentOverview.quota_week_partition);
        }
        if (typeof currentOverview.quota_hard_fail !== 'undefined') {
          quotaHardFail = !!currentOverview.quota_hard_fail;
        }
        renderQuotaMode();

        if (typeof currentOverview.cdx_silent !== 'undefined') {
          cdxSilent = !!currentOverview.cdx_silent;
          renderCdxSilent();
        }
        if (typeof currentOverview.reverse_dns_enabled !== 'undefined') {
          reverseDnsEnabled = !!currentOverview.reverse_dns_enabled;
          renderReverseDns();
        }
        if (typeof currentOverview.insecure_approval_enabled !== 'undefined') {
          insecureApprovalEnabled = !!currentOverview.insecure_approval_enabled;
          renderInsecureApproval();
        }
        if (typeof currentOverview.auto_update_enabled !== 'undefined') {
          autoUpdateEnabled = !!currentOverview.auto_update_enabled;
          renderAutoUpdate();
        }
        await loadCodexVersionControl();
        evaluateSeedRequirement(currentOverview, hostsList);
      } catch (err) {
        if (mtlsStatus) {
          mtlsStatus.textContent = 'mTLS / Admin access failed';
          mtlsStatus.classList.add('error');
        }
        if (statsEl) {
          statsEl.innerHTML = `<div class="card"><div class="error">Error: ${err.message}</div></div>`;
        }
      }
    }

    function isInsecureHost(host) {
      return host && !isHostSecure(host);
    }

    function hostHasActiveInsecureWindow(host) {
      if (!host || !isInsecureHost(host)) return false;
      if (typeof host?.active === 'boolean') return host.active;
      return insecureState(host).enabledActive;
    }

    function renderInsecureHostsQuickButton(hostsList) {
      if (!navInsecureHosts) return;
      const activeCount = Array.isArray(hostsList) ? hostsList.filter((host) => hostHasActiveInsecureWindow(host)).length : 0;
      if (activeCount > 0) {
        navInsecureHosts.style.display = '';
        navInsecureHosts.textContent = `Active Windows (${activeCount})`;
      } else {
        navInsecureHosts.style.display = 'none';
      }
    }

    function shouldRefreshInsecureModalForAction(action) {
      if (!action) return false;
      return action.startsWith('admin.host.insecure_')
        || action.startsWith('admin.insecure.')
        || action.startsWith('auth.insecure.');
    }

    function refreshInsecureHostsCountdowns() {
      if (!insecureModalOpen || !insecureHostsModal) return;
      const nodes = insecureHostsModal.querySelectorAll('[data-countdown][data-until]');
      nodes.forEach((node) => {
        const until = node.getAttribute('data-until') || '';
        if (!until) return;
        const kind = node.getAttribute('data-countdown');
        const prefix = kind === 'domain' ? 'Auto-allow: ' : 'Online: ';
        const remaining = formatCountdown(until);
        if (remaining === '—') {
          scheduleInsecureHostsModalRefresh(500);
          return;
        }
        node.textContent = `${prefix}${remaining}`;
      });
    }

    function scheduleInsecureHostsModalRefresh(delayMs = 200) {
      if (!insecureModalOpen) return;
      if (insecureModalRefreshTimer) return;
      insecureModalRefreshTimer = window.setTimeout(async () => {
        insecureModalRefreshTimer = null;
        if (!insecureModalOpen) return;
        try {
          const resp = await api('/admin/hosts/insecure');
          const insecureHosts = resp?.data?.hosts || [];
          const insecureDomains = resp?.data?.domains || [];
          openInsecureHostsModal(insecureHosts, insecureDomains);
        } catch (err) {
          console.warn('failed to refresh insecure hosts modal', err);
        }
      }, delayMs);
    }

    function closeInsecureHostsModal() {
      if (!insecureHostsModal) return;
      insecureHostsModal.classList.remove('show');
      if (insecureHostsList) insecureHostsList.innerHTML = '';
      if (insecureDomainsList) insecureDomainsList.innerHTML = '';
      insecureModalOpen = false;
      if (insecureModalRefreshTimer) {
        window.clearTimeout(insecureModalRefreshTimer);
        insecureModalRefreshTimer = null;
      }
      if (insecureModalCountdownTimer) {
        window.clearInterval(insecureModalCountdownTimer);
        insecureModalCountdownTimer = null;
      }
    }

    function openInsecureHostsModal(insecureHosts, insecureDomains) {
      if (!insecureHostsModal || !insecureHostsList) return;
      const items = Array.isArray(insecureHosts) ? insecureHosts.slice() : [];
      const activeFirst = (a, b) => {
        const aActive = hostHasActiveInsecureWindow(a);
        const bActive = hostHasActiveInsecureWindow(b);
        if (aActive !== bActive) return aActive ? -1 : 1;
        return String(a?.fqdn || '').localeCompare(String(b?.fqdn || ''), undefined, { sensitivity: 'base' });
      };
      items.sort(activeFirst);
      const activeHosts = items.filter((host) => hostHasActiveInsecureWindow(host));
      const activeCount = activeHosts.length;
      renderInsecureHostsQuickButton(items);
      if (insecureHostsDisableAllBtn) {
        insecureHostsDisableAllBtn.style.display = activeCount > 0 ? '' : 'none';
      }

      if (!items.length) {
        insecureHostsList.innerHTML = '<div class="quick-hosts-row"><div class="quick-hosts-info"><div class="quick-hosts-fqdn muted">No insecure hosts found.</div></div></div>';
      } else {
        insecureHostsList.innerHTML = items.map((host) => {
          const active = hostHasActiveInsecureWindow(host);
          const onlineFor = active ? formatCountdown(host?.insecure_enabled_until) : 'Window closed';
          const onlineUntil = active ? (host?.insecure_enabled_until || '') : '';
          const onlineLine = active
            ? (onlineFor !== '—'
              ? `<div class="quick-hosts-sub" data-countdown="host" data-until="${escapeHtml(onlineUntil)}">Online: ${escapeHtml(onlineFor)}</div>`
              : '<div class="quick-hosts-sub">Online now</div>')
            : '<div class="quick-hosts-sub">Window closed</div>';
          const action = active ? 'disable' : 'enable';
          const label = active ? 'Disable' : 'Enable';
          return `
            <div class="quick-hosts-row" data-host-id="${host.id}">
              <div class="quick-hosts-info">
                <div class="quick-hosts-fqdn">${escapeHtml(host.fqdn || '')}</div>
                ${onlineLine}
              </div>
              <div class="quick-hosts-actions">
                <button class="ghost" data-action="${action}">${label}</button>
              </div>
            </div>
          `;
        }).join('');
      }

      if (insecureDomainsList) {
        const domains = Array.isArray(insecureDomains) ? insecureDomains.slice() : [];
        const domainActive = (domain) => !!domain?.active;
        const activeDomainFirst = (a, b) => {
          const aActive = domainActive(a);
          const bActive = domainActive(b);
          if (aActive !== bActive) return aActive ? -1 : 1;
          return String(a?.domain || '').localeCompare(String(b?.domain || ''), undefined, { sensitivity: 'base' });
        };
        domains.sort(activeDomainFirst);

        if (!domains.length) {
          insecureDomainsList.innerHTML = '<div class="quick-hosts-row"><div class="quick-hosts-info"><div class="quick-hosts-fqdn muted">No domains auto-allowed yet.</div></div></div>';
        } else {
          insecureDomainsList.innerHTML = domains.map((domain) => {
            const isActive = domainActive(domain);
            const label = 'Revoke';
            const btnClass = 'ghost';
            const onlineFor = isActive ? formatCountdown(domain?.enabled_until) : '';
            const onlineUntil = isActive ? (domain?.enabled_until || '') : '';
            const onlineLine = isActive && onlineFor !== '—'
              ? `<div class="quick-hosts-sub" data-countdown="domain" data-until="${escapeHtml(onlineUntil)}">Auto-allow: ${escapeHtml(onlineFor)}</div>`
              : '';
            return `
              <div class="quick-hosts-row" data-domain-id="${domain.id}">
                <div class="quick-hosts-info">
                  <div class="quick-hosts-fqdn">${escapeHtml(domain.domain || '')}</div>
                  ${onlineLine}
                </div>
                <div class="quick-hosts-actions">
                  <button class="${btnClass}" data-action="revoke-domain">${label}</button>
                </div>
              </div>
            `;
          }).join('');
        }
      }

      insecureHostsModal.classList.add('show');
      insecureModalOpen = true;
      refreshInsecureHostsCountdowns();
      if (insecureModalCountdownTimer) {
        window.clearInterval(insecureModalCountdownTimer);
      }
      insecureModalCountdownTimer = window.setInterval(refreshInsecureHostsCountdowns, 15000);
    }

    async function loadAndOpenInsecureHostsModal() {
      try {
        const resp = await api('/admin/hosts/insecure');
        const insecureHosts = resp?.data?.hosts || [];
        const insecureDomains = resp?.data?.domains || [];
        openInsecureHostsModal(insecureHosts, insecureDomains);
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    function bindInsecureHostsQuickAction() {
      if (navInsecureHosts) {
        navInsecureHosts.addEventListener('click', () => loadAndOpenInsecureHostsModal());
      }
      if (insecureHostsCloseBtn) {
        insecureHostsCloseBtn.addEventListener('click', () => closeInsecureHostsModal());
      }
      if (insecureHostsDisableAllBtn) {
        insecureHostsDisableAllBtn.addEventListener('click', async () => {
          insecureHostsDisableAllBtn.disabled = true;
          const original = insecureHostsDisableAllBtn.textContent;
          insecureHostsDisableAllBtn.textContent = 'Disabling…';
          try {
            const disableResp = await api('/admin/hosts/insecure/disable-all', { method: 'POST' });
            await loadAll();
            const resp = await api('/admin/hosts/insecure');
            openInsecureHostsModal(resp?.data?.hosts || [], resp?.data?.domains || []);
            const disabled = disableResp?.data?.disabled;
            const msg = Number.isFinite(disabled)
              ? `Disabled ${disabled} insecure host${disabled === 1 ? '' : 's'}`
              : 'Disabled active insecure hosts';
            toast(msg, 'ok');
          } catch (err) {
            console.error('disable all insecure hosts failed', err);
            toast(`Disable failed: ${err.message}`, 'error');
          } finally {
            insecureHostsDisableAllBtn.disabled = false;
            insecureHostsDisableAllBtn.textContent = original;
          }
        });
      }
      if (insecureHostsModal) {
        insecureHostsModal.addEventListener('click', (e) => {
          if (e.target === insecureHostsModal) closeInsecureHostsModal();
        });
      }
      if (insecureHostsList) {
        insecureHostsList.addEventListener('click', async (e) => {
          const btn = e.target?.closest?.('button[data-action]');
          if (!btn) return;
          const row = btn.closest('.quick-hosts-row');
          const hostIdRaw = row?.getAttribute?.('data-host-id');
          const hostId = hostIdRaw ? parseInt(hostIdRaw, 10) : NaN;
          if (!Number.isFinite(hostId)) return;
          const action = String(btn.getAttribute('data-action') || '').toLowerCase();
          const enableTarget = action === 'enable';

          btn.disabled = true;
          const originalLabel = btn.textContent;
          btn.textContent = enableTarget ? 'Turning on…' : 'Turning off…';
          try {
            const resp = await api('/admin/hosts/insecure');
            const hosts = resp?.data?.hosts || [];
            const target = hosts.find(h => (h?.id | 0) === hostId);
            if (!target) {
              throw new Error('Host not found (refresh and retry).');
            }
            await toggleInsecureApi(target, null, enableTarget);
            const refreshed = await api('/admin/hosts/insecure');
            openInsecureHostsModal(refreshed?.data?.hosts || [], refreshed?.data?.domains || []);
          } catch (err) {
            console.error('insecure hosts toggle failed', err);
            toast(`${enableTarget ? 'Enable' : 'Disable'} failed: ${err.message}`, 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
          }
        });
      }
      if (insecureDomainsList) {
        insecureDomainsList.addEventListener('click', async (e) => {
          const btn = e.target?.closest?.('button[data-action="revoke-domain"]');
          if (!btn) return;
          const row = btn.closest('.quick-hosts-row');
          const domainIdRaw = row?.getAttribute?.('data-domain-id');
          const domainId = domainIdRaw ? parseInt(domainIdRaw, 10) : NaN;
          if (!Number.isFinite(domainId)) return;

          btn.disabled = true;
          const originalLabel = btn.textContent;
          btn.textContent = 'Revoking…';
          try {
            await api(`/admin/insecure-domain-allows/${domainId}/revoke`, { method: 'POST' });
            const refreshed = await api('/admin/hosts/insecure');
            openInsecureHostsModal(refreshed?.data?.hosts || [], refreshed?.data?.domains || []);
          } catch (err) {
            console.error('insecure domains revoke failed', err);
            toast(`Revoke failed: ${err.message}`, 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = originalLabel;
          }
        });
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

    bindInsecureHostsQuickAction();

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

    function setAgentsInlineEditing(editing) {
      const on = !!editing;
      if (agentsPreview) agentsPreview.hidden = on;
      if (agentsEditorInline) agentsEditorInline.hidden = !on;
      if (agentsSaveInline) agentsSaveInline.hidden = !on;
      if (agentsEditToggle) agentsEditToggle.textContent = on ? 'Cancel' : 'Edit';
      if (on && agentsEditorInline) {
        const content = typeof currentAgents?.content === 'string' ? currentAgents.content : (agentsPreview?.textContent ?? '');
        agentsEditorInline.value = content;
        try { agentsEditorInline.focus(); } catch (_) {}
      }
      if (!on && agentsEditorInline) {
        agentsEditorInline.value = typeof currentAgents?.content === 'string' ? currentAgents.content : (agentsPreview?.textContent ?? '');
      }
    }

    async function saveAgentsInline() {
      if (!agentsEditorInline || !agentsSaveInline) return;
      const content = agentsEditorInline.value;
      agentsSaveInline.disabled = true;
      const original = agentsSaveInline.textContent;
      agentsSaveInline.textContent = 'Saving…';
      if (agentsStatus) agentsStatus.textContent = 'Saving…';
      try {
        await api('/admin/agents/store', {
          method: 'POST',
          json: { content },
        });
        await loadAll();
        setAgentsInlineEditing(false);
        if (agentsStatus) agentsStatus.textContent = 'Saved';
        setTimeout(() => {
          if (agentsStatus && agentsStatus.textContent === 'Saved') agentsStatus.textContent = '';
        }, 1500);
      } catch (err) {
        if (agentsStatus) agentsStatus.textContent = `Save failed: ${err.message}`;
      } finally {
        agentsSaveInline.disabled = false;
        agentsSaveInline.textContent = original;
      }
    }

    async function serveAgentsLatest() {
      if (agentsServeLatest) {
        agentsServeLatest.disabled = true;
      }
      if (agentsStatus) agentsStatus.textContent = 'Switching to latest…';
      try {
        await api('/admin/agents/serve', {
          method: 'POST',
          json: { mode: 'latest' },
        });
        await loadAll();
        if (agentsStatus) agentsStatus.textContent = 'Serving latest';
        setTimeout(() => {
          if (agentsStatus && agentsStatus.textContent === 'Serving latest') agentsStatus.textContent = '';
        }, 1500);
      } catch (err) {
        if (agentsStatus) agentsStatus.textContent = `Serve latest failed: ${err.message}`;
      } finally {
        if (agentsServeLatest) agentsServeLatest.disabled = false;
      }
    }

    async function serveAgentsVersion(versionId) {
      const id = Number(versionId);
      if (!Number.isFinite(id)) return;
      if (agentsStatus) agentsStatus.textContent = `Serving v${id}…`;
      try {
        await api('/admin/agents/serve', {
          method: 'POST',
          json: { mode: 'locked', version_id: id },
        });
        await loadAll();
        if (agentsStatus) agentsStatus.textContent = `Serving v${id}`;
        setTimeout(() => {
          if (agentsStatus && agentsStatus.textContent === `Serving v${id}`) agentsStatus.textContent = '';
        }, 1500);
      } catch (err) {
        if (agentsStatus) agentsStatus.textContent = `Serve failed: ${err.message}`;
      }
    }

    function agentsHostsUsingVersion(versionId) {
      const target = normalizeAgentsVersionId(versionId);
      if (!target) return [];
      return (Array.isArray(currentHosts) ? currentHosts : []).filter(host => (
        normalizeAgentsVersionId(host?.agents_document_id_override) === target
      ));
    }

    function renderAgentsDeleteHostsList(hosts) {
      if (!agentsDeleteHosts) return;
      if (!hosts.length) {
        agentsDeleteHosts.innerHTML = '<span class="muted">None</span>';
        return;
      }
      agentsDeleteHosts.innerHTML = hosts.map((host) => (
        `<div class="host-chip"><span class="host-name">${escapeHtml(host.fqdn || `Host #${host.id}`)}</span></div>`
      )).join('');
    }

    function openAgentsDeleteModal(versionId, hosts) {
      if (!agentsDeleteModal) return;
      const id = normalizeAgentsVersionId(versionId);
      if (!id) return;
      pendingAgentsDeleteId = id;
      pendingAgentsDeleteHosts = Array.isArray(hosts) ? hosts.slice() : [];
      if (agentsDeleteIntro) {
        const count = pendingAgentsDeleteHosts.length;
        const hostLabel = count === 1 ? 'host' : 'hosts';
        agentsDeleteIntro.textContent = `Version v${id} is the default for ${count} ${hostLabel} using it. Choose where to move them before deleting.`;
      }
      if (agentsDeleteSelect) {
        agentsDeleteSelect.innerHTML = buildAgentsVersionOptions(currentAgents, { excludeId: id });
        agentsDeleteSelect.value = 'global';
      }
      if (agentsDeleteStatus) agentsDeleteStatus.textContent = '';
      renderAgentsDeleteHostsList(pendingAgentsDeleteHosts);
      agentsDeleteModal.classList.add('show');
    }

    function closeAgentsDeleteModal() {
      if (!agentsDeleteModal) return;
      agentsDeleteModal.classList.remove('show');
      pendingAgentsDeleteId = null;
      pendingAgentsDeleteHosts = [];
      if (agentsDeleteStatus) agentsDeleteStatus.textContent = '';
      if (agentsDeleteIntro) agentsDeleteIntro.textContent = '';
      if (agentsDeleteHosts) agentsDeleteHosts.innerHTML = '';
    }

    async function confirmAgentsDelete() {
      if (!pendingAgentsDeleteId) return;
      const id = pendingAgentsDeleteId;
      const selection = agentsDeleteSelect ? String(agentsDeleteSelect.value || 'global') : 'global';
      if (selection === String(id)) {
        if (agentsDeleteStatus) agentsDeleteStatus.textContent = 'Choose a different version (cannot re-pin to the one being deleted).';
        return;
      }
      if (agentsDeleteConfirm) agentsDeleteConfirm.disabled = true;
      if (agentsDeleteCancel) agentsDeleteCancel.disabled = true;
      try {
        const affected = pendingAgentsDeleteHosts.slice();
        if (affected.length) {
          if (agentsDeleteStatus) agentsDeleteStatus.textContent = `Reassigning ${affected.length} host${affected.length === 1 ? '' : 's'}…`;
          for (const host of affected) {
            await api(`/admin/hosts/${host.id}/agents-version`, {
              method: 'POST',
              json: { selection },
            });
          }
        }
        if (agentsDeleteStatus) agentsDeleteStatus.textContent = `Deleting v${id}…`;
        await api(`/admin/agents/versions/${id}`, { method: 'DELETE' });
        await loadAll();
        if (agentsStatus) agentsStatus.textContent = `Deleted v${id}`;
        setTimeout(() => {
          if (agentsStatus && agentsStatus.textContent === `Deleted v${id}`) agentsStatus.textContent = '';
        }, 1500);
        closeAgentsDeleteModal();
      } catch (err) {
        if (agentsDeleteStatus) agentsDeleteStatus.textContent = `Delete failed: ${err.message}`;
      } finally {
        if (agentsDeleteConfirm) agentsDeleteConfirm.disabled = false;
        if (agentsDeleteCancel) agentsDeleteCancel.disabled = false;
      }
    }

    async function deleteAgentsVersion(versionId) {
      const id = Number(versionId);
      if (!Number.isFinite(id)) return;
      const affectedHosts = agentsHostsUsingVersion(id);
      if (affectedHosts.length) {
        openAgentsDeleteModal(id, affectedHosts);
        return;
      }
      if (!confirm(`Delete AGENTS.md version #${id}? This cannot be undone.`)) {
        return;
      }
      if (agentsStatus) agentsStatus.textContent = `Deleting v${id}…`;
      try {
        await api(`/admin/agents/versions/${id}`, { method: 'DELETE' });
        await loadAll();
        if (agentsStatus) agentsStatus.textContent = `Deleted v${id}`;
        setTimeout(() => {
          if (agentsStatus && agentsStatus.textContent === `Deleted v${id}`) agentsStatus.textContent = '';
        }, 1500);
      } catch (err) {
        if (agentsStatus) agentsStatus.textContent = `Delete failed: ${err.message}`;
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

    function showSkillModal(show) {
      if (!skillModal) return;
      if (show) {
        skillModal.classList.add('show');
      } else {
        skillModal.classList.remove('show');
      }
    }

    async function openSkillModal(slug) {
      if (!skillModal) return;
      const target = typeof slug === 'string' ? slug.trim() : '';
      skillEditingSlug = target;
      setSkillModalMode(target ? 'edit' : 'new', target);
      setSkillBadges(null);
      if (skillSlug) skillSlug.value = target;
      if (skillNameInput) skillNameInput.value = '';
      if (skillDescriptionInput) skillDescriptionInput.value = '';
      if (skillWhatInput) skillWhatInput.value = '';
      if (skillWhenInput) skillWhenInput.value = '';
      if (skillStepsInput) skillStepsInput.value = '';
      setSkillTags([]);
      skillSlugAutofill = !target;
      if (skillStatus) {
        skillStatus.textContent = target ? 'Loading…' : 'Slug, name, and sections are required.';
      }
      showSkillModal(true);
      if (!target) {
        skillNameInput?.focus();
        return;
      }
      try {
        const resp = await api(`/admin/skills/${encodeURIComponent(target)}`);
        const data = resp?.data || {};
        const parsed = parseSkillManifest(data.manifest || '');
        const loadedSlug = (data.slug || target || '').trim();
        skillEditingSlug = loadedSlug;
        if (skillSlug) skillSlug.value = loadedSlug;
        if (skillNameInput) {
          skillNameInput.value = parsed.name || data.display_name || data.slug || '';
        }
        if (skillDescriptionInput) {
          skillDescriptionInput.value = parsed.description || data.description || '';
        }
        if (skillWhatInput) skillWhatInput.value = parsed.sections.what || '';
        if (skillWhenInput) skillWhenInput.value = parsed.sections.when || '';
        if (skillStepsInput) skillStepsInput.value = parsed.sections.steps || '';
        setSkillTags(parsed.tags || []);
        setSkillBadges({ sha256: data.sha256, updated_at: data.updated_at });
        skillSlugAutofill = false;
        if (skillStatus) skillStatus.textContent = '';
      } catch (err) {
        if (skillStatus) skillStatus.textContent = `Load failed: ${err.message}`;
      }
    }

    async function saveSkill() {
      if (!skillSlug || !skillNameInput || !skillWhatInput || !skillWhenInput || !skillStepsInput) {
        if (skillStatus) skillStatus.textContent = 'Skill form missing required fields';
        return;
      }
      const slug = skillSlug.value.trim();
      const isEdit = skillModalMode === 'edit' && !!skillEditingSlug;
      const name = skillNameInput.value.trim();
      const description = skillDescriptionInput?.value?.trim() || '';
      const what = skillWhatInput.value.trim();
      const when = skillWhenInput.value.trim();
      const steps = skillStepsInput.value.trim();
      if (!slug) {
        if (skillStatus) skillStatus.textContent = 'Slug is required';
        return;
      }
      if (!name) {
        if (skillStatus) skillStatus.textContent = 'Name is required';
        return;
      }
      if (!what || !when || !steps) {
        if (skillStatus) skillStatus.textContent = 'All sections must be filled in';
        return;
      }
      if (isEdit && slug !== skillEditingSlug) {
        if (skillStatus) {
          skillStatus.textContent = 'Slug is locked while editing. Use New to create a different slug.';
        }
        return;
      }
      const manifest = buildSkillManifestFromFields();
      const payload = {
        slug,
        display_name: name,
        description,
        manifest,
      };
      if (skillStatus) skillStatus.textContent = 'Saving…';
      if (skillDelete) skillDelete.disabled = true;
      if (skillSave) skillSave.disabled = true;
      try {
        const resp = await api('/admin/skills/store', {
          method: 'POST',
          json: payload,
        });
        const saveState = resp?.data?.status || 'updated';
        if (skillStatus) {
          skillStatus.textContent = saveState === 'unchanged' ? 'No changes' : 'Saved';
        }
        await loadAll();
        showSkillModal(false);
      } catch (err) {
        if (skillStatus) skillStatus.textContent = `Save failed: ${err.message}`;
      } finally {
        if (skillDelete) skillDelete.disabled = false;
        if (skillSave) skillSave.disabled = false;
      }
    }

    async function deleteSkill(slug, options = {}) {
      if (!slug) return;
      const fromModal = options?.fromModal === true;
      if (!confirm(`Delete skill "${slug}"? Hosts remove it on next sync.`)) {
        return;
      }
      if (fromModal && skillStatus) {
        skillStatus.textContent = 'Deleting…';
      }
      if (skillDelete) skillDelete.disabled = true;
      if (skillSave) skillSave.disabled = true;
      try {
        await api(`/admin/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        if (fromModal && skillStatus) {
          skillStatus.textContent = 'Deleted';
          showSkillModal(false);
        }
        await loadAll();
      } catch (err) {
        if (fromModal && skillStatus) {
          skillStatus.textContent = `Delete failed: ${err.message}`;
        } else {
          alert(`Delete failed: ${err.message}`);
        }
      } finally {
        if (skillDelete) skillDelete.disabled = false;
        if (skillSave) skillSave.disabled = false;
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

    setSettingsExpanded(true);

    function setActiveLinks(selector, match) {
      document.querySelectorAll(selector).forEach((link) => {
        const key = (link.dataset.hostTab || link.dataset.logTab || link.dataset.settingsTab || '').toLowerCase();
        link.classList.toggle('active', key === match);
      });
    }

    async function ensureDataLoaded(force = false) {
      if (!force && loadAllPromise) return loadAllPromise;
      if (force) loadAllPromise = null;
      loadAllPromise = loadAll().finally(() => { dataLoaded = true; });
      return loadAllPromise;
    }

    async function ensureHostsLoaded() {
      if (hostsInited) return;
      hostsInited = true;
      await ensureDataLoaded();
    }

    function parsePanelFromPath() {
      const pathname = window.location.pathname;
      const m = pathname.match(/^\/admin(?:\/([^/]+))?(?:\/(.+))?$/);
      const seg1 = (m?.[1] || '').toLowerCase();
      const seg2 = m?.[2] || '';
      if (!seg1 || seg1 === 'dashboard') return { panel: 'dashboard', sub: '' };
      if (seg1 === 'hosts') {
        const numId = Number(seg2);
        if (Number.isFinite(numId) && numId > 0) return { panel: 'host-detail', sub: seg2 };
        return { panel: 'hosts', sub: seg2 };
      }
      if (seg1 === 'logs') return { panel: 'logs', sub: seg2 };
      if (seg1 === 'account') return { panel: 'account', sub: seg2 || 'password' };
      if (seg1 === 'settings') return { panel: 'settings', sub: seg2 };
      if (seg1 === 'users') return { panel: 'users', sub: '' };
      if (seg1 === 'projects') return { panel: 'project-detail', sub: seg2 };
      return { panel: seg1, sub: seg2 };
    }

    function applyRouting() {
      const { panel, sub } = parsePanelFromPath();
      const hostTab = panel === 'hosts' ? (sub || '').toLowerCase() : '';
      const logTab = panel === 'logs'
        ? ((sub || '').toLowerCase() === 'mcp'
          ? 'mcp'
          : (((sub || '').toLowerCase() === 'events') ? 'events' : 'client'))
        : '';
      const accountTab = panel === 'account' ? (sub || 'password').toLowerCase() : '';
      const settingsTab = panel === 'settings' ? (sub || 'general').toLowerCase() : '';

      document.querySelectorAll('.panel-set').forEach((section) => {
        const p = (section.dataset.panel || '').toLowerCase();
        section.hidden = p !== panel;
      });
      document.body.dataset.viewMode = panel;
      if (panel === 'hosts') {
        document.body.dataset.hostTab = hostTab;
      } else if (document.body?.dataset?.hostTab) {
        delete document.body.dataset.hostTab;
      }
      if (panel === 'host-detail' && sub) {
        document.body.dataset.hostId = sub;
      } else if (document.body?.dataset?.hostId) {
        delete document.body.dataset.hostId;
      }
      if (panel === 'logs') {
        document.body.dataset.logTab = logTab;
      } else if (document.body?.dataset?.logTab) {
        delete document.body.dataset.logTab;
      }
      if (panel === 'settings') {
        document.body.dataset.settingsTab = settingsTab;
      } else if (document.body?.dataset?.settingsTab) {
        delete document.body.dataset.settingsTab;
      }
      if (panel === 'account') {
        document.body.dataset.accountTab = accountTab;
      } else if (document.body?.dataset?.accountTab) {
        delete document.body.dataset.accountTab;
      }
      if (panel === 'project-detail' && sub) {
        document.body.dataset.projectSlug = decodeURIComponent(sub);
      } else if (document.body?.dataset?.projectSlug) {
        delete document.body.dataset.projectSlug;
      }

      // Clean up host/status query params when leaving hosts, so dashboard links
      // don't carry stale ?host=unprovisioned into other views.
      if (panel !== 'hosts') {
        const url = new URL(window.location.href);
        url.searchParams.delete('host');
        url.searchParams.delete('status');
        window.history.replaceState({}, '', url.toString());
      }

      if (panel === 'hosts') {
        hostStatusFilter = hostTab;
        setHostStatusFilter(hostStatusFilter);
        setActiveLinks('.host-tab', hostStatusFilter);
        ensureHostsLoaded();
      }

      if (panel === 'host-detail') {
        const parsedHostId = Number(sub || pathHostId || 0);
        activeHostId = Number.isFinite(parsedHostId) && parsedHostId > 0 ? Math.trunc(parsedHostId) : null;
        renderActiveHostDetail();
        ensureHostsLoaded()
          .then(() => renderActiveHostDetail())
          .catch((err) => {
            console.error('host detail load failed', err);
            clearHostDetailContent();
            showHostDetailEmpty('Host load failed', err?.message || 'Unable to load host details.');
          });
      }

      if (panel === 'dashboard') {
        ensureDataLoaded();
      } else {
        destroyDashboardCharts();
      }

      if (panel === 'agents') {
        ensureDataLoaded();
      }

      if (panel === 'logs') {
        setActiveLinks('.log-tab', logTab);
        const clientPanel = document.getElementById('client-logs-panel');
        const mcpPanel = document.getElementById('mcp-logs-panel');
        const eventsPanel = document.getElementById('events-logs-panel');
        if (clientPanel) clientPanel.hidden = logTab !== 'client';
        if (mcpPanel) mcpPanel.hidden = logTab !== 'mcp';
        if (eventsPanel) eventsPanel.hidden = logTab !== 'events';
        // lazy init each view once
        if (logTab === 'client' && window.__initClientLogs) {
          window.__initClientLogs();
          window.__initClientLogs = null;
        }
        if (logTab === 'mcp' && window.__initMcpLogs) {
          window.__initMcpLogs();
          window.__initMcpLogs = null;
        }
        if (logTab === 'events' && window.__initEventLogs) {
          window.__initEventLogs();
          window.__initEventLogs = null;
        }
      }

      if (panel === 'project-detail' && window.__loadProjectDetailByRoute) {
        window.__loadProjectDetailByRoute(sub);
      }

      if (panel === 'account') {
        document.querySelectorAll('#accountPanel [data-account-panel]').forEach((panelEl) => {
          const tab = (panelEl.dataset.accountPanel || '').toLowerCase();
          panelEl.hidden = tab !== accountTab;
        });
      }

      if (panel === 'settings') {
        setActiveLinks('.settings-tab', settingsTab);
        document.querySelectorAll('[data-settings-panel]').forEach((panelEl) => {
          const tab = (panelEl.dataset.settingsPanel || '').toLowerCase();
          panelEl.hidden = tab !== settingsTab;
        });
        if (settingsTab === 'profiles' && window.__initProfiles) window.__initProfiles();
        if (settingsTab === 'projects' && window.__initProjects) window.__initProjects();
        if (settingsTab === 'skills') {
          renderSkills(currentSkills);
        }
        if (settingsTab === 'config' && window.__initConfigBuilder) window.__initConfigBuilder();
        if (settingsTab === 'memories' && window.__initMemoriesOnce) {
          window.__initMemoriesOnce();
          window.__initMemoriesOnce = null;
        }
      }

      applyViewMode();
    }

    window.__applyRouting = applyRouting;
    window.addEventListener('popstate', applyRouting);
    document.addEventListener('click', (event) => {
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href?.startsWith('/admin/')) return;
      if (anchor.target === '_blank') return;
      event.preventDefault();
      const url = new URL(href, window.location.origin);
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      history.pushState({}, '', url.toString());
      applyRouting();
    });
    applyRouting();
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
        setInsecureWindowMinutes(insecureSliderValueToMinutes(event.target.value), true);
      });
    }
    if (pruneWindowSlider) {
      pruneWindowSlider.addEventListener('input', (event) => {
        const preview = clampInactivityWindowDays(event.target.value);
        if (pruneWindowLabel) {
          pruneWindowLabel.textContent = preview === 0 ? 'Never' : `${preview} days`;
        }
      });
      pruneWindowSlider.addEventListener('change', (event) => {
        updateInactivityWindowDays(Number(event.target.value));
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
    quotaPartitionButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const days = btn.getAttribute('data-days') ?? '0';
        setQuotaPartition(days);
      });
    });
    if (newHostBtn) {
      newHostBtn.addEventListener('click', () => showNewHostModal(true));
    }
    // Memories view is live-updating via filters; no explicit refresh button.
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
    if (newSkillBtn) {
      newSkillBtn.addEventListener('click', (event) => {
        event.preventDefault();
        openSkillModal('');
      });
    }
    if (agentsPreview) {
      agentsPreview.addEventListener('click', () => setAgentsInlineEditing(true));
    }
    if (agentsEditToggle) {
      agentsEditToggle.addEventListener('click', (event) => {
        event.preventDefault();
        const editing = !!agentsEditorInline && !agentsEditorInline.hidden;
        setAgentsInlineEditing(!editing);
      });
    }
    if (agentsServeLatest) {
      agentsServeLatest.addEventListener('click', (event) => {
        event.preventDefault();
        serveAgentsLatest();
      });
    }
    if (agentsVersionsBody) {
      agentsVersionsBody.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('button[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const versionId = btn.getAttribute('data-version-id');
        if (!versionId) return;
        if (action === 'agents-serve') {
          serveAgentsVersion(versionId);
        } else if (action === 'agents-delete') {
          deleteAgentsVersion(versionId);
        }
      });
    }
    if (promptsToggle) {
      promptsToggle.addEventListener('click', (event) => {
        event.preventDefault();
        setPromptsExpanded(!promptsExpanded);
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
    if (seedCommandBtn) {
      seedCommandBtn.addEventListener('click', generateSeedCommand);
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
    if (skillModal) {
      skillModal.addEventListener('click', (e) => {
        if (e.target === skillModal) showSkillModal(false);
      });
    }
    if (promptCancel) {
      promptCancel.addEventListener('click', () => showPromptModal(false));
    }
    if (promptSave) {
      promptSave.addEventListener('click', () => savePrompt());
    }
    if (skillCancel) {
      skillCancel.addEventListener('click', () => showSkillModal(false));
    }
    if (skillSave) {
      skillSave.addEventListener('click', () => saveSkill());
    }
    if (skillDelete) {
      skillDelete.addEventListener('click', () => {
        const slug = (skillEditingSlug || skillSlug?.value || '').trim();
        deleteSkill(slug, { fromModal: true });
      });
    }
    if (skillSlugSuggest) {
      skillSlugSuggest.addEventListener('click', (event) => {
        event.preventDefault();
        skillSlugAutofill = true;
        maybeAutofillSkillSlug({ force: true });
        skillSlug?.focus();
      });
    }
    if (skillNameInput) {
      skillNameInput.addEventListener('input', () => {
        maybeAutofillSkillSlug({ force: false });
      });
    }
    if (skillSlug) {
      skillSlug.addEventListener('input', () => {
        skillSlugAutofill = skillSlug.value.trim().length === 0;
      });
    }
    if (skillTagsInput) {
      skillTagsInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          commitSkillTagInput();
        } else if (event.key === 'Backspace' && !skillTagsInput.value) {
          removeSkillTag(skillTags.length - 1);
        }
      });
      skillTagsInput.addEventListener('blur', () => {
        commitSkillTagInput();
      });
    }
    if (agentsSaveInline) {
      agentsSaveInline.addEventListener('click', () => saveAgentsInline());
    }
    if (deleteHostModal) {
      deleteHostModal.addEventListener('click', (e) => {
        if (e.target === deleteHostModal) closeDeleteModal();
      });
    }
    if (agentsDeleteModal) {
      agentsDeleteModal.addEventListener('click', (e) => {
        if (e.target === agentsDeleteModal) closeAgentsDeleteModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && agentsDeleteModal?.classList.contains('show')) {
        e.preventDefault();
        closeAgentsDeleteModal();
      }
      if (e.key === 'Escape' && insecureApprovalModal?.classList.contains('show')) {
        e.preventDefault();
        denyInsecureApproval();
      }
    });
    if (runnerModal) {
      runnerModal.addEventListener('click', (e) => {
        if (e.target === runnerModal) showRunnerModal(false);
      });
    }
    if (runnerCloseBtn) {
      runnerCloseBtn.addEventListener('click', () => showRunnerModal(false));
    }
    if (insecureApprovalModal) {
      insecureApprovalModal.addEventListener('click', (e) => {
        if (e.target === insecureApprovalModal) {
          denyInsecureApproval();
        }
      });
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
    if (insecureApprovalApprove) {
      insecureApprovalApprove.addEventListener('click', () => approveInsecureApproval());
    }
    if (insecureApprovalDeny) {
      insecureApprovalDeny.addEventListener('click', () => denyInsecureApproval());
    }
    if (insecureApprovalAllowDomain) {
      insecureApprovalAllowDomain.addEventListener('click', () => approveInsecureApprovalDomain());
    }
    if (cancelDeleteHostBtn) {
      cancelDeleteHostBtn.addEventListener('click', closeDeleteModal);
    }
    if (confirmDeleteHostBtn) {
      confirmDeleteHostBtn.addEventListener('click', confirmRemove);
    }
    if (agentsDeleteCancel) {
      agentsDeleteCancel.addEventListener('click', () => closeAgentsDeleteModal());
    }
    if (agentsDeleteConfirm) {
      agentsDeleteConfirm.addEventListener('click', () => confirmAgentsDelete());
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
    if (reverseDnsToggle) {
      reverseDnsToggle.addEventListener('change', () => {
        setReverseDns(reverseDnsToggle.checked);
      });
    }
    if (insecureApprovalToggle) {
      insecureApprovalToggle.addEventListener('change', () => {
        setInsecureApproval(insecureApprovalToggle.checked);
      });
    }
    if (autoUpdateToggle) {
      autoUpdateToggle.addEventListener('change', () => {
        setAutoUpdate(autoUpdateToggle.checked);
      });
    }
    if (codexVersionSelect) {
      codexVersionSelect.addEventListener('change', () => {
        setCodexVersionSelection(codexVersionSelect.value);
      });
    }
    window.addEventListener('admin-ws-event', (event) => {
      const detail = event?.detail || {};
      if (detail.type === 'toast') {
        toastFromEvent(detail);
        return;
      }
      if (detail.type !== 'log.created') return;
      const action = String(detail.payload?.action || '');
      if (insecureModalOpen && shouldRefreshInsecureModalForAction(action)) {
        scheduleInsecureHostsModalRefresh(250);
      }
      if (action === 'auth.insecure.pending') {
        const details = detail.payload?.details || {};
        const requestId = Number(details.request_id || 0);
        if (Number.isFinite(requestId) && requestId > 0) {
          enqueueInsecureApproval({
            id: requestId,
            hostId: Number(detail.payload?.host_id || details.host_id || 0),
            fqdn: details.fqdn || '',
            requestedAt: details.requested_at || detail.payload?.created_at || null,
            createdAt: detail.payload?.created_at || null,
            command: details.command || '',
          });
        }
      } else if (action === 'admin.insecure.approval' || action === 'admin.insecure.denied') {
        const details = detail.payload?.details || {};
        const requestId = Number(details.request_id || 0);
        if (Number.isFinite(requestId) && requestId > 0) {
          resolveInsecureApproval(requestId);
        }
      }
      const liveDomains = Array.from(actionDomainsForLiveRefresh(action));
      emitAdminDataDirty(action, liveDomains);
      const dashboardDomains = liveDomains.filter((domain) => DASHBOARD_LIVE_DOMAINS.has(domain));
      if (dashboardDomains.length > 0) {
        scheduleLiveDataRefresh(dashboardDomains);
        return;
      }
      if (action) {
        // Safety net for newly introduced log actions: refresh summary + hosts.
        scheduleLiveDataRefresh(WS_UNKNOWN_ACTION_FALLBACK_DOMAINS, WS_UNKNOWN_ACTION_FALLBACK_DELAY_MS);
      }
    });
    loadApiState();
    loadCdxSilent();
    loadReverseDns();
    loadInsecureApproval();
    loadAutoUpdate();

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
          if (targetKey === 'prompts') setPromptsExpanded(true);
          if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }

    wireNavShortcuts();
    applyQueryParams();
    applyRouting(); // ensure deep links after query param normalization

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
      if (temporaryHostToggle) {
        temporaryHostToggle.checked = false;
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
        if (seedCommandField) seedCommandField.style.display = 'none';
        if (seedCommandText) seedCommandText.textContent = '';
        if (seedCommandMeta) {
          seedCommandMeta.textContent = '';
          seedCommandMeta.style.display = 'none';
        }
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
      if (temporaryHostToggle && existingHost) {
        temporaryHostToggle.checked = !!existingHost.expires_at;
      }
      if (insecureToggle && existingHost) {
        insecureToggle.checked = !!existingHost.curl_insecure;
      }
      if (ipv4Toggle && existingHost) {
        ipv4Toggle.checked = !!existingHost.force_ipv4;
      }
      if (vipToggle && existingHost) {
        vipToggle.checked = !!existingHost.vip;
      }
      const secure = secureHostToggle ? secureHostToggle.checked : true;
      const vip = vipToggle ? vipToggle.checked : false;
      const temporary = temporaryHostToggle ? temporaryHostToggle.checked : false;
      const registerPayload = {
        fqdn: targetFqdn,
        host_id: hostId ?? undefined,
        secure,
        vip,
        temporary: !!temporary,
        curl_insecure: insecureToggle ? !!insecureToggle.checked : undefined,
      };
      if (!secure) {
        registerPayload.duration_minutes = insecureWindowMinutes;
      }
      if (createHostBtn) {
        createHostBtn.disabled = true;
        createHostBtn.textContent = 'Generating…';
      }
      try {
        const res = await api('/admin/hosts/register', {
          method: 'POST',
          json: registerPayload,
        });
        const installer = res.data?.installer;
        if (!installer || !installer.command) throw new Error('Missing installer command in response');
        let cmd = installer.command;
        if (insecureToggle?.checked) {
          cmd = addCurlFlag(cmd, '-k');
          cmd = addBashEnv(cmd, 'CODEX_INSTALL_CURL_INSECURE=1');
        }
        if (ipv4Toggle?.checked) {
          cmd = addCurlFlag(cmd, '-4');
        }
        bootstrapCmdEl.textContent = cmd;
        commandField.style.display = 'block';
        if (copyCmdBtn) {
          copyCmdBtn.onclick = async () => {
            const previous = copyCmdBtn.textContent || 'Copy';
            copyCmdBtn.disabled = true;
            copyCmdBtn.textContent = 'Copying…';
            try {
              await copyToClipboard(cmd);
              copyCmdBtn.textContent = 'Copied';
            } catch (error) {
              copyCmdBtn.textContent = 'Copy failed';
            } finally {
              window.setTimeout(() => {
                copyCmdBtn.textContent = previous;
                copyCmdBtn.disabled = false;
              }, 900);
            }
          };
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

    ensureDataLoaded();

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

    async function generateSeedCommand() {
      if (!seedCommandBtn) return;
      const originalText = seedCommandBtn.textContent;
      seedCommandBtn.disabled = true;
      seedCommandBtn.textContent = 'Generating…';
      try {
        const res = await api('/admin/auth/seed-command', { method: 'POST' });
        const data = res.data || {};
        const cmd = data.command || '';
        if (seedCommandText) seedCommandText.textContent = cmd || 'No command returned.';
        if (seedCommandField) seedCommandField.style.display = cmd ? 'flex' : 'none';
        if (seedCommandCopy) {
          seedCommandCopy.onclick = () => copyToClipboard(cmd || '');
        }
        if (seedCommandMeta) {
          const expiresAt = data.expires_at || '';
          seedCommandMeta.textContent = expiresAt
            ? `Expires ${formatRelativeWithTimestamp(expiresAt)}. One-time use.`
            : 'One-time use.';
          seedCommandMeta.style.display = 'block';
        }
        if (cmd) toast('Seed command ready.', 'ok');
      } catch (err) {
        alert(`Seed command failed: ${err.message}`);
      } finally {
        seedCommandBtn.disabled = false;
        seedCommandBtn.textContent = originalText;
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

    async function toggleAutoUpdate(host, desiredState = null) {
      if (!host) return;
      // Three-state cycle: fleet default (null) -> force on (true) -> force off (false) -> fleet default
      // When called from a checkbox toggle, desiredState is a boolean.
      let override = desiredState;
      // If the host currently has a per-host override, toggling off goes to null (fleet default).
      if (host.auto_update_override !== null && host.auto_update_override !== undefined) {
        if (!desiredState) {
          override = null; // revert to fleet default
        }
      }
      try {
        await api(`/admin/hosts/${host.id}/auto-update`, {
          method: 'POST',
          json: { override: override },
        });
        await loadAll();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }

    async function toggleInsecureApi(host, button = null, desiredState = null) {
      if (!host || isHostSecure(host)) {
        return;
      }
      const state = insecureState(host);
      const enableTarget = typeof desiredState === 'boolean' ? desiredState : !state.enabledActive;
      const path = enableTarget
        ? `/admin/hosts/${host.id}/insecure/enable`
        : `/admin/hosts/${host.id}/insecure/disable`;
      const isToggleInput = button && button.tagName === 'INPUT';
      const originalLabel = button ? (isToggleInput ? button.getAttribute('aria-label') : button.textContent) : null;
      if (button) {
        button.disabled = true;
        if (!isToggleInput) {
          button.textContent = enableTarget ? 'Turning on…' : 'Turning off…';
        }
      }
      const request = { method: 'POST' };
      if (enableTarget) {
        request.json = { duration_minutes: insecureWindowMinutes };
      }
      try {
        await api(path, request);
        await loadAll();
      } catch (err) {
        console.error('toggleInsecureApi failed', err);
        if (isToggleInput && button) {
          button.checked = !enableTarget;
        }
      } finally {
        if (button) {
          button.disabled = false;
          if (originalLabel !== null) {
            if (isToggleInput) {
              button.setAttribute('aria-label', originalLabel);
            } else {
              button.textContent = originalLabel;
            }
          }
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
