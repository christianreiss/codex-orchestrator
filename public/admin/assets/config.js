(() => {
  // DOM refs are resolved lazily so the builder can live inside the SPA and only bind when the tab is visible.
  let statusEl;
  let shaEl;
  let updatedEl;
  let previewEl;
  let previewMetaEl;

  let modelInput;
  let modelProviderInput;
  let localProviderInput;
  let personalityInput;
  let approvalPolicyInput;
  let sandboxModeInput;
  let reasoningEffortInput;
  let reasoningSummaryInput;
  let verbosityInput;
  let contextWindowInput;
  let maxTokensInput;
  let supportsSummariesInput;
  let notifyInput;

  let featureFastMode;
  let featureUnifiedExec;
  let featureWebSearch;
  let featureVoiceTranscription;
  let featureApps;
  let featureGuardianApproval;
  let featureJsRepl;
  let featureBubblewrapSandbox;
  let featurePreventIdleSleep;
  let featureMultiAgent;
  let dangerousBypassApprovalsSandbox;
  let extraFeaturesInput;

  let sandboxNetwork;
  let sandboxTmpdir;
  let sandboxSlashTmp;
  let writableRootsInput;
  let envInheritInput;
  let envIncludeInput;
  let envExcludeInput;
  let envSetInput;
  let ignoreDefaultExcludesInput;

  let preservedProfiles = [];
  let mcpRows;
  let mcpAccordion;
  let mcpCount;
  let orchestratorMcpToggle;
  let orchestratorMcpSummaryWrap;
  let orchestratorMcpSummary;

  let otelExporterInput;
  let otelEndpointInput;
  let otelProtocolInput;
  let otelHeadersInput;
  let otelLogPromptsInput;

  let customTomlInput;

  let saveBtn;
  let renderBtn;
  let copyBtn;
  let addMcpBtn;

  let sectionSearchInput;
  let sectionsWrap;

  let lastRenderedSha = '';
  let lastRenderedSize = 0;
  let lastSavedSha = '';
  let configDirty = false;
  let configRemotePending = false;
  let configReloadTimer = null;
  let configReloadInFlight = false;
  let configReloadQueued = false;

  const MODEL_REASONING = {
    'gpt-5.4': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.3-codex': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.3-codex-spark': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.2-codex': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.2': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex-max': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex-mini': ['', 'medium', 'high'],
  };
  const SUPPORTED_MODELS = Object.keys(MODEL_REASONING);

  function isSparkCodexModel(model) {
    const lower = String(model || '').toLowerCase();
    return lower.includes('codex-spark');
  }

  function isDetailedOnlyCodexModel(model) {
    const lower = String(model || '').toLowerCase();
    return lower.startsWith('gpt-5.1-codex')
      || lower.startsWith('gpt-5.2-codex')
      || lower === 'gpt-5.3-codex';
  }

  function clampReasoningSummaryForModel(model) {
    if (!reasoningSummaryInput) return;
    const spark = isSparkCodexModel(model);
    const detailedOnly = isDetailedOnlyCodexModel(model);
    const options = Array.from(reasoningSummaryInput.options || []);
    options.forEach((opt) => {
      const value = String(opt.value || '').toLowerCase();
      if (!value) return;
      if (spark) {
        opt.disabled = true;
        return;
      }
      if (!detailedOnly) {
        opt.disabled = false;
        return;
      }
      if (value === 'detailed') {
        opt.disabled = false;
        return;
      }
      opt.disabled = value === 'auto' || value === 'concise';
    });

    const current = String(reasoningSummaryInput.value || '').trim().toLowerCase();
    if (spark) {
      reasoningSummaryInput.value = '';
      return;
    }
    if (detailedOnly && current !== '' && current !== 'detailed') {
      reasoningSummaryInput.value = 'detailed';
    }
  }

  function clampVerbosityForModel(model) {
    if (!verbosityInput) return;
    const lowerModel = String(model || '').toLowerCase();
    const codexMax = lowerModel === 'gpt-5.1-codex-max';
    const allowed = codexMax ? ['', 'medium'] : ['', 'low', 'medium', 'high'];
    const options = Array.from(verbosityInput.options || []);
    options.forEach((opt) => {
      const value = String(opt.value || '').toLowerCase();
      opt.disabled = !allowed.includes(value);
    });
    const current = String(verbosityInput.value || '').toLowerCase();
    if (!allowed.includes(current)) {
      verbosityInput.value = 'medium';
    }
  }

  function defaultSettings() {
    return {
      model: 'gpt-5.4',
      model_provider: '',
      local_provider: '',
      personality: 'friendly',
      approval_policy: 'on-request',
      sandbox_mode: 'read-only',
      security: {
        dangerously_bypass_approvals_and_sandbox: false,
      },
      web_search: 'disabled',
      model_reasoning_effort: 'medium',
      model_reasoning_summary: 'detailed',
      model_verbosity: 'low',
      model_supports_reasoning_summaries: false,
      model_context_window: null,
      model_max_output_tokens: null,
      features: {
        fast_mode: true,
        unified_exec: false,
        voice_transcription: false,
        apps: true,
        guardian_approval: false,
        js_repl: false,
        use_linux_sandbox_bwrap: false,
        prevent_idle_sleep: false,
        multi_agent: true,
      },
      notice: {
        'hide_gpt5_1_migration_prompt': true,
        'hide_gpt-5.1-codex-max_migration_prompt': true,
        'hide_rate_limit_model_nudge': true,
        'model_migrations': {
          'gpt-5.2-codex': 'gpt-5.3-codex',
          'gpt-5.3-codex': 'gpt-5.4',
        },
      },
      sandbox_workspace_write: {
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
        writable_roots: [],
      },
      shell_environment_policy: {
        inherit: '',
        include_only: [],
        exclude: [],
        set: {},
        ignore_default_excludes: false,
      },
      profiles: [],
      mcp_servers: [],
      orchestrator_mcp_enabled: true,
      otel: {
        environment: '',
        exporter: 'none',
        endpoint: '',
        protocol: '',
        headers: {},
        log_user_prompt: false,
      },
      notify: [],
      custom_toml: '',
    };
  }

  function setSelectValue(selectEl, value, options = {}) {
    if (!selectEl) return;
    const { allowUnknown = true } = options;
    const val = value || '';
    const selectOptions = Array.from(selectEl.options || []);
    const exists = selectOptions.some((opt) => opt.value === val);
    if (!exists && val !== '' && allowUnknown) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      selectEl.appendChild(opt);
    }
    if (exists || (val !== '' && allowUnknown)) {
      selectEl.value = val;
      return;
    }
    selectEl.value = '';
  }

  function reasoningLabel(optVal) {
    if (optVal === '') return '—';
    if (optVal === 'xhigh') return 'xhigh (Extra high)';
    return optVal;
  }

  function rebuildReasoningOptions(model, currentValue) {
    if (!reasoningEffortInput) return;
    const allowed = MODEL_REASONING[model] || [''];
    reasoningEffortInput.innerHTML = '';
    allowed.forEach((optVal) => {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = reasoningLabel(optVal);
      reasoningEffortInput.appendChild(opt);
    });
    setReasoningValue(currentValue);
  }

  function setReasoningValue(value) {
    if (!reasoningEffortInput) return;
    const val = value || '';
    const options = Array.from(reasoningEffortInput.options || []);
    const allowed = options.some((opt) => opt.value === val);
    reasoningEffortInput.value = allowed ? val : '';
  }

  function normalizeString(value) {
    return String(value || '').toLowerCase().trim();
  }

  function ensureConfigSections() {
    sectionSearchInput = document.getElementById('configSectionSearch');
    sectionsWrap = document.getElementById('configSections');
    if (!sectionsWrap) return;

    const buttons = Array.from(sectionsWrap.querySelectorAll('[data-config-section]'));
    const cards = Array.from(document.querySelectorAll('[data-settings-panel="config"] [data-config-card]'));

    const activate = (section) => {
      const key = normalizeString(section);
      buttons.forEach((btn) => btn.classList.toggle('is-active', normalizeString(btn.dataset.configSection) === key));
      cards.forEach((card) => {
        const cardKey = normalizeString(card.dataset.configCard);
        card.hidden = cardKey !== key;
      });
    };

    buttons.forEach((btn) => {
      btn.addEventListener('click', () => activate(btn.dataset.configSection));
    });

    activate('model');

    if (sectionSearchInput) {
      sectionSearchInput.addEventListener('input', () => {
        const q = normalizeString(sectionSearchInput.value);
        if (!q) return;

        const match = cards.find((card) => {
          const title = normalizeString(card.dataset.configTitle);
          return title.includes(q) || normalizeString(card.textContent).includes(q);
        });
        if (match) activate(match.dataset.configCard);
      });
    }
  }

  function deepMerge(base, patch) {
    const output = Array.isArray(base) ? [...base] : { ...base };
    if (!patch || typeof patch !== 'object') return output;
    Object.entries(patch).forEach(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof base[key] === 'object' && !Array.isArray(base[key])) {
        output[key] = deepMerge(base[key], value);
      } else {
        output[key] = value;
      }
    });
    return output;
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    const normalized = String(value).replace(/\.(\d{3})\d*(Z?)/, '.$1$2');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return value;
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${yy}, ${hh}:${min}`;
  }

  function parseList(value) {
    if (!value) return [];
    return value
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  function coerceValue(str) {
    const trimmed = str.trim();
    if (trimmed === '') return '';
    const lower = trimmed.toLowerCase();
    if (['true', 'false'].includes(lower)) return lower === 'true';
    if (!Number.isNaN(Number(trimmed)) && trimmed.match(/^-?\d+(\.\d+)?$/)) {
      return Number(trimmed);
    }
    return trimmed;
  }

  function parseKeyValue(text) {
    const out = {};
    const trimmed = (text || '').trim();
    if (!trimmed) return out;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch (_) {
        // fall through
      }
    }
    trimmed.split(/\r?\n/).forEach((line) => {
      const clean = line.trim();
      if (!clean) return;
      const eq = clean.indexOf('=');
      const key = eq === -1 ? clean : clean.slice(0, eq);
      const value = eq === -1 ? '' : clean.slice(eq + 1);
      const name = key.trim();
      if (!name) return;
      out[name] = coerceValue(value);
    });
    return out;
  }

  function parseArgs(text) {
    return parseList(text);
  }

  function numberOrNull(input) {
    if (!input) return null;
    const raw = typeof input === 'string' ? input.trim() : input;
    if (raw === '' || raw === null || raw === undefined) return null;
    const num = Number(raw);
    return Number.isFinite(num) ? num : null;
  }

  function clearRows(container) {
    if (!container) return;
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
  }

  // Built-in servers are injected per-host by the coordinator and should not be shown
  // as “Configured MCP servers” in the UI. Only show ADDED / other MCP servers.
  const MANAGED_MCP_NAMES = ['codex-memory', 'codex-orchestrator', 'cdx', 'codex-coordinator'];

  function renderMcpRow(data = {}) {
    if (!mcpRows) return;
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML = `
      <div class="inline-group">
        <div class="field"><label>Name</label><input type="text" class="mcp-name" placeholder="my-server" value="${data.name || ''}"></div>
        <div class="field"><label>Command</label><input type="text" class="mcp-command" placeholder="/usr/bin/mcp" value="${data.command || ''}"></div>
      </div>
      <div class="field">
        <label>Args</label>
        <textarea class="mcp-args" placeholder="--flag=value">${(data.args || []).join('\n')}</textarea>
      </div>
      <div class="row-actions">
        <button type="button" class="ghost tiny-btn remove-mcp">Remove</button>
      </div>
    `;
    row.querySelector('.mcp-name').value = data.name || '';
    row.querySelector('.mcp-command').value = data.command || '';
    row.querySelector('.mcp-args').value = (data.args || []).join('\n');
    const removeBtn = row.querySelector('.remove-mcp');
    removeBtn.addEventListener('click', () => { row.remove(); updateMcpVisibility(); });
    row.querySelectorAll('input, textarea').forEach((el) => {
      el.addEventListener('input', debouncedPreview);
      el.addEventListener('change', debouncedPreview);
    });
    mcpRows.appendChild(row);
    updateMcpVisibility();
  }

  function mapToText(map) {
    if (!map || typeof map !== 'object') return '';
    return Object.entries(map)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  }

  function collectSettings() {
    if (!modelInput) return defaultSettings();
    const base = defaultSettings();
    const features = {
      fast_mode: featureFastMode.checked,
      unified_exec: featureUnifiedExec.checked,
      voice_transcription: featureVoiceTranscription.checked,
      apps: featureApps ? featureApps.checked : true,
      guardian_approval: featureGuardianApproval ? featureGuardianApproval.checked : true,
      js_repl: featureJsRepl ? featureJsRepl.checked : true,
      use_linux_sandbox_bwrap: featureBubblewrapSandbox ? featureBubblewrapSandbox.checked : true,
      prevent_idle_sleep: featurePreventIdleSleep ? featurePreventIdleSleep.checked : true,
      multi_agent: featureMultiAgent ? featureMultiAgent.checked : true,
    };
    const extraFeatures = parseKeyValue(extraFeaturesInput.value);
    Object.assign(features, extraFeatures);

    const profiles = Array.isArray(preservedProfiles) ? preservedProfiles : [];

    const mcpServers = Array.from(mcpRows?.querySelectorAll('.mcp-row') || []).map((row) => {
      const name = row.querySelector('.mcp-name')?.value.trim() || '';
      const command = row.querySelector('.mcp-command')?.value.trim() || '';
      if (!name || !command) return null;
      return {
        name,
        command,
        args: parseArgs(row.querySelector('.mcp-args')?.value || ''),
      };
    }).filter(Boolean);

    const reasoningSummaryValue = (reasoningSummaryInput?.value ?? '').trim();

    return {
      ...base,
      model: modelInput.value.trim() || base.model,
      model_provider: modelProviderInput?.value.trim() || base.model_provider,
      local_provider: localProviderInput?.value.trim() || base.local_provider,
      personality: personalityInput?.value.trim() || base.personality,
      approval_policy: approvalPolicyInput.value.trim() || base.approval_policy,
      sandbox_mode: sandboxModeInput.value.trim() || base.sandbox_mode,
      security: {
        dangerously_bypass_approvals_and_sandbox: dangerousBypassApprovalsSandbox
          ? dangerousBypassApprovalsSandbox.checked
          : Boolean(base.security?.dangerously_bypass_approvals_and_sandbox),
      },
      model_reasoning_effort: reasoningEffortInput.value.trim() || base.model_reasoning_effort,
      web_search: (() => {
        const raw = (featureWebSearch?.value || base.web_search || 'disabled').trim().toLowerCase();
        return ['live', 'cached', 'disabled'].includes(raw) ? raw : 'disabled';
      })(),
      model_reasoning_summary: reasoningSummaryValue,
      model_verbosity: verbosityInput.value.trim() || base.model_verbosity,
      model_supports_reasoning_summaries: supportsSummariesInput.checked,
      model_context_window: numberOrNull(contextWindowInput.value),
      model_max_output_tokens: numberOrNull(maxTokensInput.value),
      notify: parseArgs(notifyInput.value),
      features,
      notice: base.notice,
      sandbox_workspace_write: {
        network_access: sandboxNetwork.checked,
        exclude_tmpdir_env_var: sandboxTmpdir.checked,
        exclude_slash_tmp: sandboxSlashTmp.checked,
        writable_roots: parseList(writableRootsInput.value),
      },
      shell_environment_policy: {
        inherit: envInheritInput.value.trim(),
        include_only: parseList(envIncludeInput.value),
        exclude: parseList(envExcludeInput.value),
        set: parseKeyValue(envSetInput.value),
        ignore_default_excludes: ignoreDefaultExcludesInput.checked,
      },
      profiles,
      mcp_servers: mcpServers,
      orchestrator_mcp_enabled: orchestratorMcpToggle ? orchestratorMcpToggle.checked : true,
      otel: {
        exporter: otelExporterInput.value.trim() || 'none',
        endpoint: otelEndpointInput.value.trim(),
        protocol: otelProtocolInput.value.trim(),
        headers: parseKeyValue(otelHeadersInput.value),
        log_user_prompt: otelLogPromptsInput.checked,
      },
      custom_toml: customTomlInput.value || '',
    };
  }

  function parseFeatureExtras(text) {
    return parseKeyValue(text);
  }

  function populateForm(settings) {
    if (!modelInput) return;
    const cfg = deepMerge(defaultSettings(), settings || {});
    preservedProfiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
    setSelectValue(modelInput, cfg.model || '', { allowUnknown: false });
    if (!SUPPORTED_MODELS.includes(modelInput.value)) {
      modelInput.value = defaultSettings().model;
    }
    setSelectValue(modelProviderInput, cfg.model_provider || '');
    setSelectValue(localProviderInput, cfg.local_provider || '');
    setSelectValue(personalityInput, cfg.personality || defaultSettings().personality, { allowUnknown: false });
    setSelectValue(approvalPolicyInput, cfg.approval_policy || '');
    setSelectValue(sandboxModeInput, cfg.sandbox_mode || '');
    if (dangerousBypassApprovalsSandbox) {
      dangerousBypassApprovalsSandbox.checked = Boolean(cfg.security?.dangerously_bypass_approvals_and_sandbox);
    }
    rebuildReasoningOptions(cfg.model || '', cfg.model_reasoning_effort || '');
    const summaryValue = (cfg.model_reasoning_summary || '').toLowerCase() === 'none' ? '' : (cfg.model_reasoning_summary || '');
    setSelectValue(reasoningSummaryInput, summaryValue);
    clampReasoningSummaryForModel(cfg.model || '');
    setSelectValue(verbosityInput, cfg.model_verbosity || '');
    clampVerbosityForModel(cfg.model || '');
    contextWindowInput.value = cfg.model_context_window ?? '';
    maxTokensInput.value = cfg.model_max_output_tokens ?? '';
    supportsSummariesInput.checked = Boolean(cfg.model_supports_reasoning_summaries);
    notifyInput.value = (cfg.notify || []).join('\n');

    featureFastMode.checked = cfg.features?.fast_mode !== false;
    featureUnifiedExec.checked = Boolean(cfg.features?.unified_exec);
    const legacyWebSearch = cfg.features?.web_search_request;
    const webSearchValue = typeof cfg.web_search === 'string'
      ? cfg.web_search
      : (typeof cfg.features?.web_search === 'string' ? cfg.features.web_search : (legacyWebSearch ? 'live' : 'disabled'));
    setSelectValue(featureWebSearch, webSearchValue || 'disabled');
    featureVoiceTranscription.checked = Boolean(cfg.features?.voice_transcription);
    if (featureApps) {
      featureApps.checked = cfg.features?.apps !== false;
    }
    if (featureGuardianApproval) {
      featureGuardianApproval.checked = cfg.features?.guardian_approval !== false;
    }
    if (featureJsRepl) {
      featureJsRepl.checked = cfg.features?.js_repl !== false;
    }
    if (featureBubblewrapSandbox) {
      featureBubblewrapSandbox.checked = cfg.features?.use_linux_sandbox_bwrap !== false;
    }
    if (featurePreventIdleSleep) {
      featurePreventIdleSleep.checked = cfg.features?.prevent_idle_sleep !== false;
    }
    if (featureMultiAgent) {
      featureMultiAgent.checked = cfg.features?.multi_agent !== false;
    }
    const featureExtras = { ...cfg.features };
    delete featureExtras.fast_mode;
    delete featureExtras.unified_exec;
    delete featureExtras.web_search_request;
    delete featureExtras.web_search;
    delete featureExtras.voice_transcription;
    delete featureExtras.apps;
    delete featureExtras.guardian_approval;
    delete featureExtras.js_repl;
    delete featureExtras.use_linux_sandbox_bwrap;
    delete featureExtras.prevent_idle_sleep;
    delete featureExtras.multi_agent;
    delete featureExtras.experimental_windows_sandbox;
    delete featureExtras.elevated_windows_sandbox;
    delete featureExtras.enable_experimental_windows_sandbox;
    delete featureExtras.collaboration_modes;
    delete featureExtras.remote_models;
    delete featureExtras.request_rule;
    delete featureExtras.search_tool;
    delete featureExtras.steer;
    extraFeaturesInput.value = mapToText(featureExtras);

    sandboxNetwork.checked = Boolean(cfg.sandbox_workspace_write?.network_access);
    sandboxTmpdir.checked = Boolean(cfg.sandbox_workspace_write?.exclude_tmpdir_env_var);
    sandboxSlashTmp.checked = Boolean(cfg.sandbox_workspace_write?.exclude_slash_tmp);
    writableRootsInput.value = (cfg.sandbox_workspace_write?.writable_roots || []).join('\n');

    envInheritInput.value = cfg.shell_environment_policy?.inherit || '';
    envIncludeInput.value = (cfg.shell_environment_policy?.include_only || []).join('\n');
    envExcludeInput.value = (cfg.shell_environment_policy?.exclude || []).join('\n');
    envSetInput.value = mapToText(cfg.shell_environment_policy?.set || {});
    ignoreDefaultExcludesInput.checked = Boolean(cfg.shell_environment_policy?.ignore_default_excludes);

    clearRows(mcpRows);
    const orchestratorEnabled = cfg.orchestrator_mcp_enabled !== false;
    if (orchestratorMcpToggle) {
      orchestratorMcpToggle.checked = orchestratorEnabled;
    }
    (cfg.mcp_servers || [])
      .filter((mcp) => !MANAGED_MCP_NAMES.includes((mcp?.name || '').toLowerCase()))
      .forEach((mcp) => renderMcpRow(mcp));
    updateMcpVisibility({ resetToCollapsed: true });
    updateManagedMcpSummary(orchestratorEnabled);

    setSelectValue(otelExporterInput, cfg.otel?.exporter || 'none');
    otelEndpointInput.value = cfg.otel?.endpoint || '';
    otelProtocolInput.value = cfg.otel?.protocol || '';
    otelHeadersInput.value = mapToText(cfg.otel?.headers || {});
    otelLogPromptsInput.checked = Boolean(cfg.otel?.log_user_prompt);

    customTomlInput.value = cfg.custom_toml || '';
  }

  function updateMcpVisibility(options = {}) {
    if (!mcpAccordion) return;
    const { forceOpen = false, resetToCollapsed = false } = options;
    const count = mcpRows ? mcpRows.querySelectorAll('.mcp-row').length : 0;
    if (mcpCount) mcpCount.textContent = String(count);
    if (resetToCollapsed) {
      mcpAccordion.open = false;
    }
    if (forceOpen && count > 0) {
      mcpAccordion.open = true;
    }
    mcpAccordion.hidden = count === 0;
  }

  function updateManagedMcpSummary(enabled) {
    if (!orchestratorMcpSummaryWrap || !orchestratorMcpSummary) return;
    orchestratorMcpSummaryWrap.hidden = !enabled;
    orchestratorMcpSummary.textContent = enabled
      ? '[[mcp_servers]]\nname = "codex-orchestrator"\ncommand = "codex-orchestrator"\nargs = ["--addr", "${AUTH_RUNNER_URL:-http://127.0.0.1:8788}"]'
      : '';
  }

  function setStatus(text, sha = null, updated = null) {
    if (statusEl) statusEl.textContent = text;
    if (shaEl) shaEl.textContent = sha || '—';
    if (updatedEl) updatedEl.textContent = updated ? formatTimestamp(updated) : '—';
  }

  function markConfigRemotePending() {
    configRemotePending = true;
    if (statusEl) {
      statusEl.textContent = 'Remote update available (unsaved edits)';
    }
  }

  async function refreshConfigFromPush() {
    if (!inited) return;
    if (configDirty) {
      markConfigRemotePending();
      return;
    }
    if (configReloadInFlight) {
      configReloadQueued = true;
      return;
    }
    configReloadInFlight = true;
    try {
      await loadConfig();
      await renderPreview();
      configRemotePending = false;
    } finally {
      configReloadInFlight = false;
      if (configReloadQueued) {
        configReloadQueued = false;
        scheduleConfigReload(500);
      }
    }
  }

  function scheduleConfigReload(delay = 700) {
    if (!inited) return;
    if (configDirty) {
      markConfigRemotePending();
      return;
    }
    if (configReloadInFlight) {
      configReloadQueued = true;
      return;
    }
    if (configReloadTimer) return;
    configReloadTimer = window.setTimeout(() => {
      configReloadTimer = null;
      refreshConfigFromPush();
    }, delay);
  }

  async function loadConfig() {
    if (!statusEl) return;
    setStatus('Loading…');
    try {
      const res = await fetch('/admin/config', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || {};
      const cfg = data.settings || defaultSettings();
      populateForm(cfg);
      setStatus(data.status === 'missing' ? 'No saved config yet' : 'Loaded', data.sha256 || null, data.updated_at || null);
      if (previewEl) {
        previewEl.textContent = data.content || 'Preview to see rendered config.toml';
      }
      if (data.sha256) {
        lastRenderedSha = data.sha256;
        lastSavedSha = data.sha256;
        previewMetaEl.textContent = `saved sha ${data.sha256}${data.size_bytes ? ` · ${data.size_bytes} bytes` : ''}`;
      }
      configDirty = false;
    } catch (err) {
      console.error('load config', err);
      setStatus('Failed to load config');
      if (previewEl) previewEl.textContent = 'Unable to load config.';
    }
  }

  async function renderPreview() {
    if (!previewMetaEl) return;
    const settings = collectSettings();
    previewMetaEl.textContent = 'Rendering…';
    try {
      const res = await fetch('/admin/config/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || {};
      if (previewEl) previewEl.textContent = data.content || '';
      lastRenderedSha = data.sha256 || '';
      lastRenderedSize = data.size_bytes || 0;
      previewMetaEl.textContent = data.sha256 ? `sha ${data.sha256}${lastRenderedSize ? ` · ${lastRenderedSize} bytes` : ''}` : 'Rendered';
    } catch (err) {
      console.error('render config', err);
      if (previewEl) previewEl.textContent = 'Render failed.';
      previewMetaEl.textContent = 'Render failed';
    }
  }

  async function saveConfig() {
    if (!statusEl) return;
    const settings = collectSettings();
    setStatus('Saving…');
    try {
      // Always re-render server-side right before store so the sha matches the
      // exact normalized + rendered TOML (avoids races with the debounced preview).
      let normalizedSettings = settings;
      let renderedSha = '';
      try {
        const renderRes = await fetch('/admin/config/render', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ settings }),
        });
        if (renderRes.ok) {
          const renderJson = await renderRes.json();
          const rendered = renderJson.data || {};
          normalizedSettings = rendered.settings || settings;
          renderedSha = rendered.sha256 || '';
          if (previewEl) previewEl.textContent = rendered.content || '';
          if (renderedSha) {
            lastRenderedSha = renderedSha;
            lastRenderedSize = rendered.size_bytes || lastRenderedSize;
            if (previewMetaEl) {
              previewMetaEl.textContent = `sha ${renderedSha}${lastRenderedSize ? ` · ${lastRenderedSize} bytes` : ''}`;
            }
          }
        }
      } catch (_) {
        // render is best-effort; store endpoint can still succeed without sha.
      }

      const res = await fetch('/admin/config/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ settings: normalizedSettings, sha256: lastSavedSha || undefined }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        const contentType = (res.headers.get('content-type') || '').toLowerCase();
        if (contentType.includes('application/json')) {
          try {
            const json = await res.json();
            const serverMessage = typeof json?.message === 'string' ? json.message : '';
            const errors = json?.errors && typeof json.errors === 'object' ? json.errors : null;
            const errorList = [];
            if (errors) {
              Object.entries(errors).forEach(([key, vals]) => {
                if (Array.isArray(vals)) {
                  vals.forEach((v) => errorList.push(`${key}: ${String(v)}`));
                } else if (vals) {
                  errorList.push(`${key}: ${String(vals)}`);
                }
              });
            }
            if (serverMessage) message += ` · ${serverMessage}`;
            if (errorList.length) message += ` · ${errorList.join('; ')}`;
          } catch (_) {
            // fall through to text
          }
        }
        if (message === `HTTP ${res.status}`) {
          const errText = await res.text();
          if (errText) message += `: ${errText}`;
        }
        throw new Error(message);
      }
      const json = await res.json();
      const data = json.data || {};
      setStatus(`Saved (${data.status || 'ok'})`, data.sha256 || null, data.updated_at || null);
      if (previewEl) previewEl.textContent = data.content || '';
      if (data.sha256) {
        lastRenderedSha = data.sha256;
        lastRenderedSize = data.size_bytes || lastRenderedSize;
        lastSavedSha = data.sha256;
        previewMetaEl.textContent = `sha ${data.sha256}${data.size_bytes ? ` · ${data.size_bytes} bytes` : ''}`;
      }
      configDirty = false;
      configRemotePending = false;
    } catch (err) {
      console.error('save config', err);
      const details = err && err.message ? String(err.message) : '';
      setStatus(details ? `Save failed (${details})` : 'Save failed');
    }
  }

  function debounce(fn, wait = 300) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const debouncedPreview = debounce(renderPreview, 400);

  function wireChangeEvents(rootEl) {
    const scope = rootEl || document;
    const inputs = scope.querySelectorAll('input, textarea, select');
    inputs.forEach((el) => {
      const markDirty = () => {
        lastRenderedSha = '';
        lastRenderedSize = 0;
        configDirty = true;
        configRemotePending = false;
        if (previewMetaEl) previewMetaEl.textContent = 'Edited (preview pending)';
      };
      el.addEventListener('input', () => {
        markDirty();
        debouncedPreview();
      });
      el.addEventListener('change', () => {
        markDirty();
        debouncedPreview();
      });
    });
  }

  function initDomRefs() {
    statusEl = document.getElementById('configStatus');
    shaEl = document.getElementById('configSha');
    updatedEl = document.getElementById('configUpdated');
    previewEl = document.getElementById('configPreview');
    previewMetaEl = document.getElementById('previewMeta');

    modelInput = document.getElementById('modelInput');
    modelProviderInput = document.getElementById('modelProviderInput');
    localProviderInput = document.getElementById('localProviderInput');
    personalityInput = document.getElementById('personalityInput');
    approvalPolicyInput = document.getElementById('approvalPolicyInput');
    sandboxModeInput = document.getElementById('sandboxModeInput');
    reasoningEffortInput = document.getElementById('reasoningEffortInput');
    reasoningSummaryInput = document.getElementById('reasoningSummaryInput');
    verbosityInput = document.getElementById('verbosityInput');
    contextWindowInput = document.getElementById('contextWindowInput');
    maxTokensInput = document.getElementById('maxTokensInput');
    supportsSummariesInput = document.getElementById('supportsSummariesInput');
    notifyInput = document.getElementById('notifyInput');

    featureFastMode = document.getElementById('featureFastMode');
    featureUnifiedExec = document.getElementById('featureUnifiedExec');
    featureWebSearch = document.getElementById('featureWebSearch');
    featureVoiceTranscription = document.getElementById('featureVoiceTranscription');
    featureApps = document.getElementById('featureApps');
    featureGuardianApproval = document.getElementById('featureGuardianApproval');
    featureJsRepl = document.getElementById('featureJsRepl');
    featureBubblewrapSandbox = document.getElementById('featureBubblewrapSandbox');
    featurePreventIdleSleep = document.getElementById('featurePreventIdleSleep');
    featureMultiAgent = document.getElementById('featureMultiAgent');
    dangerousBypassApprovalsSandbox = document.getElementById('dangerousBypassApprovalsSandbox');
    extraFeaturesInput = document.getElementById('extraFeaturesInput');

    sandboxNetwork = document.getElementById('sandboxNetwork');
    sandboxTmpdir = document.getElementById('sandboxTmpdir');
    sandboxSlashTmp = document.getElementById('sandboxSlashTmp');
    writableRootsInput = document.getElementById('writableRootsInput');
    envInheritInput = document.getElementById('envInheritInput');
    envIncludeInput = document.getElementById('envIncludeInput');
    envExcludeInput = document.getElementById('envExcludeInput');
    envSetInput = document.getElementById('envSetInput');
    ignoreDefaultExcludesInput = document.getElementById('ignoreDefaultExcludesInput');

    mcpRows = document.getElementById('mcpRows');
    mcpAccordion = document.getElementById('mcpAccordion');
    mcpCount = document.getElementById('mcpCount');
    orchestratorMcpToggle = document.getElementById('orchestratorMcpToggle');
    orchestratorMcpSummaryWrap = document.getElementById('orchestratorMcpSummaryWrap');
    orchestratorMcpSummary = document.getElementById('orchestratorMcpSummary');

    otelExporterInput = document.getElementById('otelExporterInput');
    otelEndpointInput = document.getElementById('otelEndpointInput');
    otelProtocolInput = document.getElementById('otelProtocolInput');
    otelHeadersInput = document.getElementById('otelHeadersInput');
    otelLogPromptsInput = document.getElementById('otelLogPromptsInput');

    customTomlInput = document.getElementById('customTomlInput');

    saveBtn = document.getElementById('saveConfig');
    renderBtn = document.getElementById('renderConfig');
    copyBtn = document.getElementById('copyPreview');
    addMcpBtn = document.getElementById('addMcpBtn');
  }

  let inited = false;
  function init() {
    if (inited) return;
    initDomRefs();
    // If the panel is not present (different tab), bail silently.
    if (!modelInput || !previewEl || !statusEl) return;
    inited = true;

    ensureConfigSections();

    addMcpBtn?.addEventListener('click', () => {
      renderMcpRow();
      updateMcpVisibility({ forceOpen: true });
    });
    orchestratorMcpToggle?.addEventListener('change', (e) => {
      updateManagedMcpSummary(e.target.checked);
      debouncedPreview();
    });
    modelInput?.addEventListener('change', (e) => {
      rebuildReasoningOptions(e.target.value, reasoningEffortInput?.value || '');
      clampReasoningSummaryForModel(e.target.value);
      clampVerbosityForModel(e.target.value);
    });
    reasoningSummaryInput?.addEventListener('change', () => {
      clampReasoningSummaryForModel(modelInput?.value || '');
    });
    renderBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      renderPreview();
    });
    saveBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      saveConfig();
    });
    copyBtn?.addEventListener('click', async () => {
      if (!previewEl) return;
      try {
        await navigator.clipboard.writeText(previewEl.textContent || '');
        previewMetaEl.textContent = 'Copied';
        setTimeout(() => {
          previewMetaEl.textContent = lastRenderedSha ? `sha ${lastRenderedSha}${lastRenderedSize ? ` · ${lastRenderedSize} bytes` : ''}` : '';
        }, 800);
      } catch (_) {
        previewMetaEl.textContent = 'Copy failed';
      }
    });

    wireChangeEvents(document.querySelector('[data-settings-panel="config"]'));
    loadConfig().then(renderPreview);
  }

  // Expose to dashboard router for lazy init when #settings/config is shown.
  window.__initConfigBuilder = init;

  window.addEventListener('admin-data-dirty', (event) => {
    const domains = event?.detail?.domains;
    if (!Array.isArray(domains) || !domains.includes('config')) return;
    scheduleConfigReload(700);
  });

  // Auto-init if the current hash already targets the config tab (deep links / reload).
  const hash = (window.location.hash || '').toLowerCase();
  if (hash.startsWith('#settings/config')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
