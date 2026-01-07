(() => {
  // DOM refs are resolved lazily so the builder can live inside the SPA and only bind when the tab is visible.
  let statusEl;
  let shaEl;
  let updatedEl;
  let previewEl;
  let previewMetaEl;

  let modelInput;
  let approvalPolicyInput;
  let sandboxModeInput;
  let reasoningEffortInput;
  let reasoningSummaryInput;
  let verbosityInput;
  let contextWindowInput;
  let maxTokensInput;
  let supportsSummariesInput;
  let notifyInput;

  let featureStreamShell;
  let featureBackgroundTerminal;
  let featureUnifiedExec;
  let featureRmcpClient;
  let featureWebSearch;
  let featureViewImage;
  let featureSandboxAssessment;
  let featureGhostCommit;
  let featureExperimentalWindowsSandbox;
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

  let lastRenderedSha = '';
  let lastRenderedSize = 0;
  let lastSavedSha = '';

  const MODEL_REASONING = {
    'gpt-5.2': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.2-codex': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex': ['', 'low', 'medium', 'high'],
    'gpt-5.1-codex-max': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex-mini': ['', 'medium', 'high'],
    'gpt-5.1': ['', 'low', 'medium', 'high'],
  };

  function isGpt51CodexModel(model) {
    const lower = String(model || '').toLowerCase();
    return lower.startsWith('gpt-5.1-codex') || lower.startsWith('gpt-5.2-codex');
  }

  function clampReasoningSummaryForModel(model) {
    if (!reasoningSummaryInput) return;
    const codex = isGpt51CodexModel(model);
    const options = Array.from(reasoningSummaryInput.options || []);
    options.forEach((opt) => {
      const value = String(opt.value || '').toLowerCase();
      if (!value) return;
      if (value === 'detailed') {
        opt.disabled = false;
        return;
      }
      if (value === 'auto' || value === 'concise') {
        opt.disabled = codex;
      }
    });

    const current = String(reasoningSummaryInput.value || '').trim().toLowerCase();
    if (codex && current !== '' && current !== 'detailed') {
      reasoningSummaryInput.value = 'detailed';
    }
  }

  function defaultSettings() {
    return {
      model: 'gpt-5.1-codex',
      approval_policy: 'on-request',
      sandbox_mode: 'read-only',
      model_reasoning_effort: 'medium',
      model_reasoning_summary: 'detailed',
      model_verbosity: 'low',
      model_supports_reasoning_summaries: false,
      model_context_window: null,
      model_max_output_tokens: null,
      features: {
        streamable_shell: false,
        background_terminal: false,
        unified_exec: false,
        rmcp_client: false,
        web_search_request: false,
        view_image_tool: false,
        experimental_sandbox_command_assessment: false,
        ghost_commit: false,
        experimental_windows_sandbox: false,
      },
      notice: {
        'hide_gpt5_1_migration_prompt': true,
        'hide_gpt-5.1-codex-max_migration_prompt': true,
        'hide_rate_limit_model_nudge': true,
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

  function setSelectValue(selectEl, value) {
    if (!selectEl) return;
    const val = value || '';
    const options = Array.from(selectEl.options || []);
    const exists = options.some((opt) => opt.value === val);
    if (!exists && val !== '') {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      selectEl.appendChild(opt);
    }
    selectEl.value = val;
  }

  function rebuildReasoningOptions(model, currentValue) {
    if (!reasoningEffortInput) return;
    const allowed = MODEL_REASONING[model] || [''];
    reasoningEffortInput.innerHTML = '';
    allowed.forEach((optVal) => {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = optVal === '' ? '—' : optVal;
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
      streamable_shell: featureStreamShell.checked,
      background_terminal: featureBackgroundTerminal.checked,
      unified_exec: featureUnifiedExec.checked,
      rmcp_client: featureRmcpClient.checked,
      web_search_request: featureWebSearch.checked,
      view_image_tool: featureViewImage.checked,
      experimental_sandbox_command_assessment: featureSandboxAssessment.checked,
      ghost_commit: featureGhostCommit.checked,
      experimental_windows_sandbox: featureExperimentalWindowsSandbox.checked,
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
      approval_policy: approvalPolicyInput.value.trim() || base.approval_policy,
      sandbox_mode: sandboxModeInput.value.trim() || base.sandbox_mode,
      model_reasoning_effort: reasoningEffortInput.value.trim() || base.model_reasoning_effort,
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
    setSelectValue(modelInput, cfg.model || '');
    setSelectValue(approvalPolicyInput, cfg.approval_policy || '');
    setSelectValue(sandboxModeInput, cfg.sandbox_mode || '');
    rebuildReasoningOptions(cfg.model || '', cfg.model_reasoning_effort || '');
    const summaryValue = (cfg.model_reasoning_summary || '').toLowerCase() === 'none' ? '' : (cfg.model_reasoning_summary || '');
    setSelectValue(reasoningSummaryInput, summaryValue);
    clampReasoningSummaryForModel(cfg.model || '');
    setSelectValue(verbosityInput, cfg.model_verbosity || '');
    contextWindowInput.value = cfg.model_context_window ?? '';
    maxTokensInput.value = cfg.model_max_output_tokens ?? '';
    supportsSummariesInput.checked = Boolean(cfg.model_supports_reasoning_summaries);
    notifyInput.value = (cfg.notify || []).join('\n');

    featureStreamShell.checked = Boolean(cfg.features?.streamable_shell);
    featureBackgroundTerminal.checked = Boolean(cfg.features?.background_terminal);
    featureUnifiedExec.checked = Boolean(cfg.features?.unified_exec);
    featureRmcpClient.checked = Boolean(cfg.features?.rmcp_client);
    featureWebSearch.checked = Boolean(cfg.features?.web_search_request);
    featureViewImage.checked = cfg.features?.view_image_tool !== false;
    featureSandboxAssessment.checked = Boolean(cfg.features?.experimental_sandbox_command_assessment);
    featureGhostCommit.checked = Boolean(cfg.features?.ghost_commit);
    featureExperimentalWindowsSandbox.checked = Boolean(
      cfg.features?.experimental_windows_sandbox ?? cfg.features?.enable_experimental_windows_sandbox,
    );
    const featureExtras = { ...cfg.features };
    delete featureExtras.streamable_shell;
    delete featureExtras.background_terminal;
    delete featureExtras.unified_exec;
    delete featureExtras.rmcp_client;
    delete featureExtras.web_search_request;
    delete featureExtras.view_image_tool;
    delete featureExtras.experimental_sandbox_command_assessment;
    delete featureExtras.ghost_commit;
    delete featureExtras.experimental_windows_sandbox;
    delete featureExtras.enable_experimental_windows_sandbox;
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
    approvalPolicyInput = document.getElementById('approvalPolicyInput');
    sandboxModeInput = document.getElementById('sandboxModeInput');
    reasoningEffortInput = document.getElementById('reasoningEffortInput');
    reasoningSummaryInput = document.getElementById('reasoningSummaryInput');
    verbosityInput = document.getElementById('verbosityInput');
    contextWindowInput = document.getElementById('contextWindowInput');
    maxTokensInput = document.getElementById('maxTokensInput');
    supportsSummariesInput = document.getElementById('supportsSummariesInput');
    notifyInput = document.getElementById('notifyInput');

    featureStreamShell = document.getElementById('featureStreamShell');
    featureBackgroundTerminal = document.getElementById('featureBackgroundTerminal');
    featureUnifiedExec = document.getElementById('featureUnifiedExec');
    featureRmcpClient = document.getElementById('featureRmcpClient');
    featureWebSearch = document.getElementById('featureWebSearch');
    featureViewImage = document.getElementById('featureViewImage');
    featureSandboxAssessment = document.getElementById('featureSandboxAssessment');
    featureGhostCommit = document.getElementById('featureGhostCommit');
    featureExperimentalWindowsSandbox = document.getElementById('featureExperimentalWindowsSandbox');
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
