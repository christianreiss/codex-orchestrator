    const statsEl = document.getElementById('stats');
    const hostsTbody = document.querySelector('#hosts-table tbody');
    const hostsInsecureHeader = document.querySelector('#hosts-table .insecure-col');
    const versionCheckBtn = document.getElementById('version-check');
    const filterInput = document.getElementById('host-filter');
    const newHostBtn = document.getElementById('newHostBtn');
    const quickVmBtn = document.getElementById('quickVmBtn');
    const quickVmPanelBtn = document.getElementById('quickVmPanelBtn');
    const quickVmModal = document.getElementById('quickVmModal');
    const quickVmCancel = document.getElementById('quickVmCancel');
    const quickVmButtons = Array.from(document.querySelectorAll('[data-quick-vm-engines]'));
    const newHostModal = document.getElementById('newHostModal');
    const newHostDialog = newHostModal?.querySelector('.new-host-modal') || null;
    const navInsecureHosts = document.getElementById('navInsecureHosts');
    const navHelpTrigger = document.getElementById('navHelpTrigger');
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
    const newHostError = document.getElementById('newHostError');
    const newHostForm = document.getElementById('newHostForm');
    const newHostFormStage = document.getElementById('newHostFormStage');
    const newHostSuccessStage = document.getElementById('newHostSuccessStage');
    const newHostSuccessKicker = document.getElementById('newHostSuccessKicker');
    const newHostSuccessTitle = document.getElementById('newHostSuccessTitle');
    const newHostSuccessCopy = document.getElementById('newHostSuccessCopy');
    const newHostSuccessChips = document.getElementById('newHostSuccessChips');
    const deleteAccidentalHostBtn = document.getElementById('deleteAccidentalHost');
    const closeNewHostSuccessBtn = document.getElementById('closeNewHostSuccess');
    const createAnotherHostBtn = document.getElementById('createAnotherHost');
    const secureHostToggle = document.getElementById('secureHostToggle');
    const temporaryHostToggle = document.getElementById('temporaryHostToggle');
    const insecureToggle = document.getElementById('insecureToggle');
    const vipToggle = document.getElementById('vipToggle');
    const engineCodexToggle = document.getElementById('engineCodexToggle');
    const engineClaudeToggle = document.getElementById('engineClaudeToggle');
    const newHostEngineError = document.getElementById('newHostEngineError');
    const createHostBtn = document.getElementById('createHost');
    const cancelNewHostBtn = document.getElementById('cancelNewHost');
    const commandField = document.getElementById('commandField');
    const bootstrapCmdEl = document.getElementById('bootstrapCmd');
    const copyCmdBtn = document.getElementById('copyCmd');
    const installerMeta = document.getElementById('installerMeta');
    const newHostClipboardStatus = document.getElementById('newHostClipboardStatus');
    const seedCodexAuthBtn = document.getElementById('seedCodexAuthBtn');
    const seedClaudeAuthBtn = document.getElementById('seedClaudeAuthBtn');
    const uploadModal = document.getElementById('uploadModal');
    const uploadAuthTitle = document.getElementById('uploadAuthTitle');
    const uploadAuthIntro = document.getElementById('uploadAuthIntro');
    const uploadAuthPayloadLabel = document.getElementById('uploadAuthPayloadLabel');
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
    // Engine picked in the seed modal; flows into /admin/auth/upload as `engine`.
    let seedSelectedEngine = 'codex';
    const seedHostsStatus = document.getElementById('seedHostsStatus');
    const seedAuthStatus = document.getElementById('seedAuthStatus');
    const runnerRunnerBtn = document.getElementById('runner-runner');
    const runnerModal = document.getElementById('runnerModal');
    const runnerLogEl = document.getElementById('runnerLog');
    const runnerMetaEl = document.getElementById('runnerMeta');
    const runnerCloseBtn = document.getElementById('runnerClose');
    const claudeRunnerModal = document.getElementById('claudeRunnerModal');
    const claudeRunnerLogEl = document.getElementById('claudeRunnerLog');
    const claudeRunnerMetaEl = document.getElementById('claudeRunnerMeta');
    const claudeRunnerCloseBtn = document.getElementById('claudeRunnerClose');
    const claudeUsageCard = document.getElementById('claude-usage-card');
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
    const deleteHostModal = document.getElementById('deleteHostModal');
    const deleteHostText = document.getElementById('delete-host-text');
    const cancelDeleteHostBtn = document.getElementById('cancelDeleteHost');
    const confirmDeleteHostBtn = document.getElementById('confirmDeleteHost');
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
    const skillsTbody = document.querySelector('#skills tbody');
    const newSkillBtn = document.getElementById('newSkillBtn');
    const skillDetailPanel = document.getElementById('skillDetailPanel');
    const skillDetailLayout = document.getElementById('skillDetailLayout');
    const skillDetailBack = document.getElementById('skillDetailBack');
    const skillDetailEmptyState = document.getElementById('skillDetailEmptyState');
    const skillDetailEmptyTitle = document.getElementById('skillDetailEmptyTitle');
    const skillDetailEmptyBody = document.getElementById('skillDetailEmptyBody');
    const skillWorkspaceTitle = document.getElementById('skillWorkspaceTitle');
    const skillWorkspaceSubtitle = document.getElementById('skillWorkspaceSubtitle');
    const skillConversation = document.getElementById('skillConversation');
    const skillConversationEmpty = document.getElementById('skillConversationEmpty');
    const skillAssistInput = document.getElementById('skillAssistInput');
    const skillAssistSend = document.getElementById('skillAssistSend');
    const skillAssistStatus = document.getElementById('skillAssistStatus');
    const skillChangedFields = document.getElementById('skillChangedFields');
    const skillChangedFieldsWrap = document.getElementById('skillChangedFieldsWrap');
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
    const skillSlugNote = document.getElementById('skillSlugNote');
    const skillDigestBadge = document.getElementById('skillDigestBadge');
    const skillUpdatedBadge = document.getElementById('skillUpdatedBadge');
    const skillFieldEditButtons = Array.from(document.querySelectorAll('[data-skill-unlock]'));
    const skillModeSplash = document.getElementById('skillModeSplash');
    const skillModeAiBtn = document.getElementById('skillModeAiBtn');
    const skillModeManualBtn = document.getElementById('skillModeManualBtn');
    const skillModeSwitchBtn = document.getElementById('skillModeSwitchBtn');
    const skillsPanel = document.querySelector('[data-settings-panel="skills"]');
    const agentsPanel = null;
    const settingsPanel = document.getElementById('settings-panel');
    const memoriesPanel = document.querySelector('.panel-set[data-panel="settings"] [data-settings-panel="memories"]');
    const memoriesTableBody = document.querySelector('#memories tbody');
    const memoriesTableWrap = document.getElementById('memoriesTableWrap');

    const dashboardMissionYear = document.getElementById('dashboardMissionYear');
    const dashboardStatusBar = document.getElementById('dashboardStatusBar');
    const dashboardTrends = document.getElementById('dashboardTrends');
    const memoriesHostFilter = document.getElementById('memoriesHostFilter');
    const memoriesQueryInput = document.getElementById('memoriesQuery');
    const memoriesTagsInput = document.getElementById('memoriesTags');
    const memoriesLimitInput = document.getElementById('memoriesLimit');
    const memoriesRefreshBtn = document.getElementById('memoriesRefreshBtn');
    const agentsTabButtons = Array.from(document.querySelectorAll('[data-agents-tab]'));
    const agentsTabPanels = Array.from(document.querySelectorAll('[data-agents-tab-panel]'));
    const agentsMeta = document.getElementById('agentsMeta');
    const agentsBackupsMeta = document.getElementById('agentsBackupsMeta');
    const agentsPreview = document.getElementById('agentsPreview');
    const agentsEditorInline = document.getElementById('agentsEditorInline');
    const agentsStatus = document.getElementById('agentsStatus');
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
    const scalingToggle = document.getElementById('scalingToggle');
    const scalingLabel = document.getElementById('scalingLabel');
    const scalingBadge = document.getElementById('scalingBadge');
    const scalingBody = document.getElementById('scalingBody');
    const scalingStatus = document.getElementById('scalingStatus');
    const scalingTierList = document.getElementById('scalingTierList');
    const scalingAddTier = document.getElementById('scalingAddTier');
    const scalingVipExempt = document.getElementById('scalingVipExempt');
    const scalingHostOverrideWins = document.getElementById('scalingHostOverrideWins');
    const scalingSave = document.getElementById('scalingSave');
    const codexVersionSelect = document.getElementById('codexVersionSelect');
    const codexVersionMeta = document.getElementById('codexVersionMeta');
    const accessBlockModal = document.getElementById('accessBlockModal');
    const accessBlockTitle = document.getElementById('accessBlockTitle');
    const accessBlockBody = document.getElementById('accessBlockBody');
    const accessBlockDismiss = document.getElementById('accessBlockDismiss');
    const confirmModal = document.getElementById('confirmModal');
    const confirmModalTitle = document.getElementById('confirmModalTitle');
    const confirmModalBody = document.getElementById('confirmModalBody');
    const confirmModalCancel = document.getElementById('confirmModalCancel');
    const confirmModalConfirm = document.getElementById('confirmModalConfirm');
    const helpModal = document.getElementById('helpModal');
    const helpModalClose = document.getElementById('helpModalClose');
    const hostSearchModal = document.getElementById('hostSearchModal');
    const hostSearchInput = document.getElementById('hostSearchInput');
    const hostSearchResults = document.getElementById('hostSearchResults');
    const hostSearchMeta = document.getElementById('hostSearchMeta');
    const hostSearchClose = document.getElementById('hostSearchClose');
    const insecureApprovalModal = document.getElementById('insecureApprovalModal');
    const insecureApprovalSubtitle = document.getElementById('insecureApprovalSubtitle');
    const insecureApprovalHost = document.getElementById('insecureApprovalHost');
    const insecureApprovalFqdn = document.getElementById('insecureApprovalFqdn');
    const insecureApprovalTime = document.getElementById('insecureApprovalTime');
    const insecureApprovalApprove = document.getElementById('insecureApprovalApprove');
    const insecureApprovalDeny = document.getElementById('insecureApprovalDeny');
    const insecureApprovalAllowDomain = document.getElementById('insecureApprovalAllowDomain');
    const apiStatusBadge = document.getElementById('apiStatusBadge');
    const quotaStatusBadge = document.getElementById('quotaStatusBadge');
    const reverseDnsBadge = document.getElementById('reverseDnsBadge');
    const insecureApprovalBadge = document.getElementById('insecureApprovalBadge');
    const autoUpdateBadge = document.getElementById('autoUpdateBadge');
    const cdxSilentBadge = document.getElementById('cdxSilentBadge');
    const insecureWindowSlider = document.getElementById('insecureWindowSlider');
    const insecureWindowLabel = document.getElementById('insecureWindowLabel');
    const pruneWindowSlider = document.getElementById('pruneWindowSlider');
    const pruneWindowLabel = document.getElementById('pruneWindowLabel');
    const logRetentionToggle = document.getElementById('logRetentionToggle');
    const logRetentionLabel = document.getElementById('logRetentionLabel');
    const logRetentionSliders = document.getElementById('logRetentionSliders');
    const logRetentionDaysLogsSlider = document.getElementById('logRetentionDaysLogsSlider');
    const logRetentionDaysLogsLabel = document.getElementById('logRetentionDaysLogsLabel');
    const logRetentionDaysMcpSlider = document.getElementById('logRetentionDaysMcpSlider');
    const logRetentionDaysMcpLabel = document.getElementById('logRetentionDaysMcpLabel');
    const logRetentionDaysEventsSlider = document.getElementById('logRetentionDaysEventsSlider');
    const logRetentionDaysEventsLabel = document.getElementById('logRetentionDaysEventsLabel');
    const logRetentionDaysGraphStatsSlider = document.getElementById('logRetentionDaysGraphStatsSlider');
    const logRetentionDaysGraphStatsLabel = document.getElementById('logRetentionDaysGraphStatsLabel');
    const insecureHostsModal = document.getElementById('insecureHostsModal');
    const insecureHostsList = document.getElementById('insecureHostsList');
    const insecureDomainsList = document.getElementById('insecureDomainsList');
    const insecureHostsCloseBtn = document.getElementById('insecureHostsCloseBtn');
    const pageHero = document.querySelector('.page-hero');
    const heroEyebrow = pageHero?.querySelector('.eyebrow');
    const heroTitle = pageHero?.querySelector('h1');
    const heroCopy = pageHero?.querySelector('p.muted');
    const USAGE_HISTORY_DAYS = 60;
    const QUOTA_SERIES_META = [
      { key: 'normal_primary', label: '5-hour runway', color: '#0b7c73' },
      { key: 'normal_secondary', label: 'Weekly runway', color: '#2563eb' },
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
    let newHostSuccessHostId = null;
    let newHostSuccessCanDelete = false;
    let hostSearchMatches = [];
    let hostSearchSelectedIndex = 0;
    const HOST_MODEL_REASONING = {
      'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.4-mini': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
      'gpt-5.2': ['low', 'medium', 'high', 'xhigh'],
    };
    const HOST_REASONING_DEFAULTS = ['low', 'medium', 'high', 'xhigh'];

    const upgradeNotesCache = {};
    let currentHosts = [];
    let currentHostDetail = null;
    let currentSkills = [];
    let currentMemories = [];
    let currentAgents = null;
    let agentsActiveTab = 'content';
    let agentsSaveInFlight = false;
    let agentsDeleteInFlight = false;
    let agentsRestoreInFlight = false;
    let agentsEditing = false;
    let agentsOriginalContent = '';
    let latestVersions = { client: null, wrapper: null, claude: null };
    let tokensSummary = null;
    let runnerSummary = null;
    let hostFilterText = '';
    let hostSort = { key: 'last_seen', direction: 'desc' };
    let insecureExpanded = true;
    let secureExpanded = false;
    let hostStatusFilter = ''; // maintained for clarity
    const hostTabLinks = Array.from(document.querySelectorAll('.host-tab'));
    let skillDetailMode = 'new';
    let skillEditingSlug = '';
    let skillTags = [];
    let skillConversationMessages = [];
    let skillUnlockedFields = new Set();
    let skillAssistBusy = false;
    let skillChangedFieldNames = [];
    let skillCreationMode = ''; // 'ai' | 'manual' | ''

    const THEME_OPTIONS = ['auto', 'auto-pink', 'light', 'dark', 'bright-pink', 'dark-pink'];
    const THEME_SYNC_STORAGE_KEY = 'adminThemeSynced';
    const THEME_LABELS = {
      auto: 'Auto',
      'auto-pink': 'Auto Pink',
      light: 'Light',
      dark: 'Dark',
      'bright-pink': 'Bright Pink',
      'dark-pink': 'Dark Pink',
    };
    const SHORTCUT_SEQUENCE_TIMEOUT_MS = 1200;
    let pendingShortcutPrefix = '';
    let pendingShortcutTimer = null;

    // Dirty-state registry used by config.js and profiles.js to signal unsaved edits.
    // Keys are module names (e.g. 'config', 'profiles'); the Set is non-empty when there
    // are unsaved changes that should warn the user before navigation.
    window.__adminDirtyModules = new Set();

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

    function resolveAppliedTheme(theme) {
      const normalized = normalizeTheme(theme);
      if (normalized !== 'auto-pink') {
        return normalized;
      }
      try {
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark-pink'
          : 'bright-pink';
      } catch (_) {
        return 'bright-pink';
      }
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

    function readSyncedTheme() {
      try {
        return localStorage.getItem(THEME_SYNC_STORAGE_KEY);
      } catch (err) {
        return null;
      }
    }

    function writeSyncedTheme(value) {
      try {
        localStorage.setItem(THEME_SYNC_STORAGE_KEY, value);
      } catch (err) {
        // ignore storage failures (private mode, blocked storage)
      }
    }

    function applyTheme(theme) {
      const normalized = normalizeTheme(theme);
      const applied = resolveAppliedTheme(normalized);
      if (document.body) {
        document.body.dataset.theme = applied;
        document.body.dataset.themePreference = normalized;
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

    async function persistThemePreference(theme, { silent = false } = {}) {
      const normalized = normalizeTheme(theme);
      try {
        await api('/admin/theme', {
          method: 'POST',
          json: { theme: normalized },
        });
        writeSyncedTheme(normalized);
      } catch (err) {
        if (!silent) {
          toast(`Theme sync failed: ${err.message || err}`, 'error');
        }
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
      if (readSyncedTheme() !== initial) {
        void persistThemePreference(initial, { silent: true });
      }
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
          void persistThemePreference(nextTheme, { silent: true });
          setThemeMenuOpen(false);
          window.__railNav?.closeMenus?.();
        });
      });
      try {
        const darkMedia = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        darkMedia?.addEventListener?.('change', () => {
          const stored = normalizeTheme(readStoredTheme());
          if (stored === 'auto-pink') {
            applyTheme(stored);
          }
        });
      } catch (_) {
        // ignore matchMedia availability issues
      }
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
    let scalingData = null;
    let chatgptUsageHistory = null;
    let chatgptUsageHistoryPromise = null;
    const chatgptUsageHistoryCache = new Map();
    const chatgptUsageHistoryPromiseCache = new Map();
    let activeHostId = null;
    let activeInsecureApproval = null;
    const insecureApprovalQueue = [];
    let insecureApprovalBusy = false;
    let insecureApprovalBellContext = null;
    let lastInsecureApprovalBellAt = 0;
    const INSECURE_APPROVAL_BELL_COOLDOWN_MS = 5000;
    const DASHBOARD_CHART_LIVE_DEBOUNCE_MS = 1200;
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
    let logRetentionEnabled = false;
    let logRetentionDaysLogs = 90;
    let logRetentionDaysMcp = 90;
    let logRetentionDaysEvents = 30;
    let logRetentionDaysGraphStats = 180;
    let memoriesLoading = false;
    let memoriesOpen = false;

    const dashboardYear = new Date().getFullYear();
    if (dashboardMissionYear) {
      dashboardMissionYear.textContent = String(dashboardYear);
    }

    const VIEW_LAYOUTS = {
      dashboard: {
        eyebrow: 'Dashboard',
        title: 'Fleet Mission Control',
        copy: `At-a-glance ${dashboardYear} posture across hosts, auth, usage, and quota.`,
        show: ['stats', 'chatgpt-usage-card', 'claude-usage-card', 'dashboardStatusBar', 'dashboardTrends'],
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
      'skill-detail': {
        eyebrow: 'Skill Details',
        title: 'Skill workspace',
        copy: 'Talk with AI, review field-level changes, and save the canonical fleet skill.',
        show: ['skillDetailPanel'],
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
      manual: {
        eyebrow: 'Manual',
        title: 'Orchestrator manual',
        copy: 'Operator reference assembled from the live codebase.',
        show: ['manualPanel'],
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
      const allIds = ['stats', 'chatgpt-usage-card', 'claude-usage-card', 'dashboardStatusBar', 'dashboardTrends', 'hosts-panel', 'hostDetailPanel', 'projectDetailPanel', 'skillDetailPanel', 'accountPanel', 'memories-panel', 'settings-panel', 'manualPanel'];
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

    function formatFooterVersion(value) {
      if (typeof value !== 'string') return 'n/a';
      const normalized = value.trim().replace(/^v/i, '');
      return normalized !== '' ? normalized : 'n/a';
    }

    function countHostsActiveToday(hostsList = []) {
      if (!Array.isArray(hostsList)) return 0;
      const cutoff = Date.now() - (24 * 60 * 60 * 1000);
      return hostsList.reduce((count, host) => {
        const activeAt = host?.last_seen || host?.last_refresh || host?.updated_at || host?.token_usage?.created_at || null;
        const active = parseTimestamp(activeAt);
        if (!active) return count;
        return active.getTime() >= cutoff ? count + 1 : count;
      }, 0);
    }

    function formatPercent(value, digits = 0) {
      const num = Number(value);
      if (!Number.isFinite(num)) return '—';
      const safeDigits = Number.isFinite(digits) ? Math.max(0, Math.min(2, Math.floor(digits))) : 0;
      return `${num.toFixed(safeDigits)}%`;
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
      toastEl.setAttribute('role', 'status');
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

    window.__toast = pushToast;

    function setInertBehindModal(backdropEl, state) {
      document.querySelector('.editorial-rail')?.toggleAttribute('inert', state);
      document.getElementById('navDrawerBackdrop')?.toggleAttribute('inert', state);
      if (!backdropEl?.parentElement) return;
      for (const child of backdropEl.parentElement.children) {
        if (child === backdropEl || child.classList.contains('modal-backdrop')) continue;
        child.toggleAttribute('inert', state);
      }
    }

    function showHelpModal(show) {
      if (!helpModal) return;
      const shouldShow = !!show;
      helpModal.classList.toggle('show', shouldShow);
      setInertBehindModal(helpModal, shouldShow);
      if (shouldShow) {
        window.__railNav?.closeMenus?.();
        window.setTimeout(() => {
          helpModalClose?.focus();
        }, 30);
      } else {
        navHelpTrigger?.focus();
      }
    }

    function closeHelpModal() {
      showHelpModal(false);
    }

    function rankHostSearchMatch(host, normalizedQuery) {
      const fqdn = String(host?.fqdn || '').trim().toLowerCase();
      const version = String(host?.client_version || '').trim().toLowerCase();
      const status = String(hostListStatus(host)?.label || '').trim().toLowerCase();
      const hostId = String(host?.id || '').trim().toLowerCase();
      if (!normalizedQuery) return 0;
      if (fqdn === normalizedQuery) return 0;
      if (fqdn.startsWith(normalizedQuery)) return 1;
      if (fqdn.includes(normalizedQuery)) return 2;
      if (hostId === normalizedQuery) return 3;
      if (hostId.includes(normalizedQuery)) return 4;
      if (version.includes(normalizedQuery)) return 5;
      if (status.includes(normalizedQuery)) return 6;
      return 99;
    }

    function hostSearchCandidates(query) {
      const normalized = String(query || '').trim().toLowerCase();
      const hosts = Array.isArray(currentHosts) ? [...currentHosts] : [];
      return hosts
        .filter((host) => {
          if (!normalized) return true;
          const haystack = [
            host?.fqdn,
            host?.client_version,
            host?.installation_version,
            host?.runner_version,
            host?.id,
            hostListStatus(host)?.label,
            parseEngines(host?.engines).join(' '),
          ]
            .map((value) => String(value || '').toLowerCase())
            .join(' ');
          return haystack.includes(normalized);
        })
        .sort((left, right) => {
          const leftRank = rankHostSearchMatch(left, normalized);
          const rightRank = rankHostSearchMatch(right, normalized);
          if (leftRank !== rightRank) return leftRank - rightRank;
          return String(left?.fqdn || '').localeCompare(String(right?.fqdn || ''), undefined, { sensitivity: 'base', numeric: true });
        });
    }

    function syncHostSearchSelection(nextIndex) {
      if (!Array.isArray(hostSearchMatches) || hostSearchMatches.length === 0) {
        hostSearchSelectedIndex = 0;
        return;
      }
      const maxIndex = hostSearchMatches.length - 1;
      hostSearchSelectedIndex = Math.max(0, Math.min(maxIndex, Number(nextIndex) || 0));
      if (!hostSearchResults) return;
      const active = hostSearchResults.querySelector(`[data-host-search-index="${hostSearchSelectedIndex}"]`);
      active?.scrollIntoView({ block: 'nearest' });
    }

    function openSelectedHostSearchResult() {
      const selected = hostSearchMatches[hostSearchSelectedIndex] || hostSearchMatches[0];
      if (!selected) return;
      showHostSearchModal(false);
      openHostDetail(selected.id);
    }

    function renderHostSearchResults(query = hostSearchInput?.value || '') {
      if (!hostSearchResults) return;
      const matches = hostSearchCandidates(query).slice(0, 12);
      hostSearchMatches = matches;
      if (!matches.length) {
        const hasHosts = Array.isArray(currentHosts) && currentHosts.length > 0;
        hostSearchSelectedIndex = 0;
        hostSearchResults.innerHTML = `
          <div class="host-search-empty">
            <strong>${hasHosts ? 'No hosts matched.' : 'No hosts loaded yet.'}</strong>
            <div class="muted">${hasHosts ? 'Try a shorter hostname, version, or status.' : 'The dashboard will fill this list after the fleet overview loads.'}</div>
          </div>
        `;
        if (hostSearchMeta) {
          hostSearchMeta.textContent = hasHosts ? 'No results for this search.' : 'Waiting for host data from the dashboard overview.';
        }
        return;
      }
      hostSearchSelectedIndex = Math.max(0, Math.min(hostSearchSelectedIndex, matches.length - 1));
      hostSearchResults.innerHTML = matches.map((host, index) => {
        const status = hostListStatus(host);
        const lastSeenText = host.updated_at ? formatRelative(host.updated_at) : 'Never';
        const version = host.client_version ? `Codex ${host.client_version}` : 'Codex unknown';
        const hostEnginesLabel = parseEngines(host.engines).map(e => e === 'codex' ? 'CDX' : e === 'claude' ? 'CLX' : e).join('+');
        const activeClass = index === hostSearchSelectedIndex ? ' is-active' : '';
        return `
          <button type="button" class="host-search-result${activeClass}" data-host-id="${host.id}" data-host-search-index="${index}">
            <span class="host-search-result-main">
              <span class="host-search-result-topline">
                <span class="host-search-result-name">${escapeHtml(host.fqdn || `Host #${host.id}`)}</span>
                <span class="chip ${escapeHtml(status.tone)}">${escapeHtml(status.label)}</span>
              </span>
              <span class="host-search-result-meta">#${host.id} · ${escapeHtml(hostEnginesLabel)} · ${escapeHtml(lastSeenText)} · ${escapeHtml(version)}</span>
            </span>
          </button>
        `;
      }).join('');
      if (hostSearchMeta) {
        hostSearchMeta.textContent = matches.length === 1
          ? '1 host ready. Press Enter to jump.'
          : `${matches.length} hosts ready. Use Enter to open the highlighted result.`;
      }
    }

    function showHostSearchModal(show, { reset = show } = {}) {
      if (!hostSearchModal) return;
      const shouldShow = !!show;
      hostSearchModal.classList.toggle('show', shouldShow);
      setInertBehindModal(hostSearchModal, shouldShow);
      if (shouldShow) {
        if (reset && hostSearchInput) hostSearchInput.value = '';
        hostSearchSelectedIndex = 0;
        renderHostSearchResults(hostSearchInput?.value || '');
        window.__railNav?.closeMenus?.();
        window.setTimeout(() => {
          hostSearchInput?.focus();
          hostSearchInput?.select?.();
        }, 30);
      } else {
        hostSearchMatches = [];
        hostSearchSelectedIndex = 0;
        if (hostSearchInput && reset) hostSearchInput.value = '';
      }
    }

    function clearShortcutPrefix() {
      pendingShortcutPrefix = '';
      if (pendingShortcutTimer) {
        window.clearTimeout(pendingShortcutTimer);
        pendingShortcutTimer = null;
      }
    }

    function armShortcutPrefix(prefix) {
      clearShortcutPrefix();
      pendingShortcutPrefix = prefix;
      window.__railNav?.toggleGroup?.(prefix === 'h' ? 'hosts' : prefix === 'l' ? 'logs' : prefix === 's' ? 'settings' : '');
      pendingShortcutTimer = window.setTimeout(() => {
        clearShortcutPrefix();
      }, SHORTCUT_SEQUENCE_TIMEOUT_MS);
    }

    function isEditableShortcutTarget(target) {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      if (target.closest('[contenteditable="true"]')) return true;
      const tag = (target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return true;
      return false;
    }

    function openModalBackdrop() {
      return document.querySelector('.modal-backdrop.show');
    }

    function navigateAdminShortcut(path) {
      const target = String(path || '').trim();
      if (!target.startsWith('/admin')) return;
      const url = new URL(target, window.location.origin);
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      history.pushState({}, '', url.toString());
      applyRouting();
    }

    function focusHostsFilterShortcut() {
      if (isDashboardView()) {
        showHostSearchModal(true);
        return;
      }
      const hostFilter = document.getElementById('host-filter');
      const logSearch = document.getElementById('log-search');
      const activePanel = document.querySelector('.panel-set:not([hidden])');
      const panelSearch = activePanel?.querySelector('input[type="search"], input[type="text"][id*="search"], input[type="text"][id*="filter"], input[type="text"][id*="query"]');
      const target = (hostFilter && !hostFilter.closest('[hidden]')) ? hostFilter
        : (logSearch && !logSearch.closest('[hidden]')) ? logSearch
        : panelSearch;
      if (!target) {
        toast('No search or filter field is active in this view.', 'info', { timeoutMs: 1800 });
        return;
      }
      target.focus();
      target.select?.();
    }

    function reloadCurrentViewShortcut() {
      const activePanel = document.querySelector('.panel-set:not([hidden])');
      if (!activePanel) {
        window.location.reload();
        return;
      }
      const panelKey = activePanel.dataset?.panel || '';

      if (panelKey === 'hosts' || panelKey === 'dashboard' || panelKey === 'host-detail') {
        scheduleOverviewLiveRefresh(0);
        return;
      }

      if (panelKey === 'logs') {
        const visibleLogPanel = Array.from(activePanel.querySelectorAll('.log-panel')).find((panel) => !panel.hidden);
        const refreshButton = visibleLogPanel?.querySelector('[id$="refresh"]');
        if (refreshButton && !refreshButton.disabled) {
          refreshButton.click();
          return;
        }
      }

      const refreshButton = activePanel.querySelector('[id*="refresh"]:not([disabled]), [id*="Refresh"]:not([disabled])')
        || activePanel.querySelector('button[title*="refresh" i]:not([disabled]), button[aria-label*="refresh" i]:not([disabled])')
        || document.getElementById('memoriesRefreshBtn');
      if (refreshButton && !refreshButton.disabled) {
        refreshButton.click();
        return;
      }

      window.location.reload();
    }

    function triggerVisibleTogglerShortcut() {
      const candidates = [
        insecureHostsCloseBtn,
        navInsecureHosts,
        document.getElementById('navMenuToggle'),
      ].filter(Boolean);
      const target = candidates.find((element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.hidden) return false;
        const style = window.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return element.getClientRects().length > 0;
      });
      if (!target) {
        toast('No toggle control is active in this view.', 'info', { timeoutMs: 1800 });
        return;
      }
      target.click();
    }

    function openNewHostModal({ closeMenus = false } = {}) {
      if (closeMenus) {
        window.__railNav?.closeMenus?.();
      }
      showNewHostModal(true, { reset: true, focusInput: true });
      window.setTimeout(() => {
        newHostName?.focus();
      }, 30);
    }

    function showQuickVmModal(show) {
      if (!quickVmModal) return;
      if (show) {
        quickVmModal.classList.add('show');
        setInertBehindModal(quickVmModal, true);
      } else {
        quickVmModal.classList.remove('show');
        setInertBehindModal(quickVmModal, false);
      }
    }

    function openQuickVmModal({ closeMenus = false } = {}) {
      if (closeMenus) {
        window.__railNav?.closeMenus?.();
      }
      showQuickVmModal(true);
    }

    function triggerNewShortcut() {
      const activePanel = document.querySelector('.panel-set:not([hidden])');
      if (!activePanel) {
        openNewHostModal({ closeMenus: true });
        return;
      }
      const panelKey = activePanel.dataset?.panel || '';

      if (panelKey === 'hosts' || panelKey === 'host-detail') {
        openNewHostModal({ closeMenus: true });
        return;
      }

      if (panelKey === 'users') {
        const button = document.getElementById('usersAddBtn');
        if (button && !button.disabled) {
          button.click();
        }
        return;
      }

      if (panelKey === 'settings') {
        const activeSubPanel = activePanel.querySelector('[data-settings-panel]:not([hidden])');
        const subKey = activeSubPanel?.dataset?.settingsPanel || '';
        if (subKey === 'skills') {
          const button = document.getElementById('newSkillBtn');
          if (button && !button.disabled) {
            button.click();
          }
          return;
        }
      }

      openNewHostModal({ closeMenus: true });
    }

    function handleShortcutPrefixKey(key) {
      const prefix = pendingShortcutPrefix;
      if (!prefix) return false;
      const routesByPrefix = {
        h: {
          a: '/admin/hosts',
          s: '/admin/hosts/secure',
          i: '/admin/hosts/insecure',
          n: '__new_host__',
          q: '__quick_vm__',
        },
        l: {
          c: '/admin/logs',
          m: '/admin/logs/mcp',
          e: '/admin/logs/events',
        },
        s: {
          g: '/admin/settings/general',
          u: '/admin/settings/users',
          a: '/admin/settings/agents',
          c: '/admin/settings/config',
          i: '/admin/settings/apikeys',
          k: '/admin/settings/skills',
          m: '/admin/settings/memories',
          p: '/admin/settings/projects',
          r: '/admin/settings/profiles',
        },
      };
      const route = routesByPrefix[prefix]?.[key] || null;
      clearShortcutPrefix();
      if (!route) return false;
      if (route === '__new_host__') {
        openNewHostModal({ closeMenus: true });
        return true;
      }
      if (route === '__quick_vm__') {
        openQuickVmModal({ closeMenus: true });
        return true;
      }
      navigateAdminShortcut(route);
      return true;
    }

    function handleGlobalShortcut(event) {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const key = String(event.key || '');
      const normalizedKey = key.toLowerCase();
      const modal = openModalBackdrop();

      if (key === '?') {
        event.preventDefault();
        if (modal && modal !== helpModal) return;
        showHelpModal(!(helpModal?.classList.contains('show')));
        clearShortcutPrefix();
        return;
      }

      if (normalizedKey === 't' && !modal && !isEditableShortcutTarget(event.target)) {
        event.preventDefault();
        triggerVisibleTogglerShortcut();
        clearShortcutPrefix();
        return;
      }

      if (modal) {
        clearShortcutPrefix();
        return;
      }

      if (isEditableShortcutTarget(event.target)) {
        clearShortcutPrefix();
        return;
      }

      if (handleShortcutPrefixKey(normalizedKey)) {
        event.preventDefault();
        return;
      }

      if (normalizedKey === 'd') {
        event.preventDefault();
        navigateAdminShortcut('/admin/dashboard');
        clearShortcutPrefix();
        return;
      }

      if (normalizedKey === 'm') {
        event.preventDefault();
        navigateAdminShortcut('/admin/manual');
        clearShortcutPrefix();
        return;
      }

      if (normalizedKey === 'h' || normalizedKey === 'l' || normalizedKey === 's') {
        event.preventDefault();
        if (pendingShortcutPrefix === normalizedKey) {
          clearShortcutPrefix();
          window.__railNav?.toggleGroup?.(normalizedKey === 'h' ? 'hosts' : normalizedKey === 'l' ? 'logs' : 'settings');
          return;
        }
        armShortcutPrefix(normalizedKey);
        return;
      }

      if (normalizedKey === 'n') {
        event.preventDefault();
        triggerNewShortcut();
        clearShortcutPrefix();
        return;
      }

      if (key === '/') {
        event.preventDefault();
        focusHostsFilterShortcut();
        clearShortcutPrefix();
        return;
      }

      if (normalizedKey === 'r') {
        event.preventDefault();
        clearShortcutPrefix();
        reloadCurrentViewShortcut();
      }
    }

    let confirmResolve = null;
    function showConfirmModal(title, body, { action = 'Confirm', warn = true } = {}) {
      return new Promise((resolve) => {
        confirmResolve = resolve;
        if (confirmModalTitle) confirmModalTitle.textContent = title;
        if (confirmModalBody) confirmModalBody.textContent = body;
        if (confirmModalConfirm) {
          confirmModalConfirm.textContent = action;
          confirmModalConfirm.className = warn ? 'btn-warn' : '';
        }
        confirmModal?.classList.add('show');
        setInertBehindModal(confirmModal, true);
      });
    }
    function closeConfirmModal(result) {
      confirmModal?.classList.remove('show');
      setInertBehindModal(confirmModal, false);
      if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
    }
    if (confirmModalCancel) confirmModalCancel.addEventListener('click', () => closeConfirmModal(false));
    if (confirmModalConfirm) confirmModalConfirm.addEventListener('click', () => closeConfirmModal(true));
    window.__confirm = showConfirmModal;
    if (navHelpTrigger) navHelpTrigger.addEventListener('click', () => showHelpModal(true));
    if (helpModalClose) helpModalClose.addEventListener('click', closeHelpModal);
    if (helpModal) {
      helpModal.addEventListener('click', (event) => {
        if (event.target === helpModal) closeHelpModal();
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
          if (apiStatusBadge) {
            apiStatusBadge.textContent = apiDisabled ? 'Killed' : 'Active';
            apiStatusBadge.style.color = apiDisabled ? 'var(--danger)' : 'var(--success)';
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
        if (apiStatusBadge) {
          apiStatusBadge.textContent = 'Unavailable';
          apiStatusBadge.style.color = 'var(--muted)';
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
        if (apiStatusBadge) {
          apiStatusBadge.textContent = apiDisabled ? 'Killed' : 'Active';
          apiStatusBadge.style.color = apiDisabled ? 'var(--danger)' : 'var(--success)';
        }
        flashSaved(apiToggle);
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
        flashSaved(quotaToggle);
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
        renderQuotaMode();
        flashSaved(quotaLimitSlider);
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

    function flashSaved(el) {
      const block = el?.closest?.('.setting-block');
      if (!block) return;
      block.classList.remove('just-saved');
      void block.offsetWidth;
      block.classList.add('just-saved');
      block.addEventListener('animationend', () => block.classList.remove('just-saved'), { once: true });
    }

    function renderCdxSilent() {
      if (!cdxSilentToggle || !cdxSilentLabel) return;
      cdxSilentToggle.checked = !!cdxSilent;
      cdxSilentLabel.textContent = cdxSilent ? 'Silent' : 'Verbose';
      if (cdxSilentBadge) cdxSilentBadge.textContent = cdxSilent ? 'Silent' : 'Verbose';
    }

    function renderReverseDns() {
      renderBinarySetting({
        toggle: reverseDnsToggle,
        label: reverseDnsLabel,
        badge: reverseDnsBadge,
        enabled: !!reverseDnsEnabled,
        badgeOn: 'Enforced',
        badgeOff: 'Relaxed',
      });
    }

    function renderInsecureApproval() {
      renderBinarySetting({
        toggle: insecureApprovalToggle,
        label: insecureApprovalLabel,
        badge: insecureApprovalBadge,
        enabled: !!insecureApprovalEnabled,
        badgeOn: 'Required',
        badgeOff: 'Auto',
        badgeOnColor: 'var(--accent)',
      });
    }

    function renderAutoUpdate() {
      renderBinarySetting({
        toggle: autoUpdateToggle,
        label: autoUpdateLabel,
        badge: autoUpdateBadge,
        enabled: !!autoUpdateEnabled,
        badgeOn: 'Enabled',
        badgeOff: 'Manual',
      });
    }
    function showAccessBlock(title, body) {
      if (!accessBlockModal) return;
      if (accessBlockTitle && title) accessBlockTitle.textContent = title;
      if (accessBlockBody && body) accessBlockBody.textContent = body;
      accessBlockModal.classList.add('show');
      setInertBehindModal(accessBlockModal, true);
    }

    function hideAccessBlock() {
      accessBlockModal?.classList.remove('show');
      setInertBehindModal(accessBlockModal, false);
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
        setInertBehindModal(insecureApprovalModal, true);
      } else {
        insecureApprovalModal.classList.remove('show');
        setInertBehindModal(insecureApprovalModal, false);
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

    function getInsecureApprovalBellContext() {
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (typeof AudioContextCtor !== 'function') return null;
      if (insecureApprovalBellContext) return insecureApprovalBellContext;
      try {
        insecureApprovalBellContext = new AudioContextCtor();
      } catch (err) {
        console.warn('insecure approval bell unavailable', err);
        insecureApprovalBellContext = null;
      }
      return insecureApprovalBellContext;
    }

    async function ringInsecureApprovalBell() {
      const now = Date.now();
      if ((now - lastInsecureApprovalBellAt) < INSECURE_APPROVAL_BELL_COOLDOWN_MS) return;
      const ctx = getInsecureApprovalBellContext();
      if (!ctx) return;
      try {
        if (ctx.state === 'suspended') {
          await ctx.resume();
        }
      } catch (err) {
        console.warn('insecure approval bell resume failed', err);
        return;
      }
      if (ctx.state !== 'running') return;

      lastInsecureApprovalBellAt = now;
      const start = ctx.currentTime + 0.02;
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      master.gain.exponentialRampToValueAtTime(0.0001, start + 1.15);
      master.connect(ctx.destination);

      [
        { offset: 0, frequency: 1318.51, duration: 0.9, gain: 0.18, type: 'triangle' },
        { offset: 0.08, frequency: 1760.0, duration: 0.65, gain: 0.08, type: 'sine' },
        { offset: 0.18, frequency: 2637.02, duration: 0.45, gain: 0.04, type: 'sine' },
      ].forEach((tone) => {
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        oscillator.type = tone.type;
        oscillator.frequency.setValueAtTime(tone.frequency, start + tone.offset);
        gainNode.gain.setValueAtTime(0.0001, start + tone.offset);
        gainNode.gain.exponentialRampToValueAtTime(tone.gain, start + tone.offset + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, start + tone.offset + tone.duration);
        oscillator.connect(gainNode);
        gainNode.connect(master);
        oscillator.start(start + tone.offset);
        oscillator.stop(start + tone.offset + tone.duration + 0.05);
      });
    }

    function enqueueInsecureApproval(request) {
      if (!request || !request.id) return false;
      if (activeInsecureApproval && activeInsecureApproval.id === request.id) return false;
      if (insecureApprovalQueue.some((item) => item.id === request.id)) return false;
      insecureApprovalQueue.push(request);
      if (!activeInsecureApproval) {
        const next = insecureApprovalQueue.shift();
        if (next) presentInsecureApproval(next);
      }
      return true;
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

    async function loadPendingInsecureApprovals() {
      if (!insecureApprovalModal) return;
      try {
        const res = await api('/admin/insecure-approvals/pending');
        const requests = Array.isArray(res?.data?.requests) ? res.data.requests : [];
        requests.forEach((request) => {
          enqueueInsecureApproval({
            id: Number(request.id || 0),
            hostId: Number(request.host_id || 0),
            fqdn: request.fqdn || '',
            requestedAt: request.requested_at || null,
            createdAt: request.updated_at || null,
            command: request.command || '',
          });
        });
      } catch (err) {
        console.warn('pending insecure approvals unavailable', err);
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

    const joplinEnabledToggle = document.getElementById('joplinEnabledToggle');
    const joplinEnabledLabel = document.getElementById('joplinEnabledLabel');
    const joplinUrlInput = document.getElementById('joplinUrlInput');
    const joplinEmailInput = document.getElementById('joplinEmailInput');
    const joplinPasswordInput = document.getElementById('joplinPasswordInput');
    const joplinSyncIntervalInput = document.getElementById('joplinSyncIntervalInput');
    const joplinSaveBtn = document.getElementById('joplinSaveBtn');
    const joplinTestBtn = document.getElementById('joplinTestBtn');
    const joplinSyncBtn = document.getElementById('joplinSyncBtn');
    const joplinStatus = document.getElementById('joplinStatus');

    const defaultJoplinState = {
      enabled: false,
      url: '',
      email: '',
      password_set: false,
      sync_interval_minutes: 15,
      config_complete: false,
      verified_connection: false,
      verified_at: null,
      can_activate: false,
      activation_reason: 'loading',
      auto_disabled: false,
    };
    let joplinState = { ...defaultJoplinState };
    let joplinBusy = {
      loading: false,
      saving: false,
      testing: false,
      toggling: false,
      syncing: false,
    };
    let joplinLoaded = false;
    let joplinStatusMessage = '';
    let joplinStatusTone = '';
    let joplinToggleTargetEnabled = null;

    function normalizeJoplinUrlValue(value) {
      const normalized = String(value || '').trim();
      return normalized ? normalized.replace(/\/+$/, '') : '';
    }

    function normalizeJoplinEmailValue(value) {
      return String(value || '').trim();
    }

    function normalizeJoplinIntervalValue(value) {
      const parsed = Number.parseInt(String(value ?? '').trim(), 10);
      return Number.isFinite(parsed) ? parsed : NaN;
    }

    function setJoplinStatus(msg, tone = '') {
      joplinStatusMessage = String(msg || '').trim();
      joplinStatusTone = tone || '';
      renderJoplinControls();
    }

    function applyJoplinState(data = {}, { resetInputs = false, clearPasswordInput = false } = {}) {
      joplinState = {
        ...defaultJoplinState,
        ...joplinState,
        ...(data || {}),
      };
      joplinState.url = normalizeJoplinUrlValue(joplinState.url);
      joplinState.email = normalizeJoplinEmailValue(joplinState.email);
      joplinState.sync_interval_minutes = Number(joplinState.sync_interval_minutes || 15) || 15;
      if (resetInputs) {
        if (joplinUrlInput) joplinUrlInput.value = joplinState.url || '';
        if (joplinEmailInput) joplinEmailInput.value = joplinState.email || '';
        if (joplinSyncIntervalInput) joplinSyncIntervalInput.value = joplinState.sync_interval_minutes || 15;
      }
      if (clearPasswordInput && joplinPasswordInput) {
        joplinPasswordInput.value = '';
      }
    }

    function getJoplinFormState() {
      const savedInterval = Number(joplinState.sync_interval_minutes || 15) || 15;
      const url = normalizeJoplinUrlValue(joplinUrlInput?.value || joplinState.url || '');
      const email = normalizeJoplinEmailValue(joplinEmailInput?.value || joplinState.email || '');
      const replacementPassword = String(joplinPasswordInput?.value || '');
      const interval = normalizeJoplinIntervalValue(joplinSyncIntervalInput?.value ?? savedInterval);
      return {
        url,
        email,
        replacementPassword,
        interval,
        passwordAvailable: replacementPassword !== '' || !!joplinState.password_set,
      };
    }

    function isJoplinIntervalValid(interval) {
      return Number.isInteger(interval) && interval >= 1 && interval <= 1440;
    }

    function isJoplinUrlValid(url) {
      return url === '' || /^https?:\/\//i.test(url);
    }

    function isJoplinEmailValid(email) {
      return email === '' || email.includes('@');
    }

    function isJoplinDirty() {
      const form = getJoplinFormState();
      const savedUrl = normalizeJoplinUrlValue(joplinState.url);
      const savedEmail = normalizeJoplinEmailValue(joplinState.email);
      const savedInterval = Number(joplinState.sync_interval_minutes || 15) || 15;
      return form.url !== savedUrl
        || form.email !== savedEmail
        || form.interval !== savedInterval
        || form.replacementPassword !== '';
    }

    function formatJoplinVerifiedAt() {
      if (!joplinState.verified_at) return '';
      try {
        return formatTimestamp(joplinState.verified_at);
      } catch (_err) {
        return joplinState.verified_at;
      }
    }

    function describeJoplinSyncResult(sync = {}, { prefix = 'Sync complete:' } = {}) {
      const synced = Number(sync?.synced ?? 0) || 0;
      const notebooks = Number(sync?.notebooks ?? 0) || 0;
      const errors = Number(sync?.errors ?? 0) || 0;
      let msg = `${prefix} ${synced} notes, ${notebooks} folders`;
      if (errors > 0) {
        msg += `, ${errors} errors.`;
      } else {
        msg += '.';
      }

      return {
        msg,
        tone: errors > 0 ? 'error' : 'success',
      };
    }

    function defaultJoplinStatus() {
      const form = getJoplinFormState();
      const dirty = isJoplinDirty();
      if (!joplinLoaded) {
        return { msg: 'Loading saved Joplin configuration…', tone: '' };
      }
      if (dirty) {
        if (!isJoplinUrlValid(form.url)) {
          return { msg: 'Enter a valid http:// or https:// Joplin Server URL, then save.', tone: 'error' };
        }
        if (!form.url) {
          return { msg: 'Save a Joplin Server URL to begin setup.', tone: '' };
        }
        if (!isJoplinEmailValid(form.email)) {
          return { msg: 'Enter a valid Joplin Server account email, then save.', tone: 'error' };
        }
        if (!form.email) {
          return { msg: 'Save a Joplin Server account email to continue.', tone: '' };
        }
        if (!form.passwordAvailable) {
          return { msg: 'Save a Joplin Server password to continue.', tone: '' };
        }
        if (!isJoplinIntervalValid(form.interval)) {
          return { msg: 'Enter a sync interval between 1 and 1440 minutes, then save.', tone: 'error' };
        }
        return { msg: 'Unsaved changes. Save before testing the connection or enabling the module.', tone: '' };
      }
      if (!joplinState.url) {
        return { msg: 'Save a Joplin Server URL to begin setup.', tone: '' };
      }
      if (!joplinState.email) {
        return { msg: 'Save a Joplin Server account email to continue.', tone: '' };
      }
      if (!joplinState.password_set) {
        return { msg: 'Save a Joplin Server password to continue.', tone: '' };
      }
      if (!joplinState.verified_connection) {
        return { msg: 'Saved configuration needs a successful Joplin Server connection test before activation.', tone: '' };
      }
      const verifiedAt = formatJoplinVerifiedAt();
      if (joplinState.enabled) {
        return {
          msg: verifiedAt ? `Module enabled. Saved connection verified at ${verifiedAt}.` : 'Module enabled and the saved connection is verified.',
          tone: 'success',
        };
      }
      return {
        msg: verifiedAt ? `Saved connection verified at ${verifiedAt}. Ready to enable.` : 'Saved connection verified. Ready to enable.',
        tone: 'success',
      };
    }

    function renderJoplinControls() {
      if (!joplinEnabledToggle) return;
      const form = getJoplinFormState();
      const dirty = isJoplinDirty();
      const formValid = isJoplinUrlValid(form.url)
        && isJoplinEmailValid(form.email)
        && isJoplinIntervalValid(form.interval)
        && !!form.url
        && !!form.email
        && !!form.passwordAvailable;
      const saveAllowed = joplinLoaded
        && dirty
        && formValid
        && !joplinBusy.saving
        && !joplinBusy.testing
        && !joplinBusy.toggling;
      const testAllowed = joplinLoaded
        && !dirty
        && !!joplinState.url
        && !!joplinState.email
        && !!joplinState.password_set
        && !joplinBusy.saving
        && !joplinBusy.testing
        && !joplinBusy.toggling;
      const toggleAllowed = joplinLoaded
        && !dirty
        && !joplinBusy.saving
        && !joplinBusy.testing
        && !joplinBusy.toggling
        && (joplinState.enabled || joplinState.can_activate);
      const syncAllowed = joplinLoaded
        && !dirty
        && !!joplinState.enabled
        && !joplinBusy.saving
        && !joplinBusy.testing
        && !joplinBusy.toggling
        && !joplinBusy.syncing;

      joplinEnabledToggle.checked = !!joplinState.enabled;
      joplinEnabledToggle.disabled = !toggleAllowed;
      if (joplinEnabledLabel) {
        joplinEnabledLabel.textContent = joplinLoaded
          ? (joplinState.enabled ? 'Enabled' : 'Disabled')
          : 'Loading…';
      }
      if (joplinSaveBtn) joplinSaveBtn.disabled = !saveAllowed;
      if (joplinTestBtn) joplinTestBtn.disabled = !testAllowed;
      if (joplinSyncBtn) joplinSyncBtn.disabled = !syncAllowed;

      let status = { msg: joplinStatusMessage, tone: joplinStatusTone };
      if (joplinBusy.loading) {
        status = { msg: 'Loading saved Joplin configuration…', tone: '' };
      } else if (joplinBusy.saving) {
        status = { msg: 'Saving Joplin configuration…', tone: '' };
      } else if (joplinBusy.testing) {
        status = { msg: 'Testing the saved Joplin connection…', tone: '' };
      } else if (joplinBusy.toggling) {
        status = { msg: joplinToggleTargetEnabled ? 'Enabling Joplin…' : 'Disabling Joplin…', tone: '' };
      } else if (joplinBusy.syncing) {
        status = { msg: 'Syncing Joplin notes…', tone: '' };
      } else if (!status.msg) {
        status = defaultJoplinStatus();
      }

      if (joplinStatus) {
        joplinStatus.textContent = status.msg;
        joplinStatus.style.color = status.tone === 'error'
          ? 'var(--danger)'
          : status.tone === 'success'
            ? 'var(--success)'
            : 'var(--muted)';
      }
    }

    async function loadJoplinConfig() {
      if (!joplinEnabledToggle) return;
      joplinBusy.loading = true;
      joplinStatusMessage = '';
      renderJoplinControls();
      try {
        const res = await api('/admin/joplin/config');
        applyJoplinState(res.data || {}, { resetInputs: true, clearPasswordInput: true });
        joplinLoaded = true;
      } catch (err) {
        console.warn('joplin config unavailable', err);
        joplinLoaded = false;
        setJoplinStatus('Could not load config: ' + err.message, 'error');
      } finally {
        joplinBusy.loading = false;
        renderJoplinControls();
      }
    }

    [joplinUrlInput, joplinEmailInput, joplinPasswordInput, joplinSyncIntervalInput].forEach((input) => {
      if (!input) return;
      input.addEventListener('input', () => {
        joplinStatusMessage = '';
        renderJoplinControls();
      });
      input.addEventListener('change', () => {
        joplinStatusMessage = '';
        renderJoplinControls();
      });
    });

    if (joplinEnabledToggle) {
      joplinEnabledToggle.addEventListener('change', async () => {
        const targetEnabled = !!joplinEnabledToggle.checked;
        const previousEnabled = !!joplinState.enabled;
        if (!joplinLoaded) {
          joplinEnabledToggle.checked = previousEnabled;
          return;
        }
        joplinToggleTargetEnabled = targetEnabled;
        joplinBusy.toggling = true;
        joplinStatusMessage = '';
        renderJoplinControls();
        try {
          const res = await api('/admin/joplin/config', {
            method: 'POST',
            json: { enabled: targetEnabled },
          });
          applyJoplinState(res.data || {});
          if (targetEnabled && res.data?.initial_sync) {
            const syncStatus = describeJoplinSyncResult(res.data.initial_sync, { prefix: 'Joplin enabled. Initial sync complete:' });
            setJoplinStatus(syncStatus.msg, syncStatus.tone);
          } else {
            setJoplinStatus(targetEnabled ? 'Joplin enabled.' : 'Joplin disabled.', targetEnabled ? 'success' : '');
          }
        } catch (err) {
          joplinEnabledToggle.checked = previousEnabled;
          applyJoplinState({ enabled: previousEnabled });
          toast('Joplin toggle failed: ' + err.message, 'error');
          setJoplinStatus('Activation failed: ' + err.message, 'error');
        } finally {
          joplinBusy.toggling = false;
          joplinToggleTargetEnabled = null;
          renderJoplinControls();
        }
      });
    }

    if (joplinSaveBtn) {
      joplinSaveBtn.addEventListener('click', async () => {
        joplinBusy.saving = true;
        joplinStatusMessage = '';
        renderJoplinControls();
        try {
          const form = getJoplinFormState();
          const body = {
            url: form.url,
            email: form.email,
            sync_interval_minutes: form.interval,
          };
          if (form.replacementPassword) {
            body.password = form.replacementPassword;
          }
          const res = await api('/admin/joplin/config', { method: 'POST', json: body });
          applyJoplinState(res.data || {}, { resetInputs: true, clearPasswordInput: true });
          if (res.data?.auto_disabled) {
            setJoplinStatus('Connection settings changed. Joplin was disabled until the saved config is tested again.', 'warn');
          } else {
            setJoplinStatus('Joplin configuration saved.', 'success');
          }
          flashSaved(joplinSaveBtn);
        } catch (err) {
          toast('Joplin save failed: ' + err.message, 'error');
          setJoplinStatus('Save failed: ' + err.message, 'error');
        } finally {
          joplinBusy.saving = false;
          renderJoplinControls();
        }
      });
    }

    if (joplinTestBtn) {
      joplinTestBtn.addEventListener('click', async () => {
        joplinBusy.testing = true;
        joplinStatusMessage = '';
        renderJoplinControls();
        try {
          const res = await api('/admin/joplin/test', { method: 'POST', json: {} });
          const data = res.data || {};
          applyJoplinState(data);
          if (data.reachable) {
            const suffix = data.status_code ? ' (HTTP ' + data.status_code + ').' : '.';
            setJoplinStatus('Connection OK' + suffix + ' You can enable the module now.', 'success');
          } else {
            setJoplinStatus(data.reason || ('Connection test failed (HTTP ' + (data.status_code || '?') + ').'), 'error');
          }
        } catch (err) {
          setJoplinStatus('Test failed: ' + err.message, 'error');
        } finally {
          joplinBusy.testing = false;
          renderJoplinControls();
        }
      });
    }

    if (joplinSyncBtn) {
      joplinSyncBtn.addEventListener('click', async () => {
        joplinBusy.syncing = true;
        joplinStatusMessage = '';
        renderJoplinControls();
        try {
          const res = await api('/admin/joplin/sync', { method: 'POST', json: {} });
          const data = res.data || {};
          const syncStatus = describeJoplinSyncResult(data.sync || data.initial_sync || data);
          setJoplinStatus(syncStatus.msg, syncStatus.tone);
        } catch (err) {
          setJoplinStatus('Sync failed: ' + err.message, 'error');
        } finally {
          joplinBusy.syncing = false;
          renderJoplinControls();
        }
      });
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
        flashSaved(cdxSilentToggle);
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
        flashSaved(reverseDnsToggle);
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
        flashSaved(insecureApprovalToggle);
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
        flashSaved(autoUpdateToggle);
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
        let label = 'Unavailable';
        if (meta) {
          if (meta.enforced) label = 'Enforced';
          else if (meta.present) label = 'Optional (cert present)';
          else label = 'Disabled';
        }
        mtlsSettingStatus.textContent = label;
        mtlsSettingStatus.style.color = meta?.enforced ? 'var(--success)' : 'var(--muted)';
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

	    function normalizeClaudeVersion(value) {
	      if (typeof value !== 'string') return '';
	      let normalized = value.trim();
	      normalized = normalized.replace(/^(claude-code|claude-cli|claude)/i, '');
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
      const wrapperTarget = typeof currentOverview?.versions?.wrapper_version === 'string'
        ? currentOverview.versions.wrapper_version.trim().replace(/^v/i, '')
        : '';
      const wrapperReported = typeof currentOverview?.versions?.reported_wrapper_version === 'string'
        ? currentOverview.versions.reported_wrapper_version.trim().replace(/^v/i, '')
        : '';
      const checkedAt = currentOverview?.versions?.client_version_checked_at ?? null;

      if (lock) {
        const at = lockAt ? formatRelative(lockAt) : 'unknown time';
        const codexExtra = reported && reported !== lock ? ` · Codex in use: ${reported}` : '';
        const wrapperExtra = wrapperTarget ? ` · Wrapper target ${wrapperTarget}${wrapperReported && wrapperReported !== wrapperTarget ? `, in use ${wrapperReported}` : ''}` : '';
        codexVersionMeta.textContent = `Pinned to ${lock} (set ${at})${codexExtra}${wrapperExtra}.`;
        return;
      }
      if (target) {
        const at = checkedAt ? formatRelative(checkedAt) : 'unknown time';
        const codexExtra = reported && reported !== target ? ` · Codex in use: ${reported}` : '';
        const wrapperExtra = wrapperTarget ? ` · Wrapper target ${wrapperTarget}${wrapperReported && wrapperReported !== wrapperTarget ? `, in use ${wrapperReported}` : ''}` : '';
        codexVersionMeta.textContent = `Latest targeting ${target} (checked ${at})${codexExtra}${wrapperExtra}.`;
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

    function parseEngines(raw) {
      if (!raw || typeof raw !== 'string') return ['codex'];
      return raw.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    }

    function buildEnginesValue() {
      const parts = [];
      if (engineCodexToggle?.checked) parts.push('codex');
      if (engineClaudeToggle?.checked) parts.push('claude');
      return parts.length ? parts.join(',') : 'codex';
    }

    function installerModeFromEngines(enginesRaw) {
      const engines = parseEngines(enginesRaw);
      if (engines.includes('codex') && engines.includes('claude')) return 'both';
      if (engines.includes('claude')) return 'claude';
      return 'codex';
    }

    function normalizeInstallerMode(mode, enginesRaw) {
      const normalized = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
      if (['codex', 'claude', 'both'].includes(normalized)) return normalized;
      return installerModeFromEngines(enginesRaw);
    }

    function installerModeLabel(mode) {
      if (mode === 'claude') return 'Claude';
      if (mode === 'both') return 'Codex + Claude';
      return 'Codex';
    }

    function installerCommandLabel(mode) {
      if (mode === 'claude') return 'Claude installer command';
      if (mode === 'both') return 'Codex + Claude installer command';
      return 'Codex installer command';
    }

    function installerActionLabel(mode) {
      if (mode === 'claude') return 'Install Claude';
      if (mode === 'both') return 'Install Codex + Claude';
      return 'Install Codex';
    }

    function hostInstallerEngineSet(host, addEngine = null) {
      const engines = parseEngines(host?.engines);
      if (addEngine && !engines.includes(addEngine)) {
        engines.push(addEngine);
      }
      return engines.includes('codex') && engines.includes('claude')
        ? ['codex', 'claude']
        : engines;
    }

    function renderEngineBadges(enginesRaw) {
      const engines = parseEngines(enginesRaw);
      const badges = [];
      if (engines.includes('codex')) {
        badges.push('<span class="chip engine-badge engine-cdx" title="Codex engine">CDX</span>');
      }
      if (engines.includes('claude')) {
        badges.push('<span class="chip engine-badge engine-clx" title="Claude engine">CLX</span>');
      }
      return badges.length ? badges.join(' ') : '<span class="muted">—</span>';
    }

    // One-time init guards for lazily loaded panels
    let clientLogsInited = false;
    let mcpLogsInited = false;
    let configInited = false;
    let memoriesInited = false;
    let hostsInited = false;
    let dataLoaded = false;
    let loadAllPromise = null;
    let hostDetailLoaded = false;
    let hostDetailSupportLoaded = false;
    let hostDetailLoadPromise = null;
    let hostDetailSupportPromise = null;
    let hostDetailLoadError = null;
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

    // --- Compatible-API Keys management (OpenAI + Anthropic) ---
    {
      let apiKeysInited = false;
      let currentApiKeys = [];
      let openaiApiDisabled = null;
      let claudeApiDisabled = null;
      const apiKeysTbody = document.querySelector('#apiKeysTable tbody');
      const newApiKeyBtn = document.getElementById('newApiKeyBtn');
      const openaiApiToggle = document.getElementById('openaiApiToggle');
      const openaiApiToggleLabel = document.getElementById('openaiApiToggleLabel');
      const claudeApiToggle = document.getElementById('claudeApiToggle');
      const claudeApiToggleLabel = document.getElementById('claudeApiToggleLabel');
      const apiKeyModalBackdrop = document.getElementById('apiKeyModalBackdrop');
      const apiKeyModalClose = document.getElementById('apiKeyModalClose');
      const apiKeyModalCancel = document.getElementById('apiKeyModalCancel');
      const apiKeyModalCreate = document.getElementById('apiKeyModalCreate');
      const apiKeyName = document.getElementById('apiKeyName');
      const apiKeyEngine = document.getElementById('apiKeyEngine');
      const apiKeyRpm = document.getElementById('apiKeyRpm');
      const apiKeyExpiresToggle = document.getElementById('apiKeyExpiresToggle');
      const apiKeyExpires = document.getElementById('apiKeyExpires');
      const apiKeyStatus = document.getElementById('apiKeyStatus');
      const apiKeyCreatedBox = document.getElementById('apiKeyCreatedBox');
      const apiKeyCreatedValue = document.getElementById('apiKeyCreatedValue');
      const apiKeyCopyBtn = document.getElementById('apiKeyCopyBtn');
      const apiKeyFormFields = document.getElementById('apiKeyFormFields');

      if (apiKeyExpiresToggle) apiKeyExpiresToggle.addEventListener('change', () => {
        if (apiKeyExpires) apiKeyExpires.hidden = !apiKeyExpiresToggle.checked;
      });

      function formatApiKeyDate(dateStr) {
        if (!dateStr) return '\u2014';
        try {
          const d = new Date(dateStr);
          return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        } catch { return dateStr; }
      }

      function formatTimeAgo(dateStr) {
        if (!dateStr) return 'Never';
        try {
          const d = new Date(dateStr);
          const now = Date.now();
          const diffMs = now - d.getTime();
          if (diffMs < 60000) return 'Just now';
          if (diffMs < 3600000) return Math.floor(diffMs / 60000) + 'm ago';
          if (diffMs < 86400000) return Math.floor(diffMs / 3600000) + 'h ago';
          return Math.floor(diffMs / 86400000) + 'd ago';
        } catch { return dateStr; }
      }

      function deriveKeyEngine(key) {
        if (key && typeof key.engine === 'string') return key.engine;
        if (typeof key?.key_prefix === 'string') {
          if (key.key_prefix.startsWith('sk-claude-')) return 'claude';
          if (key.key_prefix.startsWith('sk-codex-')) return 'codex';
        }
        return 'codex';
      }

      function engineBadgeHtml(engine) {
        if (engine === 'claude') {
          return '<span class="chip engine-badge engine-clx" title="Anthropic / Claude">Claude</span>';
        }
        return '<span class="chip engine-badge engine-cdx" title="OpenAI / Codex">OpenAI</span>';
      }

      function adminKeyPath(engine) {
        return engine === 'claude' ? '/admin/claude/keys' : '/admin/openai/keys';
      }

      function renderApiKeys(keys) {
        currentApiKeys = Array.isArray(keys) ? keys : [];
        if (!apiKeysTbody) return;
        if (currentApiKeys.length === 0) {
          apiKeysTbody.innerHTML = '<tr><td colspan="8" class="muted">No API keys yet. Click "New key" to create one.</td></tr>';
          return;
        }
        apiKeysTbody.innerHTML = currentApiKeys.map((k) => {
          const active = Number(k.is_active) === 1;
          const useCount = Number(k.use_count) || 0;
          const engine = deriveKeyEngine(k);
          return `<tr data-engine="${escapeHtml(engine)}">
            <td data-label="Name">${escapeHtml(k.name)}</td>
            <td data-label="Engine">${engineBadgeHtml(engine)}</td>
            <td data-label="Key"><code>${escapeHtml(k.key_prefix)}</code></td>
            <td data-label="Used">${useCount.toLocaleString()}</td>
            <td data-label="Last used">${formatTimeAgo(k.last_used_at)}</td>
            <td data-label="Created">${formatApiKeyDate(k.created_at)}</td>
            <td data-label="Enabled">
              <label class="toggle">
                <input type="checkbox" class="apikey-toggle" data-id="${k.id}" data-engine="${escapeHtml(engine)}" ${active ? 'checked' : ''}>
                <span class="track"><span class="thumb"></span></span>
              </label>
            </td>
            <td data-label="Actions">
              <div class="table-actions">
                <button class="ghost tiny-btn danger apikey-delete" data-id="${k.id}" data-engine="${escapeHtml(engine)}">Delete</button>
              </div>
            </td>
          </tr>`;
        }).join('');

        apiKeysTbody.querySelectorAll('.apikey-toggle').forEach((toggle) => {
          toggle.addEventListener('change', async () => {
            const id = toggle.getAttribute('data-id');
            const engine = toggle.getAttribute('data-engine') || 'codex';
            const active = toggle.checked;
            toggle.disabled = true;
            try {
              await api(`${adminKeyPath(engine)}/${id}/toggle`, { method: 'POST', json: { active } });
              toast(active ? 'Key enabled' : 'Key disabled', 'success');
            } catch (err) {
              toggle.checked = !active;
              toast(`Toggle failed: ${err.message}`, 'error');
            } finally {
              toggle.disabled = false;
            }
          });
        });

        apiKeysTbody.querySelectorAll('.apikey-delete').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const engine = btn.getAttribute('data-engine') || 'codex';
            const key = currentApiKeys.find((k) => String(k.id) === id);
            if (!await showConfirmModal('Delete API key', `Permanently delete key "${key?.name || id}"? This cannot be undone.`, { action: 'Delete', warn: true })) return;
            btn.disabled = true;
            try {
              await api(`${adminKeyPath(engine)}/${id}`, { method: 'DELETE' });
              toast('API key deleted', 'success');
              await loadApiKeys();
            } catch (err) {
              toast(`Delete failed: ${err.message}`, 'error');
            } finally {
              btn.disabled = false;
            }
          });
        });
      }

      async function loadApiKeys() {
        try {
          // Fetch both engines in parallel so the "API Keys" table covers Codex and Claude.
          const [openaiResp, claudeResp] = await Promise.all([
            api('/admin/openai/keys').catch(() => ({ data: [] })),
            api('/admin/claude/keys').catch(() => ({ data: [] })),
          ]);
          const openaiKeys = Array.isArray(openaiResp?.data) ? openaiResp.data.map((k) => ({ ...k, engine: k.engine || 'codex' })) : [];
          const claudeKeys = Array.isArray(claudeResp?.data) ? claudeResp.data.map((k) => ({ ...k, engine: k.engine || 'claude' })) : [];
          renderApiKeys([...openaiKeys, ...claudeKeys]);
        } catch (err) {
          if (apiKeysTbody) apiKeysTbody.innerHTML = `<tr><td colspan="8" class="muted">Failed to load keys: ${escapeHtml(err.message)}</td></tr>`;
        }
      }

      function showApiKeyModal(show) {
        if (!apiKeyModalBackdrop) return;
        if (show) {
          apiKeyModalBackdrop.classList.add('show');
          // Reset to creation mode
          if (apiKeyFormFields) apiKeyFormFields.hidden = false;
          if (apiKeyCreatedBox) apiKeyCreatedBox.hidden = true;
          if (apiKeyModalCreate) { apiKeyModalCreate.hidden = false; apiKeyModalCreate.disabled = false; apiKeyModalCreate.textContent = 'Create'; }
          if (apiKeyName) apiKeyName.value = '';
          if (apiKeyRpm) apiKeyRpm.value = '60';
          if (apiKeyExpiresToggle) { apiKeyExpiresToggle.checked = false; }
          if (apiKeyExpires) { apiKeyExpires.value = ''; apiKeyExpires.hidden = true; }
          if (apiKeyStatus) apiKeyStatus.textContent = '';
          setTimeout(() => apiKeyName?.focus(), 50);
        } else {
          apiKeyModalBackdrop.classList.remove('show');
        }
      }

      function showCreatedKey(key) {
        if (apiKeyFormFields) apiKeyFormFields.hidden = true;
        if (apiKeyCreatedBox) apiKeyCreatedBox.hidden = false;
        if (apiKeyCreatedValue) apiKeyCreatedValue.textContent = key;
        if (apiKeyModalCreate) apiKeyModalCreate.hidden = true;
      }

      if (newApiKeyBtn) newApiKeyBtn.addEventListener('click', () => showApiKeyModal(true));
      if (apiKeyModalClose) apiKeyModalClose.addEventListener('click', () => { showApiKeyModal(false); loadApiKeys(); });
      if (apiKeyModalCancel) apiKeyModalCancel.addEventListener('click', () => { showApiKeyModal(false); loadApiKeys(); });
      if (apiKeyModalBackdrop) apiKeyModalBackdrop.addEventListener('click', (e) => {
        if (e.target === apiKeyModalBackdrop) { showApiKeyModal(false); loadApiKeys(); }
      });

      if (apiKeyCopyBtn) apiKeyCopyBtn.addEventListener('click', () => {
        const val = apiKeyCreatedValue?.textContent || '';
        if (val) {
          navigator.clipboard.writeText(val).then(() => {
            apiKeyCopyBtn.textContent = 'Copied!';
            setTimeout(() => { apiKeyCopyBtn.textContent = 'Copy'; }, 2000);
          }).catch(() => {
            toast('Copy failed — select and copy manually', 'warn');
          });
        }
      });

      if (apiKeyModalCreate) apiKeyModalCreate.addEventListener('click', async () => {
        const name = (apiKeyName?.value || '').trim();
        if (!name) {
          if (apiKeyStatus) apiKeyStatus.textContent = 'Name is required.';
          apiKeyName?.focus();
          return;
        }
        const engine = apiKeyEngine?.value === 'claude' ? 'claude' : 'codex';
        apiKeyModalCreate.disabled = true;
        apiKeyModalCreate.textContent = 'Creating\u2026';
        if (apiKeyStatus) apiKeyStatus.textContent = '';
        try {
          const body = { name, rate_limit_rpm: parseInt(apiKeyRpm?.value || '60', 10) || 60 };
          if (apiKeyExpiresToggle?.checked && apiKeyExpires?.value) {
            body.expires_at = new Date(apiKeyExpires.value).toISOString();
          }
          const resp = await api(adminKeyPath(engine), { method: 'POST', json: body });
          const key = resp?.data?.key;
          if (key) {
            showCreatedKey(key);
            toast('API key created', 'success');
          } else {
            if (apiKeyStatus) apiKeyStatus.textContent = 'Key created but could not retrieve value.';
          }
        } catch (err) {
          if (apiKeyStatus) apiKeyStatus.textContent = `Failed: ${err.message}`;
          apiKeyModalCreate.disabled = false;
          apiKeyModalCreate.textContent = 'Create';
        }
      });

      // Endpoint URL display
      const apiEndpointUrl = document.getElementById('apiEndpointUrl');
      const apiEndpointCopied = document.getElementById('apiEndpointCopied');
      if (apiEndpointUrl) {
        apiEndpointUrl.textContent = window.location.origin + '/v1/chat/completions';
        apiEndpointUrl.addEventListener('click', () => {
          navigator.clipboard.writeText(apiEndpointUrl.textContent).then(() => {
            if (apiEndpointCopied) { apiEndpointCopied.hidden = false; setTimeout(() => { apiEndpointCopied.hidden = true; }, 2000); }
          }).catch(() => toast('Copy failed', 'warn'));
        });
      }

      // --- OpenAI API master toggle ---
      async function loadOpenaiApiState() {
        try {
          const res = await api('/admin/openai/state');
          openaiApiDisabled = !!res.data?.disabled;
          if (openaiApiToggle) {
            openaiApiToggle.checked = !openaiApiDisabled;
            openaiApiToggle.disabled = false;
            if (openaiApiToggleLabel) {
              openaiApiToggleLabel.textContent = openaiApiDisabled ? 'Disabled' : 'Enabled';
            }
          }
        } catch (err) {
          console.error('openai api state', err);
          if (openaiApiToggle) { openaiApiToggle.checked = false; openaiApiToggle.disabled = true; }
          if (openaiApiToggleLabel) openaiApiToggleLabel.textContent = 'Unavailable';
        }
      }

      async function setOpenaiApiState(enabled) {
        if (!openaiApiToggle) return;
        openaiApiToggle.disabled = true;
        try {
          await api('/admin/openai/state', { method: 'POST', json: { disabled: !enabled } });
          openaiApiDisabled = !enabled;
          if (openaiApiToggleLabel) openaiApiToggleLabel.textContent = openaiApiDisabled ? 'Disabled' : 'Enabled';
        } catch (err) {
          toast(`OpenAI API toggle failed: ${err.message}`, 'error');
          openaiApiToggle.checked = !enabled;
        } finally {
          openaiApiToggle.disabled = false;
        }
      }

      if (openaiApiToggle) {
        openaiApiToggle.addEventListener('change', () => setOpenaiApiState(openaiApiToggle.checked));
      }

      // --- Claude compat API master toggle (parallel to OpenAI) ---
      async function loadClaudeApiState() {
        try {
          const res = await api('/admin/claude/state');
          claudeApiDisabled = !!res.data?.disabled;
          if (claudeApiToggle) {
            claudeApiToggle.checked = !claudeApiDisabled;
            claudeApiToggle.disabled = false;
            if (claudeApiToggleLabel) {
              claudeApiToggleLabel.textContent = claudeApiDisabled ? 'Claude off' : 'Claude on';
            }
          }
        } catch (err) {
          if (claudeApiToggle) { claudeApiToggle.checked = false; claudeApiToggle.disabled = true; }
          if (claudeApiToggleLabel) claudeApiToggleLabel.textContent = 'Unavailable';
        }
      }

      async function setClaudeApiState(enabled) {
        if (!claudeApiToggle) return;
        claudeApiToggle.disabled = true;
        try {
          await api('/admin/claude/state', { method: 'POST', json: { disabled: !enabled } });
          claudeApiDisabled = !enabled;
          if (claudeApiToggleLabel) claudeApiToggleLabel.textContent = claudeApiDisabled ? 'Claude off' : 'Claude on';
        } catch (err) {
          toast(`Claude API toggle failed: ${err.message}`, 'error');
          claudeApiToggle.checked = !enabled;
        } finally {
          claudeApiToggle.disabled = false;
        }
      }

      if (claudeApiToggle) {
        claudeApiToggle.addEventListener('change', () => setClaudeApiState(claudeApiToggle.checked));
      }

      // Expose loaders so initApiKeys / shared init can call them on panel show.
      window.__loadClaudeApiState = loadClaudeApiState;
      window.__loadApiKeys = loadApiKeys;

      // --- API Reference modal ---
      const apiRefModalBackdrop = document.getElementById('apiRefModalBackdrop');
      const apiRefModalClose = document.getElementById('apiRefModalClose');
      const apiRefBtn = document.getElementById('apiRefBtn');

      function showApiRefModal(show) {
        if (!apiRefModalBackdrop) return;
        if (show) {
          // Populate dynamic base URL and curl examples
          const base = window.location.origin;
          const el = document.getElementById('apiRefBaseUrl');
          if (el) el.textContent = base + '/v1';

          const chatEx = document.getElementById('apiRefChatExample');
          if (chatEx) chatEx.textContent = `curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer sk-codex-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ]
}'`;

          const responsesEx = document.getElementById('apiRefResponsesExample');
          if (responsesEx) responsesEx.textContent = `curl ${base}/v1/responses \\
  -H "Authorization: Bearer sk-codex-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "input": "Reply with exactly pong"
}'`;

          const compEx = document.getElementById('apiRefCompletionsExample');
          if (compEx) compEx.textContent = `curl ${base}/v1/completions \\
  -H "Authorization: Bearer sk-codex-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "prompt": "Once upon a time"
}'`;

          const modelsEx = document.getElementById('apiRefModelsExample');
          if (modelsEx) modelsEx.textContent = `curl ${base}/v1/models \\
  -H "Authorization: Bearer sk-codex-YOUR_KEY"`;

          const embedEx = document.getElementById('apiRefEmbeddingsExample');
          if (embedEx) embedEx.textContent = `curl ${base}/v1/embeddings \\
  -H "Authorization: Bearer sk-codex-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
  "input": "The quick brown fox"
}'`;

          apiRefModalBackdrop.classList.add('show');
        } else {
          apiRefModalBackdrop.classList.remove('show');
        }
      }

      if (apiRefBtn) apiRefBtn.addEventListener('click', () => showApiRefModal(true));
      if (apiRefModalClose) apiRefModalClose.addEventListener('click', () => showApiRefModal(false));
      if (apiRefModalBackdrop) apiRefModalBackdrop.addEventListener('click', (e) => {
        if (e.target === apiRefModalBackdrop) showApiRefModal(false);
      });

      // Tab switching
      if (apiRefModalBackdrop) {
        apiRefModalBackdrop.querySelectorAll('.api-ref-tab').forEach((tab) => {
          tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-api-tab');
            apiRefModalBackdrop.querySelectorAll('.api-ref-tab').forEach((t) => t.classList.remove('is-active'));
            tab.classList.add('is-active');
            apiRefModalBackdrop.querySelectorAll('.api-ref-section').forEach((s) => {
              s.hidden = s.getAttribute('data-api-section') !== target;
            });
          });
        });

        // Copy buttons
        apiRefModalBackdrop.querySelectorAll('.api-ref-copy').forEach((btn) => {
          btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-copy-target');
            const el = document.getElementById(targetId);
            if (!el) return;
            navigator.clipboard.writeText(el.textContent).then(() => {
              btn.textContent = 'Copied!';
              setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
            }).catch(() => toast('Copy failed', 'warn'));
          });
        });
      }

      window.__loadOpenaiApiState = loadOpenaiApiState;

      window.__initApiKeysOnce = () => {
        if (apiKeysInited) return;
        apiKeysInited = true;
        loadApiKeys();
        loadOpenaiApiState();
        loadClaudeApiState();
      };
    }

    function setAgentsStatusMessage(text, tone) {
      if (!agentsStatus) return;
      agentsStatus.textContent = text;
      agentsStatus.classList.remove('status-ok', 'status-warn', 'status-error');
      if (tone) agentsStatus.classList.add(`status-${tone}`);
    }

    function normalizeAgentsEditorText(value) {
      return String(value ?? '').replace(/\r\n?/g, '\n');
    }

    function agentsCurrentContent(doc = currentAgents) {
      return normalizeAgentsEditorText(typeof doc?.content === 'string' ? doc.content : '');
    }

    function agentsHasUnsavedChanges() {
      if (!agentsEditing || !agentsEditorInline) return false;
      return normalizeAgentsEditorText(agentsEditorInline.value) !== agentsOriginalContent;
    }

    function setAgentsTab(tab) {
      const nextTab = tab === 'backups' ? 'backups' : 'content';
      if (nextTab !== agentsActiveTab && agentsHasUnsavedChanges()) {
        setAgentsStatusMessage('Save AGENTS.md before leaving the editor.', 'warn');
        return;
      }
      agentsActiveTab = nextTab;
      agentsTabButtons.forEach((button) => {
        const active = (button.dataset.agentsTab || 'content') === agentsActiveTab;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      agentsTabPanels.forEach((panel) => {
        panel.hidden = (panel.dataset.agentsTabPanel || 'content') !== agentsActiveTab;
      });
    }

    function syncAgentsEditorUI() {
      const dirty = agentsHasUnsavedChanges();

      if (window.__adminDirtyModules) {
        if (dirty) window.__adminDirtyModules.add('agents');
        else window.__adminDirtyModules.delete('agents');
      }

      if (agentsPreview) agentsPreview.hidden = agentsEditing;
      if (agentsEditorInline) agentsEditorInline.hidden = !agentsEditing;
      if (agentsSaveInline) {
        agentsSaveInline.hidden = !dirty;
        agentsSaveInline.disabled = agentsSaveInFlight;
        agentsSaveInline.textContent = agentsSaveInFlight ? 'Saving…' : 'Save';
      }
    }

    function renderAgentsVersions(doc) {
      if (!agentsVersionsBody) return;

      const versions = Array.isArray(doc?.versions) ? doc.versions : [];
      const hostCounts = {};
      (Array.isArray(currentHosts) ? currentHosts : []).forEach((host) => {
        const versionId = normalizeAgentsVersionId(host?.agents_document_id_override);
        if (!versionId) return;
        hostCounts[versionId] = (hostCounts[versionId] || 0) + 1;
      });

      if (agentsBackupsMeta) {
        const backupCount = versions.length;
        agentsBackupsMeta.textContent = backupCount === 0
          ? 'No AGENTS backups yet.'
          : `${formatNumber(backupCount)} backup${backupCount === 1 ? '' : 's'} in history. Restore makes a selected backup current production.`;
      }

      if (!versions.length) {
        agentsVersionsBody.innerHTML = '<tr><td class="muted" colspan="6">No backups yet.</td></tr>';
        return;
      }

      agentsVersionsBody.innerHTML = versions.map((version) => {
        const id = normalizeAgentsVersionId(version?.id);
        const sha = typeof version?.sha256 === 'string' ? version.sha256 : '';
        const updated = version?.updated_at ? formatRelative(version.updated_at) : '—';
        const bytes = Number(version?.size_bytes);
        const sizeText = Number.isFinite(bytes) ? `${formatNumber(bytes)} bytes` : '—';
        const hostCount = id ? (hostCounts[id] || 0) : 0;
        const isServed = !!version?.is_served;
        const isLatest = !!version?.is_latest;
        const isActive = !!version?.is_active;
        const busy = agentsDeleteInFlight || agentsRestoreInFlight;
        const statusChips = [];
        if (isServed) statusChips.push('<span class="pill ok">Current</span>');
        if (!isServed && isActive) statusChips.push('<span class="pill warn">Pinned</span>');
        if (isLatest) statusChips.push('<span class="pill accent">Latest</span>');
        if (hostCount > 0) statusChips.push(`<span class="pill warn">${formatNumber(hostCount)} pinned</span>`);
        return `
          <tr data-version-id="${id || ''}"${isServed ? ' class="is-served"' : ''}>
            <td>#${id || '—'}</td>
            <td>${escapeHtml(updated)}</td>
            <td>${escapeHtml(sizeText)}</td>
            <td>${formatNumber(hostCount)}</td>
            <td class="agents-sha">${escapeHtml(sha ? sha.slice(0, 12) : '—')}</td>
            <td class="agents-version-actions">
              <span class="agents-version-pills">${statusChips.join(' ')}</span>
              <span class="agents-version-btns">
                ${isServed
                  ? '<button class="ghost tiny-btn" disabled>Current</button>'
                  : `<button class="ghost tiny-btn" data-action="agents-restore" data-version-id="${id}"${busy ? ' disabled' : ''}>Restore</button>`}
                ${isServed
                  ? '<button class="ghost tiny-btn" disabled>Delete</button>'
                  : `<button class="danger tiny-btn" data-action="agents-delete" data-version-id="${id}"${busy ? ' disabled' : ''}>Delete</button>`}
              </span>
            </td>
          </tr>
        `;
      }).join('');
    }

    function renderAgents(doc) {
      currentAgents = doc || null;
      if (currentAgents && runnerSummary) {
        hostDetailSupportLoaded = true;
      }

      const status = doc?.status || 'missing';
      const updatedAt = doc?.updated_at ? formatTimestamp(doc.updated_at) : null;
      const size = Number(doc?.size_bytes);
      const text = agentsCurrentContent(doc);
      if (agentsMeta) {
        if (status === 'missing') {
          agentsMeta.textContent = 'No canonical AGENTS.md yet. Click the document body to create it.';
        } else {
          const metaParts = [];
          if (Number.isFinite(size)) metaParts.push(`${formatNumber(size)} bytes`);
          if (updatedAt) metaParts.push(`updated ${updatedAt}`);
          agentsMeta.textContent = metaParts.join(' · ');
        }
      }
      if (agentsPreview) {
        const placeholder = status === 'missing'
          ? 'No canonical AGENTS.md yet.\n\nClick anywhere in this box to create it.'
          : (text || ' ');
        agentsPreview.textContent = placeholder;
        agentsPreview.classList.toggle('is-empty', status === 'missing');
      }
      if (agentsEditorInline && !agentsEditing) {
        agentsEditorInline.value = text;
      }
      renderAgentsVersions(doc);
      syncAgentsEditorUI();
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
      if (host?.auth_outdated) {
        return { label: 'Outdated auth', tone: 'warn', rank: 1 };
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
        const autoUpdateLabel = hostAutoUpdateIndicator(host).label.toLowerCase();
        const enginesLabel = parseEngines(host.engines).join(' ');
        const haystacks = [host.fqdn, host.client_version, statusLabel, autoUpdateLabel, enginesLabel]
          .map((value) => (typeof value === 'string' ? value.toLowerCase() : ''));
        return haystacks.some(text => text.includes(hostFilterText));
      });
    }

    function hostAutoUpdateIndicator(host) {
      const label = typeof host?.auto_update_label === 'string' && host.auto_update_label.trim() !== ''
        ? host.auto_update_label.trim()
        : 'Auto-update status unavailable';
      const icon = typeof host?.auto_update_emoji === 'string' && host.auto_update_emoji.trim() !== ''
        ? host.auto_update_emoji.trim()
        : '⚠️';
      const rank = Number.isFinite(host?.auto_update_rank) ? Number(host.auto_update_rank) : 1;
      const state = typeof host?.auto_update_state === 'string' ? host.auto_update_state : 'unknown';
      const lastEventAt = typeof host?.auto_update_last_event_at === 'string' ? host.auto_update_last_event_at : null;
      const targetVersion = typeof host?.auto_update_target_version === 'string' ? host.auto_update_target_version : null;
      return { icon, label, rank, state, lastEventAt, targetVersion };
    }

    function hostAutoUpdateTone(host) {
      const state = hostAutoUpdateIndicator(host).state;
      if (state === 'enabled_current_checked' || state === 'enabled_update_succeeded') {
        return 'ok';
      }
      if (state === 'disabled_idle') {
        return 'neutral';
      }
      return 'warn';
    }

    function hostSortValue(host, key) {
      switch (key) {
        case 'host':
          return (host.fqdn || '').toLowerCase();
        case 'engines':
          return parseEngines(host.engines).join(',');
        case 'status':
          return hostListStatus(host).rank;
        case 'last_seen': {
          const ts = parseTimestamp(host.updated_at);
          return ts ? ts.getTime() : -Infinity;
        }
        case 'client':
          return (host.client_version || '').toLowerCase();
        case 'auto_updates':
          return hostAutoUpdateIndicator(host).rank;
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

    function setActiveHostDetailId(value) {
      const parsed = Number(value);
      const nextId = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
      const changed = nextId !== activeHostId;
      activeHostId = nextId;
      if (!changed) return;
      hostDetailLoadPromise = null;
      hostDetailSupportPromise = null;
      hostDetailLoadError = null;
      currentHostDetail = nextId
        ? (Array.isArray(currentHosts) ? currentHosts.find((entry) => entry.id === nextId) || null : null)
        : null;
      hostDetailLoaded = !!currentHostDetail;
      hostDetailSupportLoaded = !!(currentAgents && runnerSummary);
    }

    function getHostById(id) {
      const numericId = Number(id);
      if (!Number.isFinite(numericId) || numericId <= 0) return null;
      const targetId = Math.trunc(numericId);
      if (currentHostDetail && currentHostDetail.id === targetId) {
        return currentHostDetail;
      }
      return Array.isArray(currentHosts)
        ? currentHosts.find((entry) => entry.id === targetId) || null
        : null;
    }

    function upsertHostSnapshot(host) {
      const numericId = Number(host?.id || 0);
      if (!Number.isFinite(numericId) || numericId <= 0 || !host) return null;
      const normalized = { ...host, id: Math.trunc(numericId) };
      currentHostDetail = normalized;
      const nextHosts = Array.isArray(currentHosts) ? [...currentHosts] : [];
      const index = nextHosts.findIndex((entry) => entry.id === normalized.id);
      if (index === -1) {
        nextHosts.push(normalized);
      } else {
        nextHosts[index] = { ...nextHosts[index], ...normalized };
      }
      currentHosts = nextHosts;
      return normalized;
    }

    function applyHostDetailPayload(payload) {
      const detailHost = payload?.host && typeof payload.host === 'object' ? payload.host : null;
      if (detailHost) {
        upsertHostSnapshot(detailHost);
      }
      const overview = payload?.overview && typeof payload.overview === 'object' ? payload.overview : null;
      if (!overview) return;
      const previousOverview = currentOverview && typeof currentOverview === 'object' ? currentOverview : {};
      const previousVersions = previousOverview.versions && typeof previousOverview.versions === 'object'
        ? previousOverview.versions
        : {};
      const nextVersions = overview.versions && typeof overview.versions === 'object'
        ? { ...previousVersions, ...overview.versions }
        : previousVersions;
      currentOverview = {
        ...previousOverview,
        ...overview,
        versions: nextVersions,
      };
      latestVersions = {
        client: typeof nextVersions.client_version === 'string'
          ? nextVersions.client_version.trim().replace(/^v/i, '')
          : latestVersions.client,
        wrapper: typeof nextVersions.wrapper_version === 'string'
          ? nextVersions.wrapper_version.trim().replace(/^v/i, '')
          : latestVersions.wrapper,
        claude: typeof nextVersions.claude_version === 'string'
          ? nextVersions.claude_version.trim().replace(/^v/i, '')
          : latestVersions.claude,
      };
      if (typeof overview.reverse_dns_enabled !== 'undefined') {
        reverseDnsEnabled = !!overview.reverse_dns_enabled;
      }
      if (typeof overview.auto_update_enabled !== 'undefined') {
        autoUpdateEnabled = !!overview.auto_update_enabled;
      }
      if (typeof overview.inactivity_window_days !== 'undefined') {
        inactivityWindowDays = clampInactivityWindowDays(overview.inactivity_window_days);
      }
    }

    function applyHostDetailSupportPayload(payload) {
      if (!payload || typeof payload !== 'object') return;
      if (payload.agents && typeof payload.agents === 'object') {
        renderAgents(payload.agents);
      }
      if (payload.runner && typeof payload.runner === 'object') {
        runnerSummary = payload.runner;
      }
      hostDetailSupportLoaded = !!(currentAgents && runnerSummary);
    }

    async function waitForAdminWsReady(timeoutMs = 1200) {
      if (typeof window.__adminWsCanRequest === 'function' && window.__adminWsCanRequest()) {
        return true;
      }

      const timeoutValue = Number(timeoutMs);
      const waitMs = Number.isFinite(timeoutValue) && timeoutValue > 0 ? Math.round(timeoutValue) : 1200;
      return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          window.removeEventListener('admin-ws-status', onStatus);
          resolve(!!value);
        };
        const onStatus = (event) => {
          const status = String(event?.detail?.status || '');
          if (status === 'open') {
            finish(true);
          }
        };
        const timer = window.setTimeout(() => {
          finish(typeof window.__adminWsCanRequest === 'function' && window.__adminWsCanRequest());
        }, waitMs);
        window.addEventListener('admin-ws-status', onStatus);
      });
    }

    async function requestHostDetailSupportViaWebsocket(hostId) {
      const targetHostId = Number(hostId);
      if (!Number.isFinite(targetHostId) || targetHostId <= 0) {
        return null;
      }
      if (typeof window.__adminWsRequest !== 'function') {
        return null;
      }
      const ready = await waitForAdminWsReady();
      if (!ready) {
        return null;
      }
      const response = await window.__adminWsRequest('host-detail-support', {
        host_id: Math.trunc(targetHostId),
      }, { timeoutMs: 3000 });
      return response?.data && typeof response.data === 'object' ? response.data : null;
    }

    async function ensureHostDetailLoaded(force = false) {
      if (!isHostDetailView() || !activeHostId) return null;
      if (!force && hostDetailLoaded && currentHostDetail && currentHostDetail.id === activeHostId) {
        return currentHostDetail;
      }
      if (!force && hostDetailLoadPromise) return hostDetailLoadPromise;
      const requestHostId = activeHostId;
      hostDetailLoadError = null;
      hostDetailLoadPromise = api(`/admin/hosts/${requestHostId}/detail`)
        .then((response) => {
          if (requestHostId !== activeHostId) return null;
          applyHostDetailPayload(response?.data || {});
          hostDetailLoaded = true;
          hostDetailLoadError = null;
          return currentHostDetail;
        })
        .catch((err) => {
          if (requestHostId === activeHostId) {
            hostDetailLoadError = err;
          }
          throw err;
        })
        .finally(() => {
          if (requestHostId === activeHostId) {
            hostDetailLoadPromise = null;
          }
        });
      return hostDetailLoadPromise;
    }

    async function ensureHostDetailSupportLoaded(force = false) {
      if (!isHostDetailView() || !activeHostId) return;
      if (!force && hostDetailSupportPromise) return hostDetailSupportPromise;
      if (!force && (hostDetailSupportLoaded || (currentAgents && runnerSummary))) {
        hostDetailSupportLoaded = true;
        return;
      }
      const requestHostId = activeHostId;
      hostDetailSupportPromise = (async () => {
        let wsHydrated = false;
        try {
          const livePayload = await requestHostDetailSupportViaWebsocket(requestHostId);
          if (requestHostId === activeHostId && livePayload) {
            applyHostDetailSupportPayload(livePayload);
            wsHydrated = hostDetailSupportLoaded;
          }
        } catch (err) {
          console.warn('Host detail websocket support hydration unavailable', err);
        }

        if (!wsHydrated) {
          const [agentsResponse, runnerResponse] = await Promise.all([
            force || !currentAgents
              ? api('/admin/agents').catch((err) => {
                console.warn('Host detail agents metadata unavailable', err);
                return null;
              })
              : Promise.resolve(null),
            force || !runnerSummary
              ? api('/admin/runner').catch((err) => {
                console.warn('Host detail runner metadata unavailable', err);
                return null;
              })
              : Promise.resolve(null),
          ]);
          if (requestHostId === activeHostId) {
            applyHostDetailSupportPayload({
              agents: agentsResponse?.data || null,
              runner: runnerResponse?.data || null,
            });
          }
        }

        if (requestHostId === activeHostId) {
          renderActiveHostDetail();
        }
      })().finally(() => {
        if (requestHostId === activeHostId) {
          hostDetailSupportPromise = null;
        }
      });
      return hostDetailSupportPromise;
    }

    async function reloadHostContextAfterMutation(options = {}) {
      const allowMissing = !!options.allowMissing;
      if (isHostDetailView() && activeHostId) {
        try {
          await ensureHostDetailLoaded(true);
          renderActiveHostDetail();
          return;
        } catch (err) {
          if (allowMissing) {
            window.location.assign('/admin/hosts');
            return;
          }
          throw err;
        }
      }
      await loadAll();
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
        return 'Global (fleet - missing)';
      }
      const mode = typeof doc.mode === 'string' ? doc.mode : 'latest';
      const latestId = normalizeAgentsVersionId(doc.latest_id);
      const activeId = normalizeAgentsVersionId(doc.active_id);
      if (mode === 'latest') {
        return `Global (fleet - latest${latestId ? ` v${latestId}` : ''})`;
      }
      return `Global (fleet - pinned${activeId ? ` v${activeId}` : ''})`;
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
        if (!version?.is_served && version?.is_active) tags.push('pinned');
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
	      const installerMode = installerModeFromEngines(host?.engines);
	      const detailEngines = parseEngines(host?.engines);
	      const hasCodex = detailEngines.includes('codex');
	      const hasClaude = detailEngines.includes('claude');
	      const addEngineButtons = [];
	      if (hasCodex && !hasClaude) {
	        addEngineButtons.push('<button class="ghost secondary" data-action="add-claude">Add Claude</button>');
	      }
	      if (hasClaude && !hasCodex) {
	        addEngineButtons.push('<button class="ghost secondary" data-action="add-codex">Add Codex</button>');
	      }
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
	      const claudeVersionBlock = hasClaude ? `
	          <div class="host-inline-block">
	            <div class="muted" style="font-weight:600; margin-bottom:6px;">Claude Code version</div>
	            <div class="inline-group" style="gap:10px; align-items:flex-end;">
	              <div class="field" style="min-width:240px;">
	                <label for="hostClaudeVersionSelect">Version</label>
	                <select id="hostClaudeVersionSelect">
	                  <option value="global">Global (fleet)</option>
	                </select>
	              </div>
	            </div>
	            <div class="muted-note" style="margin-top:6px;">
	              “Global” follows the fleet setting; picking a version pins this host and forces update on the next cron run.
	              <span id="hostClaudeVersionSaveState" class="muted" style="margin-left:10px;"></span>
	            </div>
	          </div>
	      ` : '';
	      const claudeModelBlock = hasClaude ? `
	            <div class="field" style="min-width:240px;">
	              <label for="hostClaudeModelOverrideSelect">Claude model</label>
	              <select id="hostClaudeModelOverrideSelect">
	                <option value="">Standard (global)</option>
	                <option value="claude-opus-4-6">claude-opus-4-6</option>
	                <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
	                <option value="claude-haiku-4-5">claude-haiku-4-5</option>
	              </select>
	            </div>
	      ` : '';

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
	          ${claudeVersionBlock}
	        </div>
	        <div class="host-model-overrides" style="margin-top:12px;">
	          <div class="muted" style="font-weight:600; margin-bottom:6px;">Model &amp; reasoning overrides</div>
	          <div class="inline-group" style="gap:10px; align-items:flex-end;">
            <div class="field" style="min-width:240px;">
              <label for="hostModelOverrideSelect">Model</label>
              <select id="hostModelOverrideSelect">
                <option value="">Standard (global)</option>
                <option value="gpt-5.5">gpt-5.5</option>
                <option value="gpt-5.4">gpt-5.4</option>
                <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                <option value="gpt-5.3-codex">gpt-5.3-codex</option>
                <option value="gpt-5.2">gpt-5.2</option>
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
	            ${claudeModelBlock}
	          </div>
	          <div class="muted-note" style="margin-top:6px;">
	            Overrides affect the baked wrappers for this host. “Standard” = use fleet-wide config.
	            <span id="hostModelOverrideSaveState" class="muted" style="margin-left:10px;"></span>
	          </div>
        </div>
        <div class="host-action-buttons">
          <button class="ghost secondary" data-action="install">${escapeHtml(installerActionLabel(installerMode))}</button>
          ${addEngineButtons.join('')}
          <button class="ghost" data-action="clear">Clear auth</button>
          <button class="danger" data-action="remove">Remove</button>
        </div>
      `;
    }

    async function bindHostDetailActions(host) {
      if (!hostDetailActions) return;
      hostDetailActions.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          const action = btn.getAttribute('data-action');
          if (action === 'install') {
            regenerateInstaller(host.fqdn, host.id);
          } else if (action === 'add-claude') {
            regenerateInstaller(host.fqdn, host.id, hostInstallerEngineSet(host, 'claude'));
          } else if (action === 'add-codex') {
            regenerateInstaller(host.fqdn, host.id, hostInstallerEngineSet(host, 'codex'));
          } else if (action === 'clear') {
            if (!await showConfirmModal('Clear auth', `Clear auth for ${host.fqdn}?`, { action: 'Clear' })) return;
            confirmClear(host.id);
          } else if (action === 'remove') {
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
            await reloadHostContextAfterMutation();
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
            await reloadHostContextAfterMutation();
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
            await reloadHostContextAfterMutation();
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

	      const claudeSelect = hostDetailActions.querySelector('#hostClaudeVersionSelect');
	      const claudeSaveState = hostDetailActions.querySelector('#hostClaudeVersionSaveState');
	      if (claudeSelect) {
	        const override = normalizeClaudeVersion(host.claude_client_version_override || '');
	        const target = normalizeClaudeVersion(currentOverview?.versions?.claude_version ?? '');
	        const hostReported = normalizeClaudeVersion(host.claude_client_version || '');
	        const orderedVersions = Array.from(new Set([
	          target,
	          hostReported && hostReported !== target ? hostReported : '',
	          override && override !== target && override !== hostReported ? override : '',
	        ].filter(Boolean)));

	        claudeSelect.innerHTML = '';
	        const globalLabel = target ? `Global (fleet · ${target})` : 'Global (fleet)';
	        const globalOpt = document.createElement('option');
	        globalOpt.value = 'global';
	        globalOpt.textContent = globalLabel;
	        claudeSelect.appendChild(globalOpt);
	        for (const version of orderedVersions) {
	          const suffix = [];
	          if (target && version === target) suffix.push('fleet');
	          if (hostReported && version === hostReported) suffix.push('host');
	          if (override && version === override) suffix.push('pinned');
	          const el = document.createElement('option');
	          el.value = version;
	          el.textContent = suffix.length ? `${version} (${suffix.join(', ')})` : version;
	          claudeSelect.appendChild(el);
	        }
	        claudeSelect.value = override || 'global';

	        const saveClaudeOverride = async () => {
	          const selection = claudeSelect ? String(claudeSelect.value || 'global') : 'global';
	          if (claudeSaveState) claudeSaveState.textContent = 'Saving…';
	          if (claudeSelect) claudeSelect.disabled = true;
	          try {
	            await api(`/admin/hosts/${host.id}/claude-version`, {
	              method: 'POST',
	              json: { selection },
	            });
	            if (claudeSaveState) claudeSaveState.textContent = 'Saved';
	            await reloadHostContextAfterMutation();
	          } catch (err) {
	            if (claudeSaveState) claudeSaveState.textContent = 'Save failed';
	            console.error('save host claude version override failed', err);
	          } finally {
	            if (claudeSelect) claudeSelect.disabled = false;
	            if (claudeSaveState) {
	              window.setTimeout(() => {
	                if (claudeSaveState.textContent === 'Saved') claudeSaveState.textContent = '';
	              }, 1500);
	            }
	          }
	        };

	        claudeSelect.addEventListener('change', async (ev) => {
	          ev.stopPropagation();
	          await saveClaudeOverride();
	        });
	      }

	      const modelSelect = hostDetailActions.querySelector('#hostModelOverrideSelect');
	      const effortSelect = hostDetailActions.querySelector('#hostReasoningEffortSelect');
	      const claudeModelSelect = hostDetailActions.querySelector('#hostClaudeModelOverrideSelect');
	      const saveState = hostDetailActions.querySelector('#hostModelOverrideSaveState');
	      if (modelSelect) {
	        modelSelect.value = (host.model_override || '').trim();
	      }
	      if (claudeModelSelect) {
	        claudeModelSelect.value = (host.claude_model_override || '').trim();
	      }
      const initialEffort = (host.reasoning_effort_override || '').trim();
      rebuildHostReasoningOptions(effortSelect, modelSelect ? modelSelect.value : '', initialEffort);
      const saveOverrides = async () => {
        const modelVal = modelSelect ? String(modelSelect.value || '') : '';
        const effortVal = effortSelect ? String(effortSelect.value || '') : '';
        if (saveState) saveState.textContent = 'Saving…';
	        if (modelSelect) modelSelect.disabled = true;
	        if (effortSelect) effortSelect.disabled = true;
	        if (claudeModelSelect) claudeModelSelect.disabled = true;
	        try {
            const payload = {
              model_override: modelVal === '' ? null : modelVal,
              reasoning_effort_override: effortVal === '' ? null : effortVal,
            };
            if (claudeModelSelect) {
              payload.claude_model_override = claudeModelSelect.value ? String(claudeModelSelect.value) : null;
            }
	          await api(`/admin/hosts/${host.id}/model`, {
	            method: 'POST',
	            json: payload,
	          });
          if (saveState) saveState.textContent = 'Saved';
          await reloadHostContextAfterMutation();
        } catch (err) {
          if (saveState) saveState.textContent = 'Save failed';
          console.error('save host model overrides failed', err);
        } finally {
	          if (modelSelect) modelSelect.disabled = false;
	          if (effortSelect) effortSelect.disabled = false;
	          if (claudeModelSelect) claudeModelSelect.disabled = false;
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
	      if (claudeModelSelect) {
	        claudeModelSelect.addEventListener('change', async (ev) => {
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
      const autoUpdate = hostAutoUpdateIndicator(host);
      const hostEngines = parseEngines(host.engines);
	      const claudeVersionTag = host.claude_client_version
	        ? renderVersionTag(host.claude_client_version, latestVersions.claude)
	        : null;
      let versionValue = `${clientTag} ${wrapperTag}`;
      let versionMeta = 'Client \u00b7 Wrapper';
      if (claudeVersionTag) {
        versionValue += ` ${claudeVersionTag}`;
        versionMeta = 'Codex \u00b7 Wrapper \u00b7 Claude';
      }
      const summaryItems = [
        {
          label: 'Health',
          value: health.label,
          meta: host.authed ? 'Canonical auth stored' : 'Not provisioned yet',
        },
        {
          label: 'Engines',
          value: renderEngineBadges(host.engines),
          meta: hostEngines.join(', '),
          raw: true,
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
          value: versionValue,
          meta: versionMeta,
          raw: true,
        },
        {
          label: 'Auto-updates',
          value: autoUpdate.label,
          meta: autoUpdate.lastEventAt ? `last signal ${formatRelative(autoUpdate.lastEventAt)}` : 'No cron signal yet',
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
      const autoUpdate = hostAutoUpdateIndicator(host);
      const autoUpdateTone = hostAutoUpdateTone(host);
      const apiCallsLabel = host.api_calls !== null && host.api_calls !== undefined
        ? ` (${formatNumber(host.api_calls)} api calls)`
        : '';
      const securityChip = isHostSecure(host)
        ? '<span class="chip ok">Secure</span>'
        : '<span class="chip warn">Insecure</span>';
      const primaryIp = host.ip4 ?? host.ip6 ?? null;
      const secondaryIp = host.ip4 && host.ip6 ? host.ip6 : null;
      const detailEngines = parseEngines(host.engines);
	      const claudeTag = host.claude_client_version ? renderVersionTag(host.claude_client_version, latestVersions.claude) : null;
      const rows = [
        {
          key: 'Status',
          value: `${renderStatusPill(host.status)} ${securityChip} ${insecureStatus}`,
          desc: 'Host entry state; suspended hosts cannot authenticate. Insecure hosts purge auth.json after each run.',
        },
        {
          key: 'Engines',
          value: renderEngineBadges(host.engines),
          desc: 'Which engines are installed on this host. Codex (CDX) and/or Claude (CLX).',
        },
        { key: 'Health', value: `<span class="chip ${health.tone === 'ok' ? 'ok' : 'warn'}">${health.label}</span>`, desc: healthDesc },
        { key: 'Last seen', value: `${formatRelativeWithTimestamp(host.updated_at)}${apiCallsLabel}`, desc: 'Timestamp of the most recent API call from this host.' },
        { key: 'Auth refresh', value: formatRelativeWithTimestamp(host.last_refresh), desc: 'When auth.json was last uploaded or fetched.' },
        { key: 'Last cron check', value: host.last_cron_check ? formatRelativeWithTimestamp(host.last_cron_check) : 'Never', desc: 'Last time the cron auto-update checked in.' },
        {
          key: 'Auto-updates',
          value: `<span class="chip ${autoUpdateTone}">${escapeHtml(autoUpdate.label)}</span>`,
          desc: autoUpdate.lastEventAt
            ? `Latest auto-update signal: ${formatRelativeWithTimestamp(autoUpdate.lastEventAt)}${autoUpdate.targetVersion ? ` · target ${autoUpdate.targetVersion}` : ''}.`
            : 'No recent auto-update signal recorded for this host.',
        },
        {
          key: 'IP binding',
          value: `
            <div class="kv-stack">
              <div class="kv-rowline">
                ${primaryIp ? `<code>${escapeHtml(primaryIp)}</code>` : 'Not yet bound'}
                <span class="chip ${host.allow_roaming_ips ? 'warn' : 'ok'}">${host.allow_roaming_ips ? 'Roaming enabled' : 'IP locked'}</span>
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
      const claudeModelOverride = (host.claude_model_override || '').trim();
      const modelRows = [
        `<div class=”kv-rowline”>
          <span class=”muted”>Codex model</span>
          ${modelOverride ? `<code>${escapeHtml(modelOverride)}</code>` : '<span class=”muted”>Standard (global)</span>'}
        </div>`,
        `<div class=”kv-rowline” style=”margin-top:4px;”>
          <span class=”muted”>Reasoning effort</span>
          ${reasoningOverride ? `<code>${escapeHtml(reasoningOverride)}</code>` : '<span class=”muted”>Standard (global)</span>'}
        </div>`,
      ];
      if (detailEngines.includes('claude')) {
        modelRows.push(`<div class=”kv-rowline” style=”margin-top:4px;”>
          <span class=”muted”>Claude model</span>
          ${claudeModelOverride ? `<code>${escapeHtml(claudeModelOverride)}</code>` : '<span class=”muted”>Standard (global)</span>'}
        </div>`);
      }
      if (claudeTag && detailEngines.includes('claude')) {
        modelRows.push(`<div class=”kv-rowline” style=”margin-top:4px;”>
          <span class=”muted”>Claude version</span>
          ${claudeTag}
        </div>`);
      }
      rows.push({
        key: 'Model overrides',
        value: `<div class=”kv-stack”>${modelRows.join('')}</div>`,
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
        pills.push(renderEngineBadges(host.engines));
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
      const host = getHostById(activeHostId);
      if (host) {
        renderHostDetail(host);
        return;
      }
      if (hostDetailLoadError) {
        if (hostDetailTitle) {
          hostDetailTitle.textContent = `Host #${activeHostId}`;
        }
        clearHostDetailContent();
        showHostDetailEmpty('Host load failed', hostDetailLoadError?.message || 'Unable to load host details.');
        return;
      }
      if (!hostDetailLoaded) {
        if (hostDetailTitle) {
          hostDetailTitle.textContent = `Host #${activeHostId}`;
        }
        clearHostDetailContent();
        showHostDetailEmpty('Loading host…', 'Fetching host details.');
        return;
      }
      if (hostDetailTitle) {
        hostDetailTitle.textContent = `Host #${activeHostId}`;
      }
      clearHostDetailContent();
      showHostDetailEmpty('Host not found', 'This host was deleted or is no longer visible.');
    }

    function openHostDetail(hostId) {
      const numericId = Number(hostId);
      if (!Number.isFinite(numericId) || numericId <= 0) return;
      window.location.assign(`/admin/hosts/${Math.trunc(numericId)}`);
    }

    function shouldIgnoreHostRowNavigation(target) {
      if (!(target instanceof Element)) return false;
      return !!target.closest('a, button, input, label, select, textarea, summary, [role="button"], [role="link"], [contenteditable="true"], .insecure-inline-toggle');
    }

    function isInsecureActive(host) {
      const state = insecureState(host);
      return state.enabledActive || state.graceActive;
    }

    function hostTableShowsInsecureColumn() {
      return hostStatusFilter !== 'secure';
    }

    function syncHostsTableColumns() {
      if (!hostsInsecureHeader) return;
      hostsInsecureHeader.hidden = !hostTableShowsInsecureColumn();
    }

    function createHostRow(host) {
      const tr = document.createElement('tr');
      const isSecure = isHostSecure(host);
      const showInsecureColumn = hostTableShowsInsecureColumn();
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
      const autoUpdate = hostAutoUpdateIndicator(host);
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
        <td data-label="Engines" class="engines-cell">${renderEngineBadges(host.engines)}</td>
        <td data-label="Status" class="status-cell">${statusChip}</td>
        <td data-label="Last Seen"><span class="host-secondary">${escapeHtml(lastSeenText)}</span></td>
        <td data-label="Codex">${renderVersionTag(host.client_version, latestVersions.client)}</td>
        <td data-label="Auto-updates" class="host-auto-updates-cell"><span class="host-auto-updates-indicator" title="${escapeHtml(autoUpdate.label)}" aria-label="${escapeHtml(autoUpdate.label)}">${autoUpdate.icon}</span></td>
        ${showInsecureColumn ? `<td class="actions-cell insecure-cell" data-label="Insecure Window">${insecureToggleCell}</td>` : ''}
      `;
      tr.addEventListener('click', (ev) => {
        if (shouldIgnoreHostRowNavigation(ev.target)) return;
        openHostDetail(host.id);
      });
      tr.addEventListener('keydown', (ev) => {
        if (shouldIgnoreHostRowNavigation(ev.target)) return;
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
      syncHostsTableColumns();
      const filtered = applyHostFilters(currentHosts);

      hostsTbody.innerHTML = '';
      const cols = hostTableShowsInsecureColumn() ? 7 : 6;
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
      if (activeHostId) {
        currentHostDetail = currentHosts.find((entry) => entry.id === activeHostId) || currentHostDetail;
        hostDetailLoaded = !!currentHostDetail || hostDetailLoaded;
      }
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
      if (hostSearchModal?.classList.contains('show')) {
        renderHostSearchResults(hostSearchInput?.value || '');
      }
    }

    function renderSkills(skills) {
      currentSkills = Array.isArray(skills) ? skills : [];
      if (!skillsTbody) return;
      if (currentSkills.length === 0) {
        skillsTbody.innerHTML = `<tr><td colspan="3" class="muted" style="padding: 20px 14px; text-align: center;">
          No skills yet — create your first one above.
        </td></tr>`;
        return;
      }

      skillsTbody.innerHTML = currentSkills.map((skill) => {
        const retired = skill.deleted_at ? ' <span class="muted" style="font-size:11px;">(retired)</span>' : '';
        const managed = skill.managed ? ' <span class="muted" style="font-size:11px;">(managed)</span>' : '';
        const managedDisabled = skill.managed ? 'disabled title="Managed by the Projects module"' : '';
        const tags = Array.isArray(skill.tags) && skill.tags.length > 0
          ? `<div class="skill-list-tags">${skill.tags.map(t => `<span class="skill-list-tag">${escapeHtml(String(t))}</span>`).join('')}</div>`
          : '';
        const desc = skill.description ? `<div class="skill-list-desc">${escapeHtml(skill.description)}</div>` : '';

        return `<tr>
          <td data-label="Slug"><code>${escapeHtml(skill.slug)}</code>${retired}${managed}</td>
          <td data-label="Skill">
            <div class="skill-list-card">
              <div class="skill-list-name">${escapeHtml(skill.display_name || skill.slug)}</div>
              ${desc}
              ${tags}
            </div>
          </td>
          <td data-label="Actions">
            <div class="table-actions">
              <button class="ghost tiny-btn skill-open" data-slug="${escapeHtml(skill.slug)}" ${managedDisabled}>Open</button>
              <button class="ghost tiny-btn danger skill-delete" data-slug="${escapeHtml(skill.slug)}" ${skill.deleted_at ? 'disabled' : managedDisabled}>Delete</button>
            </div>
          </td>
        </tr>`;
      }).join('');

      skillsTbody.querySelectorAll('.skill-open').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slug = btn.getAttribute('data-slug');
          openSkillDetail(slug);
        });
      });
      skillsTbody.querySelectorAll('.skill-delete').forEach((btn) => {
        btn.addEventListener('click', () => {
          const slug = btn.getAttribute('data-slug');
          deleteSkill(slug);
        });
      });
    }

    function isSkillDetailView() {
      return (document.body?.dataset?.viewMode || '').toLowerCase() === 'skill-detail';
    }

    function skillDetailPath(slug) {
      const normalized = String(slug || '').trim();
      return normalized ? `/admin/skills/${encodeURIComponent(normalized)}` : '/admin/skills/new';
    }

    function openSkillDetail(slug) {
      const target = skillDetailPath(slug);
      if (window.__adminDirtyModules?.size > 0) {
        const names = Array.from(window.__adminDirtyModules).join(', ');
        if (!window.confirm(`You have unsaved changes in ${names}. Leave without saving?`)) return;
        window.__adminDirtyModules.clear();
      }
      navigateAdminShortcut(target);
    }

    function setSkillDirty(isDirty) {
      if (!window.__adminDirtyModules) return;
      if (isDirty) {
        window.__adminDirtyModules.add('skill');
      } else {
        window.__adminDirtyModules.delete('skill');
      }
    }

    function resetSkillConversation() {
      skillConversationMessages = [];
      renderSkillConversation();
    }

    function setSkillDetailMode(mode, slugLabel = '') {
      const isEdit = mode === 'edit';
      skillDetailMode = isEdit ? 'edit' : 'new';
      if (!isEdit) {
        skillEditingSlug = '';
      }
      if (skillWorkspaceTitle) {
        skillWorkspaceTitle.textContent = isEdit ? `Edit ${slugLabel || 'skill'}` : 'New skill';
      }
      if (skillWorkspaceSubtitle) {
        skillWorkspaceSubtitle.innerHTML = isEdit
          ? `Talk with AI about <code>${escapeHtml(slugLabel || 'this skill')}</code>, then save the updated canonical draft.`
          : 'Describe the skill, then let AI fill the draft before saving it into <code>skill://&lt;slug&gt;</code>.';
      }
      if (skillSave) {
        skillSave.textContent = isEdit ? 'Save changes' : 'Save';
      }
      if (skillDelete) {
        skillDelete.hidden = !isEdit;
      }
      if (skillSlug) {
        skillSlug.readOnly = isEdit;
        skillSlug.setAttribute('aria-readonly', isEdit ? 'true' : 'false');
      }
      if (skillSlugNote) {
        skillSlugNote.innerHTML = isEdit
          ? 'Slug is locked for existing skills so hosts keep the same <code>skill://&lt;slug&gt;</code> address.'
          : 'Set the canonical slug here. AI will fill the rest unless you explicitly unlock a field.';
      }
      applySkillFieldLocks();
    }

    function activateSkillCreationMode(mode) {
      skillCreationMode = mode;
      if (skillModeSplash) skillModeSplash.hidden = true;
      if (skillDetailLayout) skillDetailLayout.hidden = false;

      const chatSection = skillDetailLayout?.querySelector('.skill-chat-section');
      if (mode === 'manual') {
        if (chatSection) chatSection.hidden = true;
        skillFieldEditButtons.forEach(b => skillUnlockedFields.add(b.getAttribute('data-skill-unlock') || ''));
        applySkillFieldLocks();
      } else {
        if (chatSection) chatSection.hidden = false;
        skillUnlockedFields.clear();
        applySkillFieldLocks();
        skillAssistInput?.focus();
      }

      if (skillModeSwitchBtn) skillModeSwitchBtn.hidden = false;
    }

    function setSkillBusy(isBusy) {
      skillAssistBusy = !!isBusy;
      if (skillAssistSend) skillAssistSend.disabled = skillAssistBusy;
      if (skillSave) skillSave.disabled = skillAssistBusy;
      if (skillDelete) skillDelete.disabled = skillAssistBusy || skillDetailMode !== 'edit';
      if (skillAssistInput) skillAssistInput.disabled = skillAssistBusy;
      skillFieldEditButtons.forEach((btn) => {
        btn.disabled = skillAssistBusy;
      });
    }

    function autoResizeSkillInput() {
      if (!skillAssistInput) return;
      skillAssistInput.style.height = 'auto';
      skillAssistInput.style.height = Math.min(skillAssistInput.scrollHeight, 200) + 'px';
    }

    function showSkillTypingIndicator(show) {
      if (!skillConversation) return;
      const existing = skillConversation.querySelector('.skill-typing-indicator-wrap');
      if (show && !existing) {
        const wrap = document.createElement('article');
        wrap.className = 'skill-message skill-message-assistant skill-typing-indicator-wrap';
        wrap.innerHTML = `<div class="skill-message-label">AI</div><div class="skill-typing-indicator"><span></span><span></span><span></span></div>`;
        skillConversation.appendChild(wrap);
        skillConversation.scrollTop = skillConversation.scrollHeight;
        if (skillConversationEmpty) skillConversationEmpty.hidden = true;
      } else if (!show && existing) {
        existing.remove();
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
      const editable = skillUnlockedFields.has('tags');
      skillTagsList.innerHTML = skillTags.map((tag, idx) => `
        <span class="skill-tag">
          ${escapeHtml(tag)}
          ${editable ? `<button type="button" aria-label="Remove tag" data-tag-index="${idx}">✕</button>` : ''}
        </span>
      `).join('');
      if (!editable) return;
      skillTagsList.querySelectorAll('button[data-tag-index]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const index = Number(btn.getAttribute('data-tag-index'));
          removeSkillTag(Number.isFinite(index) ? index : -1);
          setSkillDirty(true);
        });
      });
    }

    function commitSkillTagInput() {
      if (!skillTagsInput) return;
      const value = skillTagsInput.value.trim();
      if (!value) return;
      addSkillTag(value);
      skillTagsInput.value = '';
      setSkillDirty(true);
    }

    function applySkillFieldLocks() {
      const readonlyFields = {
        display_name: skillNameInput,
        description: skillDescriptionInput,
        what: skillWhatInput,
        when: skillWhenInput,
        steps: skillStepsInput,
      };
      Object.entries(readonlyFields).forEach(([field, input]) => {
        if (!input) return;
        const unlocked = skillUnlockedFields.has(field);
        input.readOnly = !unlocked;
        input.setAttribute('aria-readonly', unlocked ? 'false' : 'true');
        input.closest('.skill-managed-field')?.classList.toggle('is-locked', !unlocked);
      });
      if (skillTagsInput) {
        const tagsUnlocked = skillUnlockedFields.has('tags');
        skillTagsInput.disabled = !tagsUnlocked;
        skillTagsInput.closest('.skill-managed-field')?.classList.toggle('is-locked', !tagsUnlocked);
      }
      skillFieldEditButtons.forEach((btn) => {
        const field = btn.getAttribute('data-skill-unlock') || '';
        const unlocked = skillUnlockedFields.has(field);
        btn.textContent = unlocked ? 'Editing' : 'Edit';
        btn.setAttribute('aria-pressed', unlocked ? 'true' : 'false');
      });
      renderSkillTags();
    }

    function unlockSkillField(field) {
      if (!field) return;
      skillUnlockedFields.add(field);
      applySkillFieldLocks();
      const focusMap = {
        display_name: skillNameInput,
        description: skillDescriptionInput,
        tags: skillTagsInput,
        what: skillWhatInput,
        when: skillWhenInput,
        steps: skillStepsInput,
      };
      focusMap[field]?.focus();
    }

    function renderSkillChangedFields() {
      if (!skillChangedFields) return;
      if (!Array.isArray(skillChangedFieldNames) || skillChangedFieldNames.length === 0) {
        if (skillChangedFieldsWrap) skillChangedFieldsWrap.hidden = true;
        skillChangedFields.innerHTML = '';
        return;
      }
      if (skillChangedFieldsWrap) skillChangedFieldsWrap.hidden = false;
      skillChangedFields.innerHTML = skillChangedFieldNames.map((field) => `<span class="pill-quiet">Updated ${escapeHtml(field.replace(/_/g, ' '))}</span>`).join('');
    }

    function renderSkillConversation() {
      if (!skillConversation || !skillConversationEmpty) return;
      if (!Array.isArray(skillConversationMessages) || skillConversationMessages.length === 0) {
        skillConversation.innerHTML = '';
        skillConversationEmpty.hidden = false;
        return;
      }
      skillConversationEmpty.hidden = true;
      skillConversation.innerHTML = skillConversationMessages.map((message) => {
        const role = String(message.role || '').toLowerCase() === 'assistant' ? 'assistant' : 'user';
        const label = role === 'assistant' ? 'AI' : 'You';
        return `
          <article class="skill-message skill-message-${role}">
            <div class="skill-message-label">${label}</div>
            <div class="skill-message-body">${escapeHtml(String(message.content || '')).replace(/\n/g, '<br>')}</div>
          </article>
        `;
      }).join('');
      skillConversation.scrollTop = skillConversation.scrollHeight;
    }

    function resetSkillWorkspaceEmptyState() {
      if (skillDetailEmptyState) skillDetailEmptyState.hidden = true;
      if (skillDetailLayout) skillDetailLayout.hidden = false;
    }

    function showSkillWorkspaceEmpty(title, body) {
      if (skillDetailEmptyState) skillDetailEmptyState.hidden = false;
      if (skillDetailLayout) skillDetailLayout.hidden = true;
      if (skillDetailEmptyTitle) skillDetailEmptyTitle.textContent = title || 'Skill unavailable';
      if (skillDetailEmptyBody) skillDetailEmptyBody.textContent = body || 'Unable to load this skill.';
    }

    function resetSkillWorkspaceForm() {
      if (skillSlug) skillSlug.value = '';
      if (skillNameInput) skillNameInput.value = '';
      if (skillDescriptionInput) skillDescriptionInput.value = '';
      if (skillWhatInput) skillWhatInput.value = '';
      if (skillWhenInput) skillWhenInput.value = '';
      if (skillStepsInput) skillStepsInput.value = '';
      if (skillTagsInput) skillTagsInput.value = '';
      if (skillAssistInput) skillAssistInput.value = '';
      if (skillStatus) skillStatus.textContent = '';
      if (skillAssistStatus) skillAssistStatus.textContent = '';
      skillUnlockedFields = new Set();
      skillChangedFieldNames = [];
      setSkillTags([]);
      setSkillBadges(null);
      renderSkillChangedFields();
      resetSkillConversation();
      applySkillFieldLocks();
      setSkillDirty(false);
    }

    function currentSkillDraftFromFields() {
      return {
        slug: (skillSlug?.value || '').trim(),
        display_name: (skillNameInput?.value || '').trim(),
        description: (skillDescriptionInput?.value || '').trim(),
        tags: Array.isArray(skillTags) ? [...skillTags] : [],
        what: normalizeSkillSection(skillWhatInput?.value),
        when: normalizeSkillSection(skillWhenInput?.value),
        steps: normalizeSkillSection(skillStepsInput?.value),
      };
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

    function applySkillDraft(draft, options = {}) {
      if (!draft || typeof draft !== 'object') return;
      const changedFields = Array.isArray(options.changedFields) ? options.changedFields : [];
      if (skillSlug && typeof draft.slug === 'string' && (skillDetailMode !== 'edit' || !skillEditingSlug)) {
        skillSlug.value = draft.slug.trim();
      }
      if (skillNameInput && typeof draft.display_name === 'string') {
        skillNameInput.value = draft.display_name.trim();
      }
      if (skillDescriptionInput && typeof draft.description === 'string') {
        skillDescriptionInput.value = draft.description.trim();
      }
      if (skillWhatInput && typeof draft.what === 'string') skillWhatInput.value = draft.what.trim();
      if (skillWhenInput && typeof draft.when === 'string') skillWhenInput.value = draft.when.trim();
      if (skillStepsInput && typeof draft.steps === 'string') skillStepsInput.value = draft.steps.trim();
      setSkillTags(Array.isArray(draft.tags) ? draft.tags : []);
      skillChangedFieldNames = changedFields.filter((field) => field !== 'slug');
      renderSkillChangedFields();
      setSkillBadges(options.meta || null);
      if (options.markDirty !== false) {
        setSkillDirty(true);
      }
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
          if (!recordId || !await showConfirmModal('Delete memory', `Delete ${label}? This cannot be undone.`, { action: 'Delete' })) return;
          try {
            btn.disabled = true;
            await api(`/admin/mcp/memories/${encodeURIComponent(recordId)}`, { method: 'DELETE' });
            await loadMemories();
          } catch (err) {
            toast(err.message || 'Delete failed', 'error');
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
      const rows = [
        { label: '5-hour runway', data: normalPrimary, windowKey: 'normal:primary' },
        { label: 'Weekly runway', data: normalSecondary, windowKey: 'normal:secondary' },
      ];
      chatgptUsageCard.innerHTML = `
        <header class="usage-card-head">
          <h2>ChatGPT</h2>
          <span class="usage-plan-pill">${escapeHtml(plan)}</span>
        </header>
        ${status !== 'ok' ? `<div class="usage-error">Usage unavailable: ${snapshot.error ?? 'Unknown error'}</div>` : ''}
        <div class="usage-lanes">
          ${rows.map((row) => renderUsageLane(row.label, row.data, row.windowKey)).join('')}
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
      'dashboard-charts',
      'settings-general',
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
      'admin.insecure.',
    ];
    const DASHBOARD_CHART_LIVE_ACTIONS = new Set([
      'token.usage',
      'chatgpt.usage',
    ]);
    const DASHBOARD_CHART_LIVE_PREFIXES = [];
    const SETTINGS_GENERAL_LIVE_ACTIONS = new Set([
      'admin.api.state',
      'admin.openai_api.state',
      'admin.claude_api.state',
      'admin.cdx_silent',
      'admin.reverse_dns',
      'admin.insecure_approval',
      'admin.auto_update',
      'admin.codex_version',
      'admin.quota_mode',
      'admin.prune_policy',
    ]);
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

      if (DASHBOARD_CHART_LIVE_ACTIONS.has(normalized)
        || DASHBOARD_CHART_LIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
        domains.add('dashboard-charts');
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
      const needDashboardCharts = requested.has('dashboard-charts');
      const needSkills = requested.has('skills');
      const needAgents = requested.has('agents');
      const needMemories = requested.has('memories');
      const needSettingsGeneral = requested.has('settings-general');

      let overviewResponse = null;
      let hostsResponse = null;
      let hostDetailResponse = null;
      let runnerResponse = null;
      let skillsResponse = null;
      let agentsResponse = null;
      const requests = [];
      const useHostDetailRefresh = isHostDetailView() && Number.isFinite(activeHostId) && activeHostId > 0 && (needHosts || needOverview);

      if (useHostDetailRefresh) {
        requests.push(api(`/admin/hosts/${activeHostId}/detail`)
          .then((res) => { hostDetailResponse = res; })
          .catch((err) => console.warn('Live host detail refresh failed', err)));
      }

      if (needOverview) {
        if (!useHostDetailRefresh) {
          requests.push(api('/admin/overview')
            .then((res) => { overviewResponse = res; })
            .catch((err) => console.warn('Live overview update failed', err)));
        }
      }
      if (needHosts && !useHostDetailRefresh) {
        requests.push(api('/admin/hosts')
          .then((res) => { hostsResponse = res; })
          .catch((err) => console.warn('Live host refresh failed', err)));
      }
      if (needRunner) {
        requests.push(api('/admin/runner')
          .then((res) => { runnerResponse = res; })
          .catch((err) => console.warn('Runner status unavailable', err)));
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

      if (hostDetailResponse) {
        applyHostDetailPayload(hostDetailResponse?.data || {});
        renderActiveHostDetail();
      }

      if (overviewResponse) {
        currentOverview = overviewResponse?.data || {};
        setMtls(currentOverview.mtls);
        if (typeof currentOverview.inactivity_window_days !== 'undefined') {
          inactivityWindowDays = clampInactivityWindowDays(currentOverview.inactivity_window_days);
          renderInactivityWindowDays();
        }
        if (typeof currentOverview.log_retention_enabled !== 'undefined') {
          logRetentionEnabled = !!currentOverview.log_retention_enabled;
        }
        if (typeof currentOverview.log_retention_days_logs !== 'undefined') {
          logRetentionDaysLogs = clampRetentionDays(currentOverview.log_retention_days_logs);
        }
        if (typeof currentOverview.log_retention_days_mcp !== 'undefined') {
          logRetentionDaysMcp = clampRetentionDays(currentOverview.log_retention_days_mcp);
        }
        if (typeof currentOverview.log_retention_days_events !== 'undefined') {
          logRetentionDaysEvents = clampRetentionDays(currentOverview.log_retention_days_events);
        }
        if (typeof currentOverview.log_retention_days_graph_stats !== 'undefined') {
          logRetentionDaysGraphStats = clampRetentionDays(currentOverview.log_retention_days_graph_stats);
        }
        renderLogRetention();
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
        if (currentOverview.scaling != null) {
          scalingData = currentOverview.scaling;
          renderScaling();
        }
      }

      const runnerInfo = runnerResponse?.data || runnerSummary || null;
      if (runnerResponse?.data) {
        runnerSummary = runnerResponse.data;
        if (currentAgents) {
          hostDetailSupportLoaded = true;
        }
        if (isHostDetailView()) {
          renderActiveHostDetail();
        }
      }

      if (needSettingsGeneral) {
        await loadApiState();
        if (typeof window.__loadOpenaiApiState === 'function') window.__loadOpenaiApiState();
      }

      if (needOverview && currentOverview) {
        renderQuotaMode();
        renderStats(currentOverview, runnerInfo, currentHosts);
        renderDashboardTrends(currentOverview);
        evaluateSeedRequirement(currentOverview, currentHosts);
      }

      if (needSettingsGeneral && currentOverview) {
        await loadCodexVersionControl();
        await loadClaudeVersion();
      }

      if (needSkills && skillsResponse) {
        renderSkills(skillsResponse?.data?.skills || []);
      }
      if (needAgents && agentsResponse) {
        renderAgents(agentsResponse?.data || { status: 'missing' });
        if (isHostDetailView()) {
          renderActiveHostDetail();
        }
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
          const windowRaw = raw.includes(':') ? raw.split(':', 2)[1] : raw;
          const windowKey = windowRaw === 'secondary' ? 'secondary' : 'primary';
          openUsageHistory('normal', windowKey);
        };
      });
    }

    function showUsageHistoryModal(show) {
      if (!usageHistoryModal) return;
      if (show) {
        usageHistoryModal.classList.add('show');
        setInertBehindModal(usageHistoryModal, true);
      } else {
        usageHistoryModal.classList.remove('show');
        setInertBehindModal(usageHistoryModal, false);
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
      const key = windowKey === 'secondary' ? 'secondary_used_percent' : 'primary_used_percent';
      const series = [];
      (points || []).forEach((p) => {
        const ts = parseTimestamp(p?.fetched_at);
        const val = Number(p?.[key]);
        if (!ts || Number.isNaN(val)) return;
        const clamped = Math.max(0, Math.min(100, val));
        series.push({ x: ts.getTime(), y: clamped, raw: val, iso: p.fetched_at });
      });
      series.sort((a, b) => a.x - b.x);
      return series;
    }

    function renderUsageHistoryChart(series, laneKey, windowKey) {
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
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${windowKey === 'secondary' ? 'Weekly' : '5-hour'} quota history">
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
      const lane = 'normal';
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
      if (quotaStatusBadge) {
        const pct = quotaLimitPercent != null ? quotaLimitPercent : 100;
        quotaStatusBadge.textContent = quotaHardFail ? `Deny at ${pct}%` : `Warn at ${pct}%`;
        quotaStatusBadge.style.color = quotaHardFail ? 'var(--danger)' : 'var(--muted)';
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

    // ── Usage Scaling ──

    const SCALING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
    function renderBinarySetting({
      toggle = null,
      label = null,
      badge = null,
      enabled = false,
      labelOn = 'Enabled',
      labelOff = 'Disabled',
      badgeOn = labelOn,
      badgeOff = labelOff,
      badgeOnColor = 'var(--success)',
      badgeOffColor = 'var(--muted)',
    } = {}) {
      if (toggle) toggle.checked = !!enabled;
      if (label) label.textContent = enabled ? labelOn : labelOff;
      if (badge) {
        badge.textContent = enabled ? badgeOn : badgeOff;
        badge.style.color = enabled ? badgeOnColor : badgeOffColor;
      }
    }

    const DEFAULT_SCALING_TIERS = [
      { projected_percent: 80, reasoning_effort: 'high', model: 'gpt-5.4' },
      { projected_percent: 85, reasoning_effort: 'high', model: 'gpt-5.4-mini' },
      { projected_percent: 92, reasoning_effort: 'high', model: 'gpt-5.3-codex' },
      { projected_percent: 100, reasoning_effort: 'medium', model: 'gpt-5.3-codex' },
    ];

    function defaultScalingTier(index = 0) {
      const preset = DEFAULT_SCALING_TIERS[index] || {
        projected_percent: 120 + (Math.max(0, index - DEFAULT_SCALING_TIERS.length + 1) * 10),
        reasoning_effort: 'medium',
        model: 'gpt-5.3-codex',
      };
      return { ...preset };
    }

    function defaultScalingTiers() {
      return DEFAULT_SCALING_TIERS.map((_, index) => defaultScalingTier(index));
    }

    function cloneScalingDataState() {
      return scalingData ? JSON.parse(JSON.stringify(scalingData)) : null;
    }

    function ensureScalingRulesState(seedTier = false) {
      if (!scalingData) scalingData = { enabled: false, rules: null };
      if (!scalingData.rules) {
        scalingData.rules = {
          enabled: !!scalingData.enabled,
          tiers: [],
          vip_exempt: true,
          host_override_wins: true,
        };
      }
      if (!Array.isArray(scalingData.rules.tiers)) {
        scalingData.rules.tiers = [];
      }
      if (seedTier && scalingData.rules.tiers.length === 0) {
        scalingData.rules.tiers = defaultScalingTiers();
      }
      if (typeof scalingData.rules.vip_exempt !== 'boolean') {
        scalingData.rules.vip_exempt = true;
      }
      if (typeof scalingData.rules.host_override_wins !== 'boolean') {
        scalingData.rules.host_override_wins = true;
      }
      scalingData.rules.enabled = !!scalingData.enabled;
      return scalingData.rules;
    }

    const SCALING_MODELS = [
      { value: '', label: '(no change)' },
      { value: 'gpt-5.5', label: 'gpt-5.5' },
      { value: 'gpt-5.4', label: 'gpt-5.4' },
      { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
      { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
      { value: 'gpt-5.2', label: 'gpt-5.2' },
    ];

    function renderScaling() {
      if (!scalingToggle) return;
      const enabled = !!(scalingData?.enabled ?? scalingData?.rules?.enabled);
      if (enabled) ensureScalingRulesState(false);
      renderBinarySetting({
        toggle: scalingToggle,
        label: scalingLabel,
        badge: scalingBadge,
        enabled,
      });
      if (scalingBody) scalingBody.style.display = enabled ? '' : 'none';
      renderScalingStatus();
      renderScalingTiers();
      if (scalingVipExempt) scalingVipExempt.checked = scalingData?.rules?.vip_exempt ?? true;
      if (scalingHostOverrideWins) scalingHostOverrideWins.checked = scalingData?.rules?.host_override_wins ?? true;
    }

    function renderScalingStatus() {
      if (!scalingStatus) return;
      if (!(scalingData?.enabled ?? false)) {
        scalingStatus.innerHTML = '<p class="muted">Usage scaling is off.</p>';
        return;
      }
      const tiers = Array.isArray(scalingData?.rules?.tiers) ? scalingData.rules.tiers : [];
      if (tiers.length === 0) {
        scalingStatus.innerHTML = '<p class="muted">Add the scaling ladder that should kick in as weekly pressure rises.</p>';
        return;
      }
      const active = scalingData?.active_state;
      const normal = scalingData?.normal;
      if (!active && !normal) {
        scalingStatus.innerHTML = '<p class="muted">Waiting for quota window data.</p>';
        return;
      }
      let html = '';
      for (const lane of ['normal', 'spark']) {
        const s = scalingData?.[lane];
        if (!s) continue;
        const proj = s.projected_percent != null ? `${s.projected_percent}%` : '—';
        const used = s.current_used_percent != null ? `${s.current_used_percent}%` : '—';
        const burn = s.burn_rate_percent_per_hour != null ? `${s.burn_rate_percent_per_hour}%/h` : '—';
        const effort = s.active_reasoning_effort || '—';
        html += `<div class="scaling-lane"><strong>${lane}</strong>: used ${used}, projected ${proj}, burn ${burn}`;
        if (s.active_tier_index != null) html += ` → <em>${effort}</em>`;
        html += `</div>`;
      }
      scalingStatus.innerHTML = html || '<p class="muted">No usage windows available.</p>';
    }

    function renderScalingTiers() {
      if (!scalingTierList) return;
      const tiers = Array.isArray(scalingData?.rules?.tiers) ? scalingData.rules.tiers : [];
      scalingTierList.innerHTML = '';
      tiers.forEach((tier, i) => {
        const row = document.createElement('div');
        row.className = 'scaling-tier-row';
        row.innerHTML = `
          <label class="muted">At</label>
          <input type="number" class="scaling-pct" value="${tier.projected_percent ?? 80}" min="0" max="200" step="1" style="width:60px;">
          <label class="muted">%</label>
          <select class="scaling-effort">${SCALING_EFFORTS.map(e => `<option value="${e}"${e === tier.reasoning_effort ? ' selected' : ''}>${e}</option>`).join('')}</select>
          <select class="scaling-model">${SCALING_MODELS.map(m => `<option value="${m.value}"${(m.value === (tier.model || '')) ? ' selected' : ''}>${m.label}</option>`).join('')}</select>
          <button type="button" class="ghost tiny-btn scaling-remove-tier" title="Remove">×</button>
        `;
        row.querySelector('.scaling-remove-tier').addEventListener('click', () => { row.remove(); });
        scalingTierList.appendChild(row);
      });
    }

    function collectScalingRules() {
      ensureScalingRulesState(false);
      const tiers = [];
      if (scalingTierList) {
        scalingTierList.querySelectorAll('.scaling-tier-row').forEach(row => {
          const pct = Number(row.querySelector('.scaling-pct')?.value ?? 80);
          const effort = row.querySelector('.scaling-effort')?.value || 'medium';
          const model = row.querySelector('.scaling-model')?.value || null;
          tiers.push({ projected_percent: pct, reasoning_effort: effort, model: model || null });
        });
      }
      const enabled = scalingToggle?.checked ?? false;
      if (enabled && tiers.length === 0) {
        tiers.push(...defaultScalingTiers());
      }
      return {
        enabled,
        tiers,
        vip_exempt: scalingVipExempt?.checked ?? true,
        host_override_wins: scalingHostOverrideWins?.checked ?? true,
      };
    }

    async function saveScalingRules({
      sourceEl = scalingSave,
      successMessage = 'Scaling rules saved',
      rollbackState = null,
    } = {}) {
      const rules = collectScalingRules();
      if (sourceEl) sourceEl.disabled = true;
      try {
        const res = await api('/admin/scaling', { method: 'POST', json: rules });
        if (res.status === 'ok' && res.data) {
          scalingData = res.data;
          renderScaling();
          if (sourceEl) flashSaved(sourceEl);
          if (successMessage) toast(successMessage);
        } else {
          if (rollbackState) {
            scalingData = rollbackState;
            renderScaling();
          }
          toast((res.errors || [res.message]).join(', ') || 'Failed to save', 'error');
        }
      } catch (e) {
        if (rollbackState) {
          scalingData = rollbackState;
          renderScaling();
        }
        toast('Failed to save scaling rules', 'error');
      } finally {
        if (sourceEl) sourceEl.disabled = false;
      }
    }

    async function fetchScalingStatus() {
      try {
        const res = await api('/admin/scaling');
        if (res.status === 'ok' && res.data) {
          scalingData = res.data;
          renderScaling();
        }
      } catch (_) { /* silent */ }
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

    function renderLogRetention() {
      if (logRetentionToggle) {
        logRetentionToggle.checked = !!logRetentionEnabled;
      }
      if (logRetentionLabel) {
        logRetentionLabel.textContent = logRetentionEnabled ? 'Enabled' : 'Disabled';
      }
      if (logRetentionSliders) {
        logRetentionSliders.classList.toggle('disabled', !logRetentionEnabled);
      }
      if (logRetentionDaysLogsSlider && logRetentionDaysLogsSlider.value !== String(logRetentionDaysLogs)) {
        logRetentionDaysLogsSlider.value = String(logRetentionDaysLogs);
      }
      if (logRetentionDaysLogsLabel) {
        logRetentionDaysLogsLabel.textContent = `${logRetentionDaysLogs} days`;
      }
      if (logRetentionDaysMcpSlider && logRetentionDaysMcpSlider.value !== String(logRetentionDaysMcp)) {
        logRetentionDaysMcpSlider.value = String(logRetentionDaysMcp);
      }
      if (logRetentionDaysMcpLabel) {
        logRetentionDaysMcpLabel.textContent = `${logRetentionDaysMcp} days`;
      }
      if (logRetentionDaysEventsSlider && logRetentionDaysEventsSlider.value !== String(logRetentionDaysEvents)) {
        logRetentionDaysEventsSlider.value = String(logRetentionDaysEvents);
      }
      if (logRetentionDaysEventsLabel) {
        logRetentionDaysEventsLabel.textContent = `${logRetentionDaysEvents} days`;
      }
      if (logRetentionDaysGraphStatsSlider && logRetentionDaysGraphStatsSlider.value !== String(logRetentionDaysGraphStats)) {
        logRetentionDaysGraphStatsSlider.value = String(logRetentionDaysGraphStats);
      }
      if (logRetentionDaysGraphStatsLabel) {
        logRetentionDaysGraphStatsLabel.textContent = `${logRetentionDaysGraphStats} days`;
      }
    }

    function clampRetentionDays(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return 90;
      if (num < 1) return 1;
      if (num > 365) return 365;
      return Math.round(num);
    }

    async function updateLogRetention() {
      const payload = {
        enabled: logRetentionEnabled,
        days_logs: logRetentionDaysLogs,
        days_mcp: logRetentionDaysMcp,
        days_events: logRetentionDaysEvents,
        days_graph_stats: logRetentionDaysGraphStats,
      };
      const setDisabled = (v) => {
        if (logRetentionToggle) logRetentionToggle.disabled = v;
        if (logRetentionDaysLogsSlider) logRetentionDaysLogsSlider.disabled = v;
        if (logRetentionDaysMcpSlider) logRetentionDaysMcpSlider.disabled = v;
        if (logRetentionDaysEventsSlider) logRetentionDaysEventsSlider.disabled = v;
        if (logRetentionDaysGraphStatsSlider) logRetentionDaysGraphStatsSlider.disabled = v;
      };
      setDisabled(true);
      try {
        await api('/admin/log-retention', {
          method: 'POST',
          json: payload,
        });
      } catch (err) {
        toast(`Log retention update failed: ${err.message}`, 'error');
      } finally {
        setDisabled(false);
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
        setInertBehindModal(seedModal, true);
      } else {
        seedModal.classList.remove('show');
        setInertBehindModal(seedModal, false);
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

        if (isVersionBehind(host.client_version, latestVersions.client) || isVersionBehind(host.wrapper_version, latestVersions.wrapper)) {
          summary.behindVersion += 1;
        }
      });

      return summary;
    }

    function computeDashboardPulse(fleetSummary, {
      runnerInfo = null,
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
        claude: typeof versions.claude_version === 'string'
          ? versions.claude_version.trim().replace(/^v/i, '')
          : null,
      };

      tokensSummary = safeData.tokens || null;

      const codexVersion = typeof versions.client_version === 'string'
        ? versions.client_version.trim()
        : null;
      const codexVersionDisplay = codexVersion && codexVersion !== '' ? codexVersion.replace(/^v/i, '') : 'n/a';
      const wrapperVersionDisplay = formatFooterVersion(versions.wrapper_version);

      const fleetSummary = summarizeDashboardHosts(Array.isArray(hostsList) ? hostsList : []);
      const hostTotal = Number.isFinite(hostTotalFromOverview) ? hostTotalFromOverview : fleetSummary.total;
      const hostDenominator = hostTotal > 0 ? hostTotal : 1;
      const secureRatio = hostTotal > 0 ? (fleetSummary.secure / hostDenominator) * 100 : 0;
      const hostsActiveToday = countHostsActiveToday(hostsList);

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
        quotaHardStop: quotaHardFail,
        quotaLimit: quotaLimitPercent,
      });

      const plural = (value, singular, pluralValue = `${singular}s`) => `${value} ${value === 1 ? singular : pluralValue}`;

      renderDashboardStatusBar(pulse);

      chatgptUsage = {
        snapshot: safeData.chatgpt_usage || null,
        summary: safeData.chatgpt_usage_summary || null,
        active_lane: safeData?.chatgpt_usage_summary?.active_quota_lane || safeData?.chatgpt_usage?.active_quota_lane || null,
        cached: safeData.chatgpt_cached || false,
        next_eligible_at: safeData.chatgpt_next_eligible_at || null,
      };
      renderChatGptUsage(chatgptUsage);
      renderClaudeUsage(safeData);
    }

    function renderDashboardStatusBar(pulse) {
      if (!dashboardStatusBar) return;
      const alerts = Array.isArray(pulse?.radar)
        ? pulse.radar.filter((item) => item && (item.tone === 'danger' || item.tone === 'warn'))
        : [];
      if (alerts.length === 0) {
        dashboardStatusBar.hidden = true;
        dashboardStatusBar.innerHTML = '';
        return;
      }
      const items = alerts.map((item) => {
        const tone = item.tone === 'danger' ? 'danger' : 'warn';
        const glyph = tone === 'danger' ? '⚠' : '!';
        return `<span class="dashboard-status-chip status-${tone}" title="${escapeHtml(item.detail || '')}">
          <span class="dashboard-status-glyph" aria-hidden="true">${glyph}</span>
          ${escapeHtml(item.title || '')}
        </span>`;
      }).join('');
      dashboardStatusBar.hidden = false;
      dashboardStatusBar.innerHTML = items;
    }

    function renderTrendSparkline(values) {
      const numeric = (Array.isArray(values) ? values : [])
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v));
      if (numeric.length < 2) return '';
      const width = 120;
      const height = 32;
      const min = Math.min(...numeric);
      const max = Math.max(...numeric);
      const span = Math.max(1e-9, max - min);
      const stepX = numeric.length > 1 ? width / (numeric.length - 1) : 0;
      const points = numeric.map((v, i) => {
        const x = (i * stepX).toFixed(2);
        const y = (height - ((v - min) / span) * (height - 4) - 2).toFixed(2);
        return `${x},${y}`;
      }).join(' ');
      return `<svg class="dashboard-trend-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
        <polyline fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" points="${points}"></polyline>
      </svg>`;
    }

    function formatTrendDelta(curr, prev) {
      if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) {
        return { label: '', tone: '' };
      }
      const pct = ((curr - prev) / Math.abs(prev)) * 100;
      if (!Number.isFinite(pct)) return { label: '', tone: '' };
      const arrow = pct > 0 ? '↑' : (pct < 0 ? '↓' : '→');
      const tone = pct > 5 ? 'up' : (pct < -5 ? 'down' : 'flat');
      return { label: `${arrow}${Math.abs(Math.round(pct))}%`, tone };
    }

    function renderDashboardTrends(overview) {
      if (!dashboardTrends) return;
      const data = overview || {};
      const tokensDayTotal = Number(data?.tokens_day?.total) || 0;
      const tokensWeekTotal = Number(data?.tokens_week?.total) || 0;
      const tokensMonthTotal = Number(data?.tokens_month?.total) || 0;
      const hostsTotal = Number(data?.totals?.hosts) || 0;
      const hostsActiveToday = countHostsActiveToday(currentHosts);
      const tokenValues = [tokensDayTotal, tokensWeekTotal, tokensMonthTotal];
      const tokensDelta = formatTrendDelta(tokensWeekTotal, tokensMonthTotal);
      const tokensSpark = renderTrendSparkline(tokenValues);

      const tile = (label, value, deltaLabel, deltaTone, sparkHtml, subline) => `
        <article class="dashboard-trend-tile">
          <div class="dashboard-trend-label">${escapeHtml(label)}</div>
          <div class="dashboard-trend-row">
            <span class="dashboard-trend-value">${value}</span>
            ${deltaLabel ? `<span class="dashboard-trend-delta delta-${deltaTone}">${escapeHtml(deltaLabel)}</span>` : ''}
          </div>
          ${sparkHtml || ''}
          ${subline ? `<div class="dashboard-trend-sub">${subline}</div>` : ''}
        </article>
      `;

      const hostsActive = `${formatNumber(hostsActiveToday)} <span class="dashboard-trend-denom">/ ${formatNumber(hostsTotal)}</span>`;
      const todayLine = `${formatCompactNumber(tokensDayTotal)} <span class="dashboard-trend-denom">tok</span>`;

      dashboardTrends.innerHTML = [
        tile(
          'Tokens (month)',
          formatCompactNumber(tokensMonthTotal),
          tokensDelta.label,
          tokensDelta.tone,
          tokensSpark,
          `Week ${formatCompactNumber(tokensWeekTotal)}`,
        ),
        tile('Hosts active', hostsActive, '', '', '', 'Active in last 24h'),
        tile('Today', todayLine, '', '', '', 'Recorded usage'),
      ].join('');
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
        setInertBehindModal(upgradeModal, true);
      } else {
        upgradeModal.classList.remove('show');
        setInertBehindModal(upgradeModal, false);
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
        const [overview, hosts, runner, skills, agents] = await Promise.all([
          api('/admin/overview'),
          api('/admin/hosts'),
          api('/admin/runner').catch(err => {
            console.warn('Runner status unavailable', err);
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

        if (typeof currentOverview.log_retention_enabled !== 'undefined') {
          logRetentionEnabled = !!currentOverview.log_retention_enabled;
        }
        if (typeof currentOverview.log_retention_days_logs !== 'undefined') {
          logRetentionDaysLogs = clampRetentionDays(currentOverview.log_retention_days_logs);
        }
        if (typeof currentOverview.log_retention_days_mcp !== 'undefined') {
          logRetentionDaysMcp = clampRetentionDays(currentOverview.log_retention_days_mcp);
        }
        if (typeof currentOverview.log_retention_days_events !== 'undefined') {
          logRetentionDaysEvents = clampRetentionDays(currentOverview.log_retention_days_events);
        }
        if (typeof currentOverview.log_retention_days_graph_stats !== 'undefined') {
          logRetentionDaysGraphStats = clampRetentionDays(currentOverview.log_retention_days_graph_stats);
        }
        renderLogRetention();

        renderStats(currentOverview, runner?.data || null, hostsList);
        renderDashboardTrends(currentOverview);
        renderHosts(hostsList);
        renderInsecureHostsQuickButton(hostsList);
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
        if (currentOverview.scaling != null) {
          scalingData = currentOverview.scaling;
          renderScaling();
        }
        await loadCodexVersionControl();
        await loadClaudeVersion();
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

    function renderClosedInsecureHostSubline() {
      return '<div class="quick-hosts-sub">Window closed</div>';
    }

    function insecureHostModalAction(active) {
      const action = active ? 'disable' : 'enable';
      const label = active ? 'Disable' : 'Enable';
      return { action, label };
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
      setInertBehindModal(insecureHostsModal, false);
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
          const onlineFor = formatCountdown(host?.insecure_enabled_until);
          const onlineUntil = host?.insecure_enabled_until || '';
          const { action, label } = insecureHostModalAction(active);
          const onlineLine = active
            ? (onlineFor !== '—'
              ? `<div class="quick-hosts-sub" data-countdown="host" data-until="${escapeHtml(onlineUntil)}">Online: ${escapeHtml(onlineFor)}</div>`
              : '<div class="quick-hosts-sub">Online now</div>')
            : renderClosedInsecureHostSubline();
          return `
            <div class="quick-hosts-row" data-host-id="${host.id}">
              <div class="quick-hosts-info">
                <div class="quick-hosts-fqdn">${escapeHtml(host.fqdn || '')}</div>
                ${onlineLine}
              </div>
              <div class="quick-hosts-actions">
                <button class="ghost" data-action="disable" data-next-action="${action}">${label}</button>
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
          insecureDomainsList.innerHTML = '<div class="quick-hosts-row"><div class="quick-hosts-info"><div class="quick-hosts-fqdn muted">No active allowed domains.</div></div></div>';
        } else {
          insecureDomainsList.innerHTML = domains.map((domain) => {
            const label = 'Revoke';
            const btnClass = 'ghost';
            const onlineFor = formatCountdown(domain?.enabled_until);
            const onlineUntil = domain?.enabled_until || '';
            const onlineLine = onlineFor !== '—'
              ? `<div class="quick-hosts-sub" data-countdown="domain" data-until="${escapeHtml(onlineUntil)}">Auto-allow: ${escapeHtml(onlineFor)}</div>`
              : '<div class="quick-hosts-sub">Auto-allow active</div>';
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
      setInertBehindModal(insecureHostsModal, true);
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
        toast(err.message, 'error');
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
          const disableBtns = insecureHostsList?.querySelectorAll('button[data-action="disable"]');
          if (!disableBtns?.length) return;
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
          const buttonAction = String(btn.getAttribute('data-action') || '').toLowerCase();
          if (buttonAction !== 'disable') return;

          btn.disabled = true;
          const originalLabel = btn.textContent;
          btn.textContent = 'Working…';
          try {
            const resp = await api('/admin/hosts/insecure');
            const hosts = resp?.data?.hosts || [];
            const target = hosts.find(h => (h?.id | 0) === hostId);
            if (!target) {
              throw new Error('Host not found (refresh and retry).');
            }
            const active = target?.active === true || hostHasActiveInsecureWindow(target);
            const action = active ? 'disable' : 'enable';
            btn.textContent = active ? 'Turning off…' : 'Turning on…';
            const desired = action === 'enable' ? true : action === 'disable' ? false : !active;
            await toggleInsecureApi(target, null, desired);
            const refreshed = await api('/admin/hosts/insecure');
            openInsecureHostsModal(refreshed?.data?.hosts || [], refreshed?.data?.domains || []);
          } catch (err) {
            console.error('insecure hosts toggle failed', err);
            const verb = action === 'enable' ? 'Enable' : 'Disable';
            toast(`${verb} failed: ${err.message}`, 'error');
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
        toast(`Version check failed: ${err.message}`, 'error');
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
        else toast(`Runner failed: ${err.message}`, 'error');
        throw err;
      }
    }

    function showRunnerModal(show) {
      if (!runnerModal) return;
      if (show) {
        runnerModal.classList.add('show');
        setInertBehindModal(runnerModal, true);
        resetRunnerLog();
        setRunnerMeta(runnerSummary, null);
      } else {
        runnerModal.classList.remove('show');
        setInertBehindModal(runnerModal, false);
      }
    }

    function openAgentsEditor() {
      if (!agentsEditorInline) return;
      agentsOriginalContent = agentsCurrentContent();
      agentsEditorInline.value = agentsOriginalContent;
      agentsEditing = true;
      syncAgentsEditorUI();
      try { agentsEditorInline.focus(); } catch (_) {}
    }

    function closeAgentsEditor() {
      agentsEditing = false;
      agentsOriginalContent = '';
      syncAgentsEditorUI();
    }

    function maybeCloseAgentsEditorOnBlur() {
      if (!agentsEditing || agentsSaveInFlight || agentsHasUnsavedChanges()) return;
      closeAgentsEditor();
    }

    async function saveAgentsInline() {
      if (!agentsEditorInline || !agentsSaveInline || agentsSaveInFlight) return;
      const content = normalizeAgentsEditorText(agentsEditorInline.value);
      if (content === agentsOriginalContent) return;

      agentsSaveInFlight = true;
      syncAgentsEditorUI();
      setAgentsStatusMessage('Saving AGENTS.md…', null);
      try {
        const response = await api('/admin/agents/store', {
          method: 'POST',
          json: { content },
        });
        const result = response?.data || response || {};
        currentAgents = {
          ...(currentAgents || {}),
          status: 'ok',
          content,
          updated_at: result?.updated_at || new Date().toISOString(),
          size_bytes: content.length,
          sha256: result?.sha256 || currentAgents?.sha256 || null,
        };
        closeAgentsEditor();
        renderAgents(currentAgents);
        const msg = result?.status === 'unchanged' ? 'No changes to save' : 'Saved AGENTS.md';
        setAgentsStatusMessage(msg, 'ok');
        setTimeout(() => {
          if ((agentsStatus?.textContent || '') === msg) setAgentsStatusMessage('', null);
        }, 2200);
        await loadAll();
      } catch (err) {
        agentsEditing = true;
        syncAgentsEditorUI();
        setAgentsStatusMessage(`Save failed: ${err.message}`, 'error');
      } finally {
        agentsSaveInFlight = false;
        syncAgentsEditorUI();
      }
    }

    function agentsHostsUsingVersion(versionId) {
      const target = normalizeAgentsVersionId(versionId);
      if (!target) return [];
      return (Array.isArray(currentHosts) ? currentHosts : []).filter(host => (
        normalizeAgentsVersionId(host?.agents_document_id_override) === target
      ));
    }

    async function restoreAgentsVersion(versionId) {
      const id = normalizeAgentsVersionId(versionId);
      if (!id || agentsRestoreInFlight || agentsDeleteInFlight) return;
      if (!await showConfirmModal('Restore backup', `Restore AGENTS backup v${id} to current production? This creates a new latest version and serves it fleet-wide.`, { action: 'Restore', warn: false })) {
        return;
      }

      agentsRestoreInFlight = true;
      renderAgents(currentAgents);
      setAgentsStatusMessage(`Restoring v${id}…`, null);
      try {
        await api('/admin/agents/revert', {
          method: 'POST',
          json: { version_id: id },
        });
        await loadAll();
        const msg = `Restored v${id} to current production`;
        setAgentsStatusMessage(msg, 'ok');
        setTimeout(() => {
          if ((agentsStatus?.textContent || '') === msg) setAgentsStatusMessage('', null);
        }, 2200);
      } catch (err) {
        setAgentsStatusMessage(`Restore failed: ${err.message}`, 'error');
      } finally {
        agentsRestoreInFlight = false;
        renderAgents(currentAgents);
      }
    }

    async function deleteAgentsVersion(versionId) {
      const id = normalizeAgentsVersionId(versionId);
      if (!id || agentsDeleteInFlight || agentsRestoreInFlight) return;
      const affectedHosts = agentsHostsUsingVersion(id);
      const count = affectedHosts.length;
      const hostNote = count > 0
        ? ` ${count} pinned host${count === 1 ? '' : 's'} will be moved to Global before deletion.`
        : '';
      if (!await showConfirmModal('Delete backup', `Delete AGENTS backup v${id}?${hostNote} This cannot be undone.`, { action: 'Delete' })) {
        return;
      }

      agentsDeleteInFlight = true;
      renderAgents(currentAgents);
      setAgentsStatusMessage(`Deleting v${id}…`, null);
      try {
        if (affectedHosts.length) {
          await Promise.all(affectedHosts.map((host) => (
            api(`/admin/hosts/${host.id}/agents-version`, {
              method: 'POST',
              json: { selection: 'global' },
            })
          )));
        }
        await api(`/admin/agents/versions/${id}`, { method: 'DELETE' });
        await loadAll();
        const msg = affectedHosts.length
          ? `Deleted v${id} and moved ${affectedHosts.length} host${affectedHosts.length === 1 ? '' : 's'} to Global`
          : `Deleted v${id}`;
        setAgentsStatusMessage(msg, 'ok');
        setTimeout(() => {
          if ((agentsStatus?.textContent || '') === msg) setAgentsStatusMessage('', null);
        }, 2200);
      } catch (err) {
        setAgentsStatusMessage(`Delete failed: ${err.message}`, 'error');
      } finally {
        agentsDeleteInFlight = false;
        renderAgents(currentAgents);
      }
    }

    async function loadSkillDetailByRoute(routeSlug) {
      if (!skillDetailPanel) return;
      const target = decodeURIComponent(String(routeSlug || '').trim());
      const isNew = target === '' || target === 'new';
      resetSkillWorkspaceForm();
      resetSkillWorkspaceEmptyState();
      setSkillDetailMode(isNew ? 'new' : 'edit', target);
      if (isNew) {
        skillCreationMode = '';
        if (skillDetailLayout) skillDetailLayout.hidden = true;
        if (skillModeSplash) skillModeSplash.hidden = false;
        if (skillModeSwitchBtn) skillModeSwitchBtn.hidden = true;
        if (skillStatus) skillStatus.textContent = '';
        return;
      }

      if (skillModeSplash) skillModeSplash.hidden = true;
      if (skillDetailLayout) skillDetailLayout.hidden = false;
      if (skillModeSwitchBtn) skillModeSwitchBtn.hidden = true;
      const chatSection = skillDetailLayout?.querySelector('.skill-chat-section');
      if (chatSection) chatSection.hidden = false;

      showSkillWorkspaceEmpty('Loading skill…', 'Fetching skill details.');
      try {
        const resp = await api(`/admin/skills/${encodeURIComponent(target)}`);
        const data = resp?.data || {};
        const parsed = parseSkillManifest(data.manifest || '');
        const loadedSlug = (data.slug || target || '').trim();
        resetSkillWorkspaceEmptyState();
        skillEditingSlug = loadedSlug;
        setSkillDetailMode('edit', loadedSlug);
        if (skillSlug) skillSlug.value = loadedSlug;
        if (skillNameInput) skillNameInput.value = parsed.name || data.display_name || data.slug || '';
        if (skillDescriptionInput) skillDescriptionInput.value = parsed.description || data.description || '';
        if (skillWhatInput) skillWhatInput.value = parsed.sections.what || '';
        if (skillWhenInput) skillWhenInput.value = parsed.sections.when || '';
        if (skillStepsInput) skillStepsInput.value = parsed.sections.steps || '';
        setSkillTags(parsed.tags || []);
        setSkillBadges({ sha256: data.sha256, updated_at: data.updated_at });
        if (skillStatus) skillStatus.textContent = '';
        if (skillAssistStatus) skillAssistStatus.textContent = '';
        setSkillDirty(false);
      } catch (err) {
        showSkillWorkspaceEmpty('Skill load failed', err?.message || 'Unable to load the requested skill.');
      }
    }

    async function assistSkillDraft() {
      const prompt = skillAssistInput?.value?.trim() || '';
      if (!prompt) {
        if (skillAssistStatus) skillAssistStatus.textContent = 'Describe the change you want before asking AI to update the skill.';
        skillAssistInput?.focus();
        return;
      }

      const userMessage = { role: 'user', content: prompt };
      const messages = [...skillConversationMessages, userMessage];
      if (skillAssistStatus) skillAssistStatus.textContent = 'Applying AI changes…';
      setSkillBusy(true);
      showSkillTypingIndicator(true);

      try {
        const resp = await api('/admin/skills/assist', {
          method: 'POST',
          json: {
            mode: skillDetailMode,
            messages,
            skill: currentSkillDraftFromFields(),
          },
        });
        const data = resp?.data || {};
        skillConversationMessages = [...messages, {
          role: 'assistant',
          content: data.assistant_message || 'Updated the skill draft.',
        }];
        renderSkillConversation();
        applySkillDraft(data, { changedFields: data.changed_fields || [] });
        if (skillAssistInput) { skillAssistInput.value = ''; autoResizeSkillInput(); }
        if (skillAssistStatus) skillAssistStatus.textContent = data.assistant_message || 'Draft updated.';
        if (skillStatus) skillStatus.textContent = 'AI updated the draft. Review the highlighted fields and save when ready.';
      } catch (err) {
        if (skillAssistStatus) skillAssistStatus.textContent = `AI update failed: ${err.message}`;
      } finally {
        showSkillTypingIndicator(false);
        setSkillBusy(false);
      }
    }

    async function saveSkill() {
      if (!skillSlug || !skillNameInput || !skillWhatInput || !skillWhenInput || !skillStepsInput) {
        if (skillStatus) skillStatus.textContent = 'Skill form missing required fields';
        return;
      }
      const slug = skillSlug.value.trim();
      const isEdit = skillDetailMode === 'edit' && !!skillEditingSlug;
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
      setSkillBusy(true);
      try {
        const resp = await api('/admin/skills/store', {
          method: 'POST',
          json: payload,
        });
        const saveState = resp?.data?.status || 'updated';
        if (skillStatus) {
          skillStatus.textContent = saveState === 'unchanged' ? 'No changes' : 'Saved';
        }
        if (skillDetailMode !== 'edit') {
          skillEditingSlug = slug;
          skillDetailMode = 'edit';
          setSkillDetailMode('edit', slug);
          history.replaceState({}, '', skillDetailPath(slug));
        }
        setSkillBadges({ sha256: resp?.data?.sha256, updated_at: resp?.data?.updated_at });
        setSkillDirty(false);
        await loadAll();
      } catch (err) {
        if (skillStatus) skillStatus.textContent = `Save failed: ${err.message}`;
      } finally {
        setSkillBusy(false);
      }
    }

    async function deleteSkill(slug, options = {}) {
      if (!slug) return;
      const fromDetail = options?.fromDetail === true;
      if (!await showConfirmModal('Delete skill', `Delete skill "${slug}"? Hosts remove it on next sync.`, { action: 'Delete' })) {
        return;
      }
      if (fromDetail && skillStatus) {
        skillStatus.textContent = 'Deleting…';
      }
      if (skillDelete) skillDelete.disabled = true;
      if (skillSave) skillSave.disabled = true;
      try {
        await api(`/admin/skills/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        if (fromDetail && skillStatus) {
          skillStatus.textContent = 'Deleted';
          setSkillDirty(false);
          navigateAdminShortcut('/admin/settings/skills');
        }
        await loadAll();
      } catch (err) {
        if (fromDetail && skillStatus) {
          skillStatus.textContent = `Delete failed: ${err.message}`;
        } else {
          toast(`Delete failed: ${err.message}`, 'error');
        }
      } finally {
        if (skillDelete) skillDelete.disabled = false;
        if (skillSave) skillSave.disabled = false;
      }
    }

    window.__loadSkillDetailByRoute = loadSkillDetailByRoute;

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
        if (currentAgents) {
          hostDetailSupportLoaded = true;
        }
        setRunnerMeta(runnerSummary, runResult);
        appendRunnerLog('Runner finished', runResult?.applied ? 'ok' : null);
      } catch (err) {
        appendRunnerLog(`Runner error: ${err.message}`, 'err');
      }
    }

    // ── Claude runner verification ──

    function appendToLogEl(logEl, message, tone) {
      if (!logEl) return;
      const line = document.createElement('div');
      line.className = 'line' + (tone ? ` ${tone}` : '');
      const ts = new Date().toLocaleTimeString();
      line.textContent = `${ts} \u00b7 ${message}`;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    }

    function setClaudeRunnerMeta(result) {
      if (!claudeRunnerMetaEl) return;
      if (!result) {
        claudeRunnerMetaEl.innerHTML = '';
        return;
      }
      const status = result?.status || 'unknown';
      const latency = result?.latency_ms ? `${result.latency_ms}ms` : 'n/a';
      const model = result?.model || 'n/a';
      const error = result?.error || '';
      claudeRunnerMetaEl.innerHTML = `
        <div><div class="label">Status</div><div>${status === 'ok' ? 'OK' : status}</div></div>
        <div><div class="label">Latency</div><div>${latency}</div></div>
        <div><div class="label">Model</div><div>${escapeHtml(model)}</div></div>
        ${error ? `<div><div class="label">Error</div><div>${escapeHtml(error)}</div></div>` : ''}
      `;
    }

    function showClaudeRunnerModal(show) {
      if (!claudeRunnerModal) return;
      if (show) {
        claudeRunnerModal.classList.add('show');
        setInertBehindModal(claudeRunnerModal, true);
        if (claudeRunnerLogEl) claudeRunnerLogEl.innerHTML = '';
        setClaudeRunnerMeta(null);
      } else {
        claudeRunnerModal.classList.remove('show');
        setInertBehindModal(claudeRunnerModal, false);
      }
    }

    async function runClaudeVerification(logFn = null) {
      try {
        if (logFn) logFn('Invoking Claude verification\u2026');
        const startMs = performance.now();
        const res = await api('/admin/runner/run-claude', { method: 'POST' });
        const elapsedMs = Math.round(performance.now() - startMs);
        const result = res?.data ?? {};
        if (!result.latency_ms) result.latency_ms = elapsedMs;
        const ok = result?.status === 'ok';
        if (logFn) logFn(`Claude verification completed (status=${ok ? 'ok' : 'fail'}, ${elapsedMs}ms)`, ok ? 'ok' : 'err');
        return result;
      } catch (err) {
        if (logFn) logFn(`Claude verification failed: ${err.message}`, 'err');
        else toast(`Claude verification failed: ${err.message}`, 'error');
        throw err;
      }
    }

    async function handleClaudeRunnerClick() {
      const logFn = (msg, tone) => appendToLogEl(claudeRunnerLogEl, msg, tone);
      if (!claudeRunnerModal || !claudeRunnerLogEl) {
        try {
          const result = await runClaudeVerification();
          updateClaudeRunnerChip(result);
          toast('Claude verification succeeded', 'success');
        } catch (_) {
          updateClaudeRunnerChip({ status: 'fail' });
        }
        return;
      }
      showClaudeRunnerModal(true);
      logFn('Preparing Claude verification\u2026');
      try {
        const result = await runClaudeVerification(logFn);
        setClaudeRunnerMeta(result);
        updateClaudeRunnerChip(result);
        logFn('Claude verification finished', result?.status === 'ok' ? 'ok' : 'err');
      } catch (err) {
        logFn(`Claude verification error: ${err.message}`, 'err');
        updateClaudeRunnerChip({ status: 'fail' });
      }
    }

    function updateClaudeRunnerChip(result) {
      const chip = document.getElementById('claudeRunnerChip');
      if (!chip) return;
      chip.classList.remove('ok', 'warn', 'err');
      const status = result?.status || 'unknown';
      const latency = result?.latency_ms ? ` (${result.latency_ms}ms)` : '';
      if (status === 'ok') {
        chip.classList.add('ok');
        chip.innerHTML = `<span class="dot"></span>Claude runner OK${latency}`;
      } else if (status === 'fail') {
        chip.classList.add('err');
        chip.innerHTML = `<span class="dot"></span>Claude runner failed${latency}`;
      } else {
        chip.classList.add('warn');
        chip.innerHTML = `<span class="dot"></span>Claude runner ${escapeHtml(status)}${latency}`;
      }
    }

    // ── Claude settings panel (engine-scoped fleet config) ──

    async function loadClaudeSettings() {
      try {
        const res = await api('/admin/claude/settings');
        const data = res?.data || {};
        const modelEl = document.getElementById('claudeDefaultModel');
        const maxEl = document.getElementById('claudeMaxTokens');
        if (modelEl && data.default_model) modelEl.value = data.default_model;
        if (maxEl && typeof data.max_tokens === 'number') maxEl.value = String(data.max_tokens);
      } catch (err) {
        console.error('loadClaudeSettings failed', err);
      }
    }

    async function saveClaudeSettings() {
      const saveBtn = document.getElementById('claudeSettingsSaveBtn');
      const modelEl = document.getElementById('claudeDefaultModel');
      const maxEl = document.getElementById('claudeMaxTokens');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
      try {
        const body = {
          default_model: modelEl?.value || 'claude-sonnet-4-6',
          max_tokens: parseInt(maxEl?.value || '8192', 10) || 8192,
        };
        await api('/admin/claude/settings', { method: 'POST', json: body });
        toast('Claude settings saved', 'success');
      } catch (err) {
        toast(`Save failed: ${err.message}`, 'error');
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
      }
    }

    window.__initClaudeOnce = () => {
      loadClaudeSettings();
      // Probe runner state so the chip shows something other than 'Checking…'.
      (async () => {
        try {
          const result = await runClaudeVerification();
          updateClaudeRunnerChip(result);
        } catch (_) {
          updateClaudeRunnerChip({ status: 'fail' });
        }
      })();

      const saveBtn = document.getElementById('claudeSettingsSaveBtn');
      if (saveBtn && !saveBtn.dataset.bound) {
        saveBtn.dataset.bound = '1';
        saveBtn.addEventListener('click', saveClaudeSettings);
      }
      const verifyBtn = document.getElementById('claudeRunnerVerifyBtn');
      if (verifyBtn && !verifyBtn.dataset.bound) {
        verifyBtn.dataset.bound = '1';
        verifyBtn.addEventListener('click', handleClaudeRunnerClick);
      }
    };

    // ── Claude usage rendering ──

    function renderClaudeUsage(data) {
      if (!claudeUsageCard) return;
      const usage = data?.claude_usage || null;
      if (!usage) {
        claudeUsageCard.innerHTML = `
          <header class="usage-card-head">
            <h2>Claude</h2>
            <span class="usage-plan-pill">API</span>
          </header>
          <div class="usage-empty-state">
            <strong>Usage not available yet</strong>
            <span>Claude totals will appear here after the first recorded API usage window.</span>
          </div>
        `;
        return;
      }

      const models = usage.models || {};
      const modelKeys = Object.keys(models);
      const totals = usage.totals || {};
      const totalInput = Number(totals.input_tokens) || 0;
      const totalOutput = Number(totals.output_tokens) || 0;
      const totalCached = Number(totals.cached_tokens) || 0;
      const period = usage.period || '24h';
      const fetchedAt = usage.fetched_at ? formatRelative(usage.fetched_at) : 'never';

      let modelsHtml = '';
      if (modelKeys.length > 0) {
        const modelRows = modelKeys.map((key) => {
          const m = models[key] || {};
          return `<tr>
            <td><code>${escapeHtml(key)}</code></td>
            <td>${formatCompactNumber(Number(m.input_tokens) || 0)}</td>
            <td>${formatCompactNumber(Number(m.output_tokens) || 0)}</td>
            <td>${formatCompactNumber(Number(m.cached_tokens) || 0)}</td>
          </tr>`;
        }).join('');
        modelsHtml = `
          <table class="claude-usage-table">
            <thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cached</th></tr></thead>
            <tbody>${modelRows}</tbody>
          </table>
        `;
      }

      const periodButtons = ['24h', '7d', '30d'].map((p) =>
        `<button type="button" class="ghost tiny-btn claude-period-btn${p === period ? ' is-active' : ''}" data-claude-period="${p}">${p}</button>`
      ).join('');

      claudeUsageCard.innerHTML = `
        <div class="claude-usage-head">
          <div>
            <div class="stat-label">Claude / Anthropic</div>
            <h3>API Usage</h3>
          </div>
          <div class="claude-usage-controls">
            <div class="claude-period-group" role="group" aria-label="Time period">${periodButtons}</div>
            <span class="muted" style="font-size:0.8em;">Updated ${fetchedAt}</span>
          </div>
        </div>
        <div class="claude-usage-totals">
          <div class="claude-usage-stat">
            <div class="stat-label">Input tokens</div>
            <div class="stat-value">${formatCompactNumber(totalInput)}</div>
          </div>
          <div class="claude-usage-stat">
            <div class="stat-label">Output tokens</div>
            <div class="stat-value">${formatCompactNumber(totalOutput)}</div>
          </div>
          <div class="claude-usage-stat">
            <div class="stat-label">Cached tokens</div>
            <div class="stat-value">${formatCompactNumber(totalCached)}</div>
          </div>
        </div>
        ${modelsHtml}
      `;

      claudeUsageCard.querySelectorAll('.claude-period-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const p = btn.dataset.claudePeriod;
          if (!p) return;
          claudeUsageCard.querySelectorAll('.claude-period-btn').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          try {
            const res = await api('/admin/claude/usage?period=' + encodeURIComponent(p));
            renderClaudeUsage({ claude_usage: res?.data || null });
          } catch (err) {
            toast('Failed to load Claude usage: ' + err.message, 'error');
          }
        });
      });
    }

    // ── Claude version management ──

    const claudeVersionSelect = document.getElementById('claudeVersionSelect');
    const claudeVersionMeta = document.getElementById('claudeVersionMeta');
    const claudeVersionBadge = document.getElementById('claudeVersionBadge');
    const claudeVersionLockToggle = document.getElementById('claudeVersionLockToggle');
    const claudeVersionLockLabel = document.getElementById('claudeVersionLockLabel');
    let claudeVersionData = null;

    async function loadClaudeVersion() {
      if (!claudeVersionSelect) return;

      try {
        const res = await api('/admin/claude/version');
        claudeVersionData = res?.data || null;
      } catch (_) {
        claudeVersionData = null;
      }

      if (!claudeVersionData) {
        if (claudeVersionMeta) claudeVersionMeta.textContent = 'Claude version data not available.';
        if (claudeVersionBadge) claudeVersionBadge.textContent = 'n/a';
        return;
      }

      const current = claudeVersionData.current_version || 'unknown';
      const locked = claudeVersionData.locked === true;
      const lockedVersion = claudeVersionData.locked_version || null;
      const updatedAt = claudeVersionData.updated_at || null;

      if (claudeVersionBadge) claudeVersionBadge.textContent = locked ? 'Locked' : 'Latest';
      if (claudeVersionLockToggle) claudeVersionLockToggle.checked = locked;
      if (claudeVersionLockLabel) claudeVersionLockLabel.textContent = locked ? 'Locked' : 'Unlocked';

      claudeVersionSelect.innerHTML = '';
      const latestOpt = document.createElement('option');
      latestOpt.value = 'latest';
      latestOpt.textContent = `Latest (${current})`;
      claudeVersionSelect.appendChild(latestOpt);

      if (lockedVersion && lockedVersion !== current) {
        const lockedOpt = document.createElement('option');
        lockedOpt.value = lockedVersion;
        lockedOpt.textContent = `${lockedVersion} (pinned)`;
        claudeVersionSelect.appendChild(lockedOpt);
      }

      const versions = claudeVersionData.available_versions || [];
      for (const v of versions) {
        if (v === current || v === lockedVersion) continue;
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        claudeVersionSelect.appendChild(opt);
      }

      claudeVersionSelect.value = locked && lockedVersion ? lockedVersion : 'latest';

      if (claudeVersionMeta) {
        const atLabel = updatedAt ? formatRelative(updatedAt) : 'unknown';
        claudeVersionMeta.textContent = `Current: ${current}${locked ? ` (locked to ${lockedVersion})` : ''} \u00b7 Updated ${atLabel}`;
      }
    }

    async function setClaudeVersion(version) {
      if (!claudeVersionSelect) return;
      claudeVersionSelect.disabled = true;
      try {
        await api('/admin/claude/version', {
          method: 'POST',
          json: { version },
        });
        toast(`Claude version set to ${version === 'latest' ? 'latest' : version}`, 'success');
        await loadClaudeVersion();
      } catch (err) {
        toast(`Failed to set Claude version: ${err.message}`, 'error');
      } finally {
        claudeVersionSelect.disabled = false;
      }
    }

    function wireClaudeVersionControls() {
      if (claudeVersionSelect) {
        claudeVersionSelect.addEventListener('change', () => {
          setClaudeVersion(claudeVersionSelect.value);
        });
      }
      if (claudeVersionLockToggle) {
        claudeVersionLockToggle.addEventListener('change', () => {
          const version = claudeVersionLockToggle.checked ? (claudeVersionSelect?.value || 'latest') : 'latest';
          setClaudeVersion(version);
        });
      }
    }

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
      if (seg1 === 'skills') return { panel: 'skill-detail', sub: seg2 };
      if (seg1 === 'logs') return { panel: 'logs', sub: seg2 };
      if (seg1 === 'account') return { panel: 'account', sub: seg2 || 'password' };
      if (seg1 === 'settings') return { panel: 'settings', sub: seg2 };
      if (seg1 === 'users') return { panel: 'settings', sub: 'users' };
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
      if (panel === 'skill-detail' && sub) {
        document.body.dataset.skillSlug = decodeURIComponent(sub);
      } else if (document.body?.dataset?.skillSlug) {
        delete document.body.dataset.skillSlug;
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
        setActiveHostDetailId(parsedHostId);
        renderActiveHostDetail();
        ensureHostDetailLoaded()
          .then(() => {
            renderActiveHostDetail();
            return ensureHostDetailSupportLoaded();
          })
          .catch((err) => {
            console.error('host detail load failed', err);
            clearHostDetailContent();
            showHostDetailEmpty('Host load failed', err?.message || 'Unable to load host details.');
          });
      }

      if (panel === 'dashboard') {
        ensureDataLoaded();
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

      if (panel === 'skill-detail') {
        setActiveLinks('.settings-tab', 'skills');
        if (window.__loadSkillDetailByRoute) {
          window.__loadSkillDetailByRoute(sub);
        }
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
        if (settingsTab === 'agents') {
          syncAgentsEditorUI();
        }
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
        if (settingsTab === 'apikeys' && window.__initApiKeysOnce) {
          window.__initApiKeysOnce();
          window.__initApiKeysOnce = null;
        }
        if (settingsTab === 'users' && window.__initUsersOnce) {
          window.__initUsersOnce();
          window.__initUsersOnce = null;
        }
        if (settingsTab === 'joplin') {
          loadJoplinConfig();
        }
        if (settingsTab === 'claude' && window.__initClaudeOnce) {
          window.__initClaudeOnce();
          window.__initClaudeOnce = null;
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
      if (window.__adminDirtyModules?.size > 0) {
        const names = Array.from(window.__adminDirtyModules).join(', ');
        if (!window.confirm(`You have unsaved changes in ${names}. Leave without saving?`)) return;
        window.__adminDirtyModules.clear();
      }
      history.pushState({}, '', url.toString());
      applyRouting();
    });

    // Warn on full-page navigation (browser reload, external link, etc.) when there are unsaved changes.
    window.addEventListener('beforeunload', (event) => {
      if (!window.__adminDirtyModules?.size) return;
      event.preventDefault();
      event.returnValue = '';
    });

    setAgentsTab(agentsActiveTab);
    syncAgentsEditorUI();
    applyRouting();
    if (versionCheckBtn) {
      versionCheckBtn.addEventListener('click', runVersionCheck);
    }
    if (runnerRunnerBtn) {
      runnerRunnerBtn.addEventListener('click', handleRunnerClick);
    }
    if (claudeRunnerModal) {
      claudeRunnerModal.addEventListener('click', (e) => {
        if (e.target === claudeRunnerModal) showClaudeRunnerModal(false);
      });
    }
    if (claudeRunnerCloseBtn) {
      claudeRunnerCloseBtn.addEventListener('click', () => showClaudeRunnerModal(false));
    }
    wireClaudeVersionControls();
    /* ── General settings: section-jump navigation ── */
    (function initGeneralSectionNav() {
      const navBtns = document.querySelectorAll('.general-section-btn');
      const groups = document.querySelectorAll('.general-group[data-group]');
      if (!navBtns.length || !groups.length) return;

      navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          navBtns.forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          groups.forEach(g => g.classList.remove('is-visible'));
          const target = document.querySelector(`.general-group[data-group="${btn.dataset.section}"]`);
          if (target) target.classList.add('is-visible');
        });
      });

      const observer = new IntersectionObserver(entries => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            navBtns.forEach(b => b.classList.remove('is-active'));
            const match = document.querySelector(`.general-section-btn[data-section="${e.target.dataset.group}"]`);
            if (match) match.classList.add('is-active');
          }
        });
      }, { rootMargin: '-30% 0px -60% 0px' });
      groups.forEach(g => observer.observe(g));
    })();
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
    if (logRetentionToggle) {
      logRetentionToggle.addEventListener('change', () => {
        logRetentionEnabled = logRetentionToggle.checked;
        renderLogRetention();
        updateLogRetention();
      });
    }
    [
      [logRetentionDaysLogsSlider, logRetentionDaysLogsLabel, 'logRetentionDaysLogs'],
      [logRetentionDaysMcpSlider, logRetentionDaysMcpLabel, 'logRetentionDaysMcp'],
      [logRetentionDaysEventsSlider, logRetentionDaysEventsLabel, 'logRetentionDaysEvents'],
      [logRetentionDaysGraphStatsSlider, logRetentionDaysGraphStatsLabel, 'logRetentionDaysGraphStats'],
    ].forEach(([slider, label, stateKey]) => {
      if (!slider) return;
      slider.addEventListener('input', (event) => {
        const preview = clampRetentionDays(event.target.value);
        if (label) label.textContent = `${preview} days`;
      });
      slider.addEventListener('change', (event) => {
        const clamped = clampRetentionDays(event.target.value);
        if (stateKey === 'logRetentionDaysLogs') logRetentionDaysLogs = clamped;
        else if (stateKey === 'logRetentionDaysMcp') logRetentionDaysMcp = clamped;
        else if (stateKey === 'logRetentionDaysEvents') logRetentionDaysEvents = clamped;
        else if (stateKey === 'logRetentionDaysGraphStats') logRetentionDaysGraphStats = clamped;
        updateLogRetention();
      });
    });
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
      newHostBtn.addEventListener('click', () => openNewHostModal({ closeMenus: true }));
    }
    if (quickVmBtn) {
      quickVmBtn.addEventListener('click', () => openQuickVmModal({ closeMenus: true }));
    }
    if (quickVmPanelBtn) {
      quickVmPanelBtn.addEventListener('click', () => openQuickVmModal());
    }
    if (quickVmCancel) {
      quickVmCancel.addEventListener('click', () => showQuickVmModal(false));
    }
    quickVmButtons.forEach((button) => {
      button.addEventListener('click', () => {
        createQuickVm(button.getAttribute('data-quick-vm-engines') || '', button);
      });
    });
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
    if (newSkillBtn) {
      newSkillBtn.addEventListener('click', (event) => {
        event.preventDefault();
        openSkillDetail('');
      });
    }
    if (skillModeAiBtn) {
      skillModeAiBtn.addEventListener('click', () => activateSkillCreationMode('ai'));
    }
    if (skillModeManualBtn) {
      skillModeManualBtn.addEventListener('click', () => activateSkillCreationMode('manual'));
    }
    if (skillModeSwitchBtn) {
      skillModeSwitchBtn.addEventListener('click', () => {
        if (skillDetailLayout) skillDetailLayout.hidden = true;
        if (skillModeSplash) skillModeSplash.hidden = false;
        skillModeSwitchBtn.hidden = true;
        skillCreationMode = '';
      });
    }
    agentsTabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        setAgentsTab(button.dataset.agentsTab || 'content');
      });
    });
    if (agentsPreview) {
      agentsPreview.addEventListener('click', () => {
        openAgentsEditor();
      });
      agentsPreview.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openAgentsEditor();
        }
      });
    }
    if (agentsEditorInline) {
      agentsEditorInline.addEventListener('input', syncAgentsEditorUI);
      agentsEditorInline.addEventListener('blur', () => {
        window.setTimeout(() => maybeCloseAgentsEditorOnBlur(), 0);
      });
    }
    if (agentsVersionsBody) {
      agentsVersionsBody.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('button[data-action]');
        if (!btn) return;
        const action = btn.getAttribute('data-action');
        const versionId = btn.getAttribute('data-version-id');
        if (!versionId) return;
        if (action === 'agents-restore') {
          restoreAgentsVersion(versionId);
        } else if (action === 'agents-delete') {
          deleteAgentsVersion(versionId);
        }
      });
    }
    if (seedCodexAuthBtn) {
      seedCodexAuthBtn.addEventListener('click', () => showUploadModal(true, 'codex'));
    }
    if (seedClaudeAuthBtn) {
      seedClaudeAuthBtn.addEventListener('click', () => showUploadModal(true, 'claude'));
    }
    if (seedUploadBtn) {
      seedUploadBtn.addEventListener('click', () => {
        // Capture the chosen seed engine so submitAuthUpload can include it
        // in /admin/auth/upload POST. Defaults to codex for back-compat.
        const selectedEngineRadio = document.querySelector('input[name="seedEngine"]:checked');
        setSeedEngine(selectedEngineRadio?.value);
        showSeedModal(false);
        showUploadModal(true, seedSelectedEngine);
      });
    }
    if (seedDismissBtn) {
      seedDismissBtn.addEventListener('click', () => showSeedModal(false));
    }
    if (cancelNewHostBtn) {
      cancelNewHostBtn.addEventListener('click', () => showNewHostModal(false));
    }
    if (newHostForm) {
      newHostForm.addEventListener('submit', (event) => {
        event.preventDefault();
        createHost();
      });
    } else if (createHostBtn) {
      createHostBtn.addEventListener('click', createHost);
    }
    if (closeNewHostSuccessBtn) {
      closeNewHostSuccessBtn.addEventListener('click', () => showNewHostModal(false));
    }
    if (createAnotherHostBtn) {
      createAnotherHostBtn.addEventListener('click', () => showNewHostModal(true, { reset: true, focusInput: true }));
    }
    if (deleteAccidentalHostBtn) {
      deleteAccidentalHostBtn.addEventListener('click', () => {
        if (!newHostSuccessCanDelete || !newHostSuccessHostId) return;
        openDeleteModal(newHostSuccessHostId);
      });
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
    if (quickVmModal) {
      quickVmModal.addEventListener('click', (e) => {
        if (e.target === quickVmModal) showQuickVmModal(false);
      });
    }
    if (seedModal) {
      seedModal.addEventListener('click', (e) => {
        if (e.target === seedModal) showSeedModal(false);
      });
    }
    if (hostSearchModal) {
      hostSearchModal.addEventListener('click', (event) => {
        if (event.target === hostSearchModal) showHostSearchModal(false);
      });
    }
    if (hostSearchClose) {
      hostSearchClose.addEventListener('click', () => showHostSearchModal(false));
    }
    if (hostSearchInput) {
      hostSearchInput.addEventListener('input', () => {
        hostSearchSelectedIndex = 0;
        renderHostSearchResults(hostSearchInput.value);
      });
      hostSearchInput.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          syncHostSearchSelection(hostSearchSelectedIndex + 1);
          renderHostSearchResults(hostSearchInput.value);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          syncHostSearchSelection(hostSearchSelectedIndex - 1);
          renderHostSearchResults(hostSearchInput.value);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          openSelectedHostSearchResult();
        }
      });
    }
    if (hostSearchResults) {
      hostSearchResults.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-host-id]') : null;
        if (!(button instanceof HTMLElement)) return;
        const hostId = Number(button.dataset.hostId || 0);
        if (!Number.isFinite(hostId) || hostId <= 0) return;
        showHostSearchModal(false);
        openHostDetail(hostId);
      });
      hostSearchResults.addEventListener('mousemove', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-host-search-index]') : null;
        if (!(button instanceof HTMLElement)) return;
        const nextIndex = Number(button.dataset.hostSearchIndex || 0);
        if (!Number.isFinite(nextIndex) || nextIndex === hostSearchSelectedIndex) return;
        syncHostSearchSelection(nextIndex);
        renderHostSearchResults(hostSearchInput?.value || '');
      });
    }
    if (skillAssistSend) {
      skillAssistSend.addEventListener('click', () => assistSkillDraft());
    }
    if (skillSave) {
      skillSave.addEventListener('click', () => saveSkill());
    }
    if (skillDelete) {
      skillDelete.addEventListener('click', () => {
        const slug = (skillEditingSlug || skillSlug?.value || '').trim();
        deleteSkill(slug, { fromDetail: true });
      });
    }
    skillFieldEditButtons.forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        unlockSkillField(btn.getAttribute('data-skill-unlock') || '');
      });
    });
    if (skillSlug) {
      skillSlug.addEventListener('input', () => {
        setSkillDirty(true);
      });
    }
    [skillNameInput, skillDescriptionInput, skillWhatInput, skillWhenInput, skillStepsInput].forEach((input) => {
      if (!input) return;
      input.addEventListener('input', () => {
        setSkillDirty(true);
      });
    });
    if (skillAssistInput) {
      skillAssistInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          assistSkillDraft();
        }
      });
      skillAssistInput.addEventListener('input', autoResizeSkillInput);
    }
    if (skillTagsInput) {
      skillTagsInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          commitSkillTagInput();
        } else if (event.key === 'Backspace' && !skillTagsInput.value) {
          removeSkillTag(skillTags.length - 1);
          setSkillDirty(true);
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
    const modalCloseMap = new Map([
      [helpModal,             () => closeHelpModal()],
      [hostSearchModal,       () => showHostSearchModal(false)],
      [newHostModal,          () => showNewHostModal(false)],
      [quickVmModal,          () => showQuickVmModal(false)],
      [uploadModal,           () => showUploadModal(false)],
      [insecureHostsModal,    () => closeInsecureHostsModal()],
      [deleteHostModal,       () => closeDeleteModal()],
      [runnerModal,           () => showRunnerModal(false)],
      [claudeRunnerModal,     () => showClaudeRunnerModal(false)],
      [upgradeModal,          () => showUpgradeNotesModal(false)],
      [usageHistoryModal,     () => showUsageHistoryModal(false)],
      [seedModal,             () => showSeedModal(false)],
      [insecureApprovalModal, () => denyInsecureApproval()],
      [confirmModal,          () => closeConfirmModal(false)],
      [document.getElementById('apiRefModalBackdrop'), () => {
        const bd = document.getElementById('apiRefModalBackdrop');
        if (bd) bd.classList.remove('show');
      }],
    ]);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelector('.modal-backdrop.show');
      if (!open) return;
      const closeFn = modalCloseMap.get(open);
      if (closeFn) { e.preventDefault(); closeFn(); }
    });
    document.addEventListener('keydown', handleGlobalShortcut);
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
    if (scalingToggle) {
      scalingToggle.addEventListener('change', () => {
        const rollbackState = cloneScalingDataState();
        if (!scalingData) scalingData = { enabled: false, rules: null };
        scalingData.enabled = scalingToggle.checked;
        ensureScalingRulesState(scalingToggle.checked);
        renderScaling();
        saveScalingRules({
          sourceEl: scalingToggle,
          successMessage: scalingToggle.checked ? 'Usage scaling enabled' : 'Usage scaling disabled',
          rollbackState,
        });
      });
    }
    if (scalingAddTier) {
      scalingAddTier.addEventListener('click', () => {
        ensureScalingRulesState(false);
        scalingData.rules.tiers.push(defaultScalingTier(scalingData.rules.tiers.length));
        renderScalingTiers();
      });
    }
    if (scalingSave) {
      scalingSave.addEventListener('click', () => saveScalingRules({ sourceEl: scalingSave }));
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
          const queued = enqueueInsecureApproval({
            id: requestId,
            hostId: Number(detail.payload?.host_id || details.host_id || 0),
            fqdn: details.fqdn || '',
            requestedAt: details.requested_at || detail.payload?.created_at || null,
            createdAt: detail.payload?.created_at || null,
            command: details.command || '',
          });
          if (queued) {
            ringInsecureApprovalBell();
          }
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
    window.addEventListener('admin-ws-status', (event) => {
      const status = String(event?.detail?.status || '');
      if (status === 'open') {
        loadPendingInsecureApprovals();
        if (isHostDetailView() && activeHostId && !hostDetailSupportLoaded && !hostDetailSupportPromise) {
          ensureHostDetailSupportLoaded().catch((err) => {
            console.warn('Host detail live support refresh failed', err);
          });
        }
      }
    });
    loadApiState();
    loadCdxSilent();
    loadReverseDns();
    loadInsecureApproval();
    loadPendingInsecureApprovals();
    loadAutoUpdate();

    function wireNavShortcuts() {
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
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    }

    wireNavShortcuts();
    applyQueryParams();
    applyRouting(); // ensure deep links after query param normalization

    function resetNewHostForm({ focusInput = false } = {}) {
      if (newHostError) { newHostError.textContent = ''; newHostError.classList.remove('show'); }
      setNewHostModalStage('form');
      if (commandField) {
        commandField.style.display = 'none';
      }
      if (installerMeta) {
        installerMeta.style.display = 'none';
        installerMeta.textContent = '';
      }
      if (newHostClipboardStatus) {
        newHostClipboardStatus.textContent = 'Copied to clipboard. Paste it into the new box and let it rip.';
      }
      newHostSuccessHostId = null;
      newHostSuccessCanDelete = false;
      if (deleteAccidentalHostBtn) {
        deleteAccidentalHostBtn.hidden = true;
      }
      if (bootstrapCmdEl) {
        bootstrapCmdEl.textContent = '';
      }
      if (copyCmdBtn) {
        copyCmdBtn.textContent = 'Copy Again';
        copyCmdBtn.disabled = false;
        copyCmdBtn.onclick = null;
      }
      if (newHostSuccessKicker) {
        newHostSuccessKicker.textContent = 'Host created. Clipboard warm.';
      }
      if (newHostSuccessTitle) {
        newHostSuccessTitle.textContent = 'Installer Ready';
      }
      if (newHostSuccessCopy) {
        newHostSuccessCopy.textContent = 'The installer command is ready and already copied to your clipboard.';
      }
      if (newHostSuccessChips) {
        newHostSuccessChips.replaceChildren();
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
      if (vipToggle) {
        vipToggle.checked = false;
      }
    }

    function setNewHostModalStage(stage) {
      const showSuccess = stage === 'success';
      if (newHostFormStage) {
        newHostFormStage.hidden = showSuccess;
      }
      if (newHostSuccessStage) {
        newHostSuccessStage.hidden = !showSuccess;
      }
      if (newHostDialog) {
        newHostDialog.classList.toggle('is-success', showSuccess);
      }
    }

    function showNewHostModal(show, { reset = show, focusInput = reset } = {}) {
      if (!newHostModal) return;
      if (show) {
        newHostModal.classList.add('show');
        setInertBehindModal(newHostModal, true);
        if (reset) resetNewHostForm({ focusInput });
      } else {
        newHostModal.classList.remove('show');
        setInertBehindModal(newHostModal, false);
        if (reset) resetNewHostForm();
      }
    }

    function renderNewHostSuccessChips({ fqdn, secure, temporary, insecureCurl, vip, engines }) {
      if (!newHostSuccessChips) return;
      const chips = [
        { label: fqdn, tone: 'pro' },
        { label: secure ? 'Secure' : 'Insecure', tone: secure ? 'ok' : 'warn' },
        { label: temporary ? 'Temporary' : 'Persistent', tone: temporary ? 'warn' : 'neutral' },
      ];
      if (insecureCurl) {
        chips.push({ label: 'curl -k', tone: 'warn' });
      }
      if (vip) {
        chips.push({ label: 'VIP', tone: 'pro' });
      }
      const engineList = parseEngines(engines);
      if (engineList.includes('codex')) chips.push({ label: 'CDX', tone: 'ok' });
      if (engineList.includes('claude')) chips.push({ label: 'CLX', tone: 'pro' });
      newHostSuccessChips.replaceChildren();
      chips.forEach(({ label, tone }) => {
        const chip = document.createElement('span');
        chip.className = `chip ${tone}`;
        chip.textContent = label;
        newHostSuccessChips.appendChild(chip);
      });
    }

    async function copyInstallerCommand(cmd, { auto = false } = {}) {
      if (!cmd) return false;
      const previous = copyCmdBtn?.textContent || 'Copy Again';
      if (copyCmdBtn) {
        copyCmdBtn.disabled = true;
        copyCmdBtn.textContent = auto ? 'Copying…' : 'Copying…';
      }
      try {
        await copyToClipboard(cmd);
        if (newHostClipboardStatus) {
          newHostClipboardStatus.textContent = auto
            ? 'Copied to clipboard. Paste it into the new box and let it rip.'
            : 'Copied again. Paste it where the fresh box can hear you.';
        }
        if (copyCmdBtn) {
          copyCmdBtn.textContent = 'Copied';
        }
        return true;
      } catch (error) {
        if (newHostClipboardStatus) {
          newHostClipboardStatus.textContent = auto
            ? 'Clipboard access was blocked. The installer curl is ready below, and Copy Again will retry.'
            : 'Clipboard access was blocked. Copy it manually from the field below.';
        }
        if (copyCmdBtn) {
          copyCmdBtn.textContent = 'Copy Failed';
        }
        return false;
      } finally {
        window.setTimeout(() => {
          if (copyCmdBtn) {
            copyCmdBtn.textContent = previous;
            copyCmdBtn.disabled = false;
          }
        }, 900);
      }
    }

    function normalizeSeedEngine(engine) {
      return engine === 'claude' ? 'claude' : 'codex';
    }

    function setSeedEngine(engine) {
      seedSelectedEngine = normalizeSeedEngine(engine);
      const codexRadio = document.getElementById('seedEngineCodex');
      const claudeRadio = document.getElementById('seedEngineClaude');
      if (codexRadio) codexRadio.checked = seedSelectedEngine === 'codex';
      if (claudeRadio) claudeRadio.checked = seedSelectedEngine === 'claude';

      const isClaude = seedSelectedEngine === 'claude';
      if (uploadAuthTitle) {
        uploadAuthTitle.textContent = isClaude ? 'Seed Claude credentials' : 'Seed Codex credentials';
      }
      if (uploadAuthIntro) {
        uploadAuthIntro.textContent = isClaude
          ? 'Paste or choose Claude credentials; they will be validated via the Claude runner and stored as canonical.'
          : 'Paste or choose Codex auth.json; it will be validated via the runner and stored as canonical.';
      }
      if (uploadAuthPayloadLabel) {
        uploadAuthPayloadLabel.textContent = isClaude ? 'Claude credentials.json' : 'Codex auth.json';
      }
      if (uploadAuthText) {
        uploadAuthText.placeholder = isClaude
          ? '{"api_key":"...","last_refresh":"..."}'
          : '{"last_refresh":"...","auths":{...}}';
      }
    }

    function showUploadModal(show, engine = null) {
      if (!uploadModal) return;
      if (show) {
        setSeedEngine(engine || seedSelectedEngine);
        uploadModal.classList.add('show');
        setInertBehindModal(uploadModal, true);
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
        setInertBehindModal(uploadModal, false);
      }
    }

    async function createHost() {
      const fqdn = newHostName?.value.trim() || '';
      if (!fqdn) {
        if (newHostError) { newHostError.textContent = 'Please enter a host name'; newHostError.classList.add('show'); }
        newHostName?.focus();
        return;
      }
      const hasCodex = engineCodexToggle ? engineCodexToggle.checked : true;
      const hasClaude = engineClaudeToggle ? engineClaudeToggle.checked : false;
      if (!hasCodex && !hasClaude) {
        if (newHostEngineError) { newHostEngineError.textContent = 'Select at least one engine'; newHostEngineError.classList.add('show'); }
        return;
      }
      if (newHostEngineError) { newHostEngineError.textContent = ''; newHostEngineError.classList.remove('show'); }
      await regenerateInstaller(fqdn);
    }

    async function createQuickVm(enginesRaw, triggerButton = null) {
      const engines = parseEngines(enginesRaw);
      if (!engines.length) {
        toast('Select at least one engine for Quick VM.', 'error');
        return;
      }
      const previousText = triggerButton?.textContent || '';
      if (triggerButton) {
        triggerButton.disabled = true;
        triggerButton.textContent = 'Minting…';
      }
      try {
        const res = await api('/admin/hosts/quick-register', {
          method: 'POST',
          json: {
            engines,
            duration_minutes: insecureWindowMinutes,
          },
        });
        const installer = res.data?.installer;
        const hostResponse = res.data?.host || {};
        if (!installer || !installer.command) throw new Error('Missing installer command in response');

        const targetFqdn = hostResponse.fqdn || 'tmp-host';
        const enginesValue = engines.join(',');
        const installerMode = normalizeInstallerMode(installer.mode, enginesValue);
        const installerLabel = installerModeLabel(installerMode);
        const installerCommandCopy = installerCommandLabel(installerMode);
        const cmd = installer.command;

        if (bootstrapCmdEl) bootstrapCmdEl.textContent = cmd;
        if (commandField) commandField.style.display = 'block';
        if (copyCmdBtn) {
          copyCmdBtn.textContent = 'Copy Again';
          copyCmdBtn.onclick = () => copyInstallerCommand(cmd);
        }
        if (installerMeta) {
          const expires = installer.expires_at ? formatRelative(installer.expires_at) : null;
          installerMeta.textContent = expires
            ? `${installerLabel} Quick VM installer (expires ${expires}).`
            : `${installerLabel} Quick VM installer ready.`;
          installerMeta.style.display = 'block';
        }

        const responseHostId = Number(hostResponse?.id || 0);
        newHostSuccessHostId = Number.isFinite(responseHostId) && responseHostId > 0 ? responseHostId : null;
        newHostSuccessCanDelete = newHostSuccessHostId !== null;
        if (deleteAccidentalHostBtn) {
          deleteAccidentalHostBtn.hidden = !newHostSuccessCanDelete;
        }
        if (newHostSuccessKicker) {
          newHostSuccessKicker.textContent = `${installerLabel} Quick VM ready. Clipboard warm.`;
        }
        if (newHostSuccessTitle) {
          newHostSuccessTitle.textContent = 'Temporary Host Ready';
        }
        if (newHostSuccessCopy) {
          newHostSuccessCopy.textContent = `${targetFqdn} is registered as an insecure temporary host. The ${installerCommandCopy} is copied and ready.`;
        }
        renderNewHostSuccessChips({
          fqdn: targetFqdn,
          secure: false,
          temporary: true,
          insecureCurl: false,
          vip: false,
          engines: enginesValue,
        });
        if (newHostName) {
          newHostName.value = targetFqdn;
        }
        showQuickVmModal(false);
        setNewHostModalStage('success');
        showNewHostModal(true, { reset: false });
        await copyInstallerCommand(cmd, { auto: true });
        loadAll().catch((error) => {
          console.warn('Dashboard refresh after quick VM mint failed', error);
        });
      } catch (err) {
        const msg = err?.message || String(err);
        toast(`Quick VM generation failed: ${msg}`, 'error');
      } finally {
        if (triggerButton) {
          triggerButton.disabled = false;
          triggerButton.textContent = previousText;
        }
      }
    }

    async function regenerateInstaller(fqdn, hostId = null, engineOverride = null) {
      const targetFqdn = fqdn || newHostName.value.trim();
      if (!targetFqdn) {
        if (newHostError) { newHostError.textContent = 'Please enter a host name'; newHostError.classList.add('show'); }
        newHostName?.focus();
        return;
      }
      const existingHost = hostId ? getHostById(hostId) : null;
      if (secureHostToggle && existingHost) {
        secureHostToggle.checked = isHostSecure(existingHost);
      }
      if (temporaryHostToggle && existingHost) {
        temporaryHostToggle.checked = !!existingHost.expires_at;
      }
      if (insecureToggle && existingHost) {
        insecureToggle.checked = !!existingHost.curl_insecure;
      }
      if (vipToggle && existingHost) {
        vipToggle.checked = !!existingHost.vip;
      }
      if (existingHost) {
        const existingEngines = parseEngines(existingHost.engines);
        const selectedEngines = Array.isArray(engineOverride) && engineOverride.length
          ? engineOverride
          : existingEngines;
        if (engineCodexToggle) engineCodexToggle.checked = selectedEngines.includes('codex');
        if (engineClaudeToggle) engineClaudeToggle.checked = selectedEngines.includes('claude');
      }
      const secure = secureHostToggle ? secureHostToggle.checked : true;
      const vip = vipToggle ? vipToggle.checked : false;
      const temporary = temporaryHostToggle ? temporaryHostToggle.checked : false;
      const engines = buildEnginesValue();
      const registerPayload = {
        fqdn: targetFqdn,
        host_id: hostId ?? undefined,
        secure,
        vip,
        temporary: !!temporary,
        engines,
        curl_insecure: insecureToggle ? !!insecureToggle.checked : undefined,
      };
      if (!secure) {
        registerPayload.duration_minutes = insecureWindowMinutes;
      }
      if (createHostBtn) {
      createHostBtn.disabled = true;
      createHostBtn.textContent = 'Minting…';
    }
      try {
        const res = await api('/admin/hosts/register', {
          method: 'POST',
          json: registerPayload,
        });
        const installer = res.data?.installer;
        if (!installer || !installer.command) throw new Error('Missing installer command in response');
        const installerMode = normalizeInstallerMode(installer.mode, engines);
        const installerLabel = installerModeLabel(installerMode);
        const installerCommandCopy = installerCommandLabel(installerMode);
        let cmd = installer.command;
        if (insecureToggle?.checked) {
          cmd = addCurlFlag(cmd, '-k');
          cmd = addBashEnv(cmd, 'CODEX_INSTALL_CURL_INSECURE=1');
        }
        bootstrapCmdEl.textContent = cmd;
        commandField.style.display = 'block';
        if (copyCmdBtn) {
          copyCmdBtn.textContent = 'Copy Again';
          copyCmdBtn.onclick = () => copyInstallerCommand(cmd);
        }
        if (installerMeta) {
          const expires = installer.expires_at ? formatRelative(installer.expires_at) : null;
          installerMeta.textContent = expires
            ? `${installerLabel} installer (expires ${expires}).`
            : `${installerLabel} installer ready.`;
          installerMeta.style.display = 'block';
        }
        const hostResponse = res.data?.host || null;
        const responseHostId = Number(hostResponse?.id || hostId || 0);
        const created = !existingHost;
        newHostSuccessHostId = Number.isFinite(responseHostId) && responseHostId > 0 ? responseHostId : null;
        newHostSuccessCanDelete = created && newHostSuccessHostId !== null;
        if (deleteAccidentalHostBtn) {
          deleteAccidentalHostBtn.hidden = !newHostSuccessCanDelete;
        }
        if (newHostSuccessKicker) {
          newHostSuccessKicker.textContent = created
            ? `${installerLabel} ready. Clipboard warm.`
            : `${installerLabel} refreshed. Clipboard warm.`;
        }
        if (newHostSuccessTitle) {
          newHostSuccessTitle.textContent = created
            ? `${installerLabel} Host Ready`
            : `Fresh ${installerLabel} Installer Ready`;
        }
        if (newHostSuccessCopy) {
          newHostSuccessCopy.textContent = created
            ? `${targetFqdn} is registered. The ${installerCommandCopy} is already copied, so you can paste it straight onto the new host.`
            : `${targetFqdn} already exists. A fresh ${installerCommandCopy} is copied and ready for the next run.`;
        }
        renderNewHostSuccessChips({
          fqdn: targetFqdn,
          secure,
          temporary: !!temporary,
          insecureCurl: insecureToggle ? !!insecureToggle.checked : false,
          vip,
          engines,
        });
        setNewHostModalStage('success');
        if (newHostName) {
          newHostName.value = targetFqdn;
        }
        showNewHostModal(true, { reset: false });
        await copyInstallerCommand(cmd, { auto: true });
        loadAll().catch((error) => {
          console.warn('Dashboard refresh after installer mint failed', error);
        });
      } catch (err) {
        const msg = err?.message || String(err);
        toast(`Installer generation failed: ${msg}`, 'error');
      } finally {
        if (createHostBtn) {
          createHostBtn.disabled = false;
          createHostBtn.textContent = 'Mint Installer';
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
        toast('Paste auth.json or choose a file first', 'warn');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        toast(`Invalid JSON: ${err.message}`, 'error');
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
          json: {
            auth: parsed,
            host_id: hostId || undefined,
            engine: seedSelectedEngine === 'claude' ? 'claude' : 'codex',
          },
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
        toast(`Upload failed: ${err.message}`, 'error');
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
        const engine = normalizeSeedEngine(seedSelectedEngine);
        const res = await api('/admin/auth/seed-command', { method: 'POST', json: { engine } });
        const data = res.data || {};
        const cmd = data.command || '';
        if (seedCommandText) seedCommandText.textContent = cmd || 'No command returned.';
        if (seedCommandField) seedCommandField.style.display = cmd ? 'flex' : 'none';
        if (seedCommandCopy) {
          seedCommandCopy.onclick = () => copyToClipboard(cmd || '');
        }
        if (seedCommandMeta) {
          const expiresAt = data.expires_at || '';
          const engineLabel = engine === 'claude' ? 'Claude' : 'Codex';
          seedCommandMeta.textContent = expiresAt
            ? `${engineLabel}. Expires ${formatRelativeWithTimestamp(expiresAt)}. One-time use.`
            : `${engineLabel}. One-time use.`;
          seedCommandMeta.style.display = 'block';
        }
        if (cmd) toast('Seed command ready.', 'ok');
      } catch (err) {
        toast(`Seed command failed: ${err.message}`, 'error');
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
      setInertBehindModal(deleteHostModal, true);
    }

    function closeDeleteModal() {
      deleteHostModal?.classList.remove('show');
      setInertBehindModal(deleteHostModal, false);
      pendingDeleteId = null;
    }

    async function confirmRemove() {
      if (pendingDeleteId === null) return;
      const deletedFromNewHostSuccess = newHostSuccessCanDelete && newHostSuccessHostId === pendingDeleteId;
      const btn = confirmDeleteHostBtn;
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Removing…';
      }
      try {
        await api(`/admin/hosts/${pendingDeleteId}`, { method: 'DELETE' });
        await reloadHostContextAfterMutation({ allowMissing: true });
        closeDeleteModal();
        if (deletedFromNewHostSuccess) {
          showNewHostModal(false);
        }
      } catch (err) {
        toast(`Remove failed: ${err.message}`, 'error');
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
        await reloadHostContextAfterMutation();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function toggleRoaming(id, allowState = null) {
      const host = currentHosts.find(h => h.id === id);
      if (!host) {
        toast('Host not found', 'warn');
        return;
      }
      const targetState = typeof allowState === 'boolean' ? allowState : !host.allow_roaming_ips;
      try {
        await api(`/admin/hosts/${id}/roaming`, {
          method: 'POST',
          json: { allow: targetState },
        });
        await reloadHostContextAfterMutation();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function toggleSecurity(id, secureState = null) {
      const host = currentHosts.find(h => h.id === id);
      if (!host) {
        toast('Host not found', 'warn');
        return;
      }
      const targetSecure = typeof secureState === 'boolean' ? secureState : !isHostSecure(host);
      try {
        await api(`/admin/hosts/${id}/secure`, {
          method: 'POST',
          json: { secure: targetSecure },
        });
        await reloadHostContextAfterMutation();
      } catch (err) {
        toast(err.message, 'error');
      }
    }

    async function toggleVip(host, button = null, desiredState = null) {
      if (!host) {
        toast('Host not found', 'warn');
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
        await reloadHostContextAfterMutation();
      } catch (err) {
        toast(err.message, 'error');
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
        await reloadHostContextAfterMutation();
      } catch (err) {
        toast(err.message, 'error');
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
        await reloadHostContextAfterMutation();
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
