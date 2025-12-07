(() => {
  const statusEl = document.getElementById('configStatus');
  const shaEl = document.getElementById('configSha');
  const updatedEl = document.getElementById('configUpdated');
  const previewEl = document.getElementById('configPreview');
  const previewMetaEl = document.getElementById('previewMeta');

  const modelInput = document.getElementById('modelInput');
  const approvalPolicyInput = document.getElementById('approvalPolicyInput');
  const sandboxModeInput = document.getElementById('sandboxModeInput');
  const reasoningEffortInput = document.getElementById('reasoningEffortInput');
  const reasoningSummaryInput = document.getElementById('reasoningSummaryInput');
  const verbosityInput = document.getElementById('verbosityInput');
  const contextWindowInput = document.getElementById('contextWindowInput');
  const maxTokensInput = document.getElementById('maxTokensInput');
  const supportsSummariesInput = document.getElementById('supportsSummariesInput');
  const notifyInput = document.getElementById('notifyInput');

  const featureStreamShell = document.getElementById('featureStreamShell');
  const featureWebSearch = document.getElementById('featureWebSearch');
  const featureViewImage = document.getElementById('featureViewImage');
  const extraFeaturesInput = document.getElementById('extraFeaturesInput');

  const sandboxNetwork = document.getElementById('sandboxNetwork');
  const sandboxTmpdir = document.getElementById('sandboxTmpdir');
  const sandboxSlashTmp = document.getElementById('sandboxSlashTmp');
  const writableRootsInput = document.getElementById('writableRootsInput');
  const envInheritInput = document.getElementById('envInheritInput');
  const envIncludeInput = document.getElementById('envIncludeInput');
  const envExcludeInput = document.getElementById('envExcludeInput');
  const envSetInput = document.getElementById('envSetInput');
  const ignoreDefaultExcludesInput = document.getElementById('ignoreDefaultExcludesInput');

  const profileRows = document.getElementById('profileRows');
  const mcpRows = document.getElementById('mcpRows');
  const mcpAccordion = document.getElementById('mcpAccordion');
  const mcpCount = document.getElementById('mcpCount');
  const orchestratorMcpToggle = document.getElementById('orchestratorMcpToggle');
  const orchestratorMcpSummaryWrap = document.getElementById('orchestratorMcpSummaryWrap');
  const orchestratorMcpSummary = document.getElementById('orchestratorMcpSummary');

  const otelExporterInput = document.getElementById('otelExporterInput');
  const otelEndpointInput = document.getElementById('otelEndpointInput');
  const otelProtocolInput = document.getElementById('otelProtocolInput');
  const otelHeadersInput = document.getElementById('otelHeadersInput');
  const otelLogPromptsInput = document.getElementById('otelLogPromptsInput');

  const customTomlInput = document.getElementById('customTomlInput');

  const saveBtn = document.getElementById('saveConfig');
  const renderBtn = document.getElementById('renderConfig');
  const copyBtn = document.getElementById('copyPreview');
  const addProfileBtn = document.getElementById('addProfileBtn');
  const addMcpBtn = document.getElementById('addMcpBtn');

  let lastRenderedSha = '';
  let lastRenderedSize = 0;

  const MODEL_REASONING = {
    'gpt-5.1-codex': ['', 'low', 'medium', 'high'],
    'gpt-5.1-codex-max': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex-mini': ['', 'medium', 'high'],
    'gpt-5.1': ['', 'low', 'medium', 'high'],
  };

  function defaultSettings() {
    return {
      model: 'gpt-5.1-codex',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      model_reasoning_effort: 'medium',
      model_reasoning_summary: 'auto',
      model_verbosity: 'low',
      model_supports_reasoning_summaries: false,
      model_context_window: null,
      model_max_output_tokens: null,
      features: {
        streamable_shell: false,
        web_search_request: true,
        view_image_tool: true,
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

  function clearRows(container) {
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
  }

  function updateMcpVisibility(options = {}) {
    const { forceOpen = false, resetToCollapsed = false } = options;
    const count = mcpRows ? mcpRows.querySelectorAll('.mcp-row').length : 0;
    if (mcpCount) mcpCount.textContent = String(count);
    if (!mcpAccordion) return;
    if (count === 0) {
      mcpAccordion.hidden = true;
      mcpAccordion.open = false;
      return;
    }
    mcpAccordion.hidden = false;
    if (forceOpen) {
      mcpAccordion.open = true;
    } else if (resetToCollapsed) {
      mcpAccordion.open = false;
    }
  }

  function managedMcpSnippet(baseUrl) {
    const base = (baseUrl || '').replace(/\/$/, '') || 'https://your-coordinator.example.com';
    return [
      '[mcp_servers.cdx]',
      `url = "${base}/mcp"`,
      'http_headers = { Authorization = "Bearer <host api key>" }',
    ].join('\n');
  }

  function updateManagedMcpSummary(enabled) {
    if (!orchestratorMcpSummaryWrap || !orchestratorMcpSummary) return;
    if (!enabled) {
      orchestratorMcpSummaryWrap.hidden = true;
      orchestratorMcpSummary.textContent = '';
      return;
    }
    const origin = (window.location.origin || '').replace(/\/$/, '');
    orchestratorMcpSummary.textContent = managedMcpSnippet(origin);
    orchestratorMcpSummaryWrap.hidden = false;
  }

  function renderProfileRow(data = {}) {
    const row = document.createElement('div');
    row.className = 'row-card profile-row';
    row.innerHTML = `
      <div class="inline-group">
        <div class="field">
          <label>Name</label>
          <input type="text" class="profile-name" placeholder="deep-review">
        </div>
        <div class="field">
          <label>Model</label>
          <input type="text" class="profile-model" placeholder="gpt-5-pro">
        </div>
        <div class="field">
          <label>Model provider</label>
          <input type="text" class="profile-provider" placeholder="openai">
        </div>
      </div>
      <div class="inline-group">
        <div class="field">
          <label>Approval policy</label>
          <input type="text" class="profile-approval" placeholder="never">
        </div>
        <div class="field">
          <label>Sandbox mode</label>
          <input type="text" class="profile-sandbox" placeholder="workspace-write">
        </div>
        <div class="field">
          <label>Reasoning effort</label>
          <input type="text" class="profile-effort" placeholder="high">
        </div>
      </div>
      <div class="inline-group">
        <div class="field">
          <label>Reasoning summary</label>
          <select class="profile-summary">
            <option value="">—</option>
            <option value="auto">auto</option>
            <option value="concise">concise</option>
            <option value="detailed">detailed</option>
          </select>
        </div>
        <div class="field">
          <label>Verbosity</label>
          <input type="text" class="profile-verbosity" placeholder="low">
        </div>
        <div class="field">
          <label style="display:flex; align-items:center; gap:8px;">
            <span>Force reasoning summaries</span>
            <input type="checkbox" class="profile-supports" style="width:auto; accent-color: var(--accent);">
          </label>
        </div>
      </div>
      <div class="inline-group">
        <div class="field">
          <label>Context window</label>
          <input type="number" class="profile-context" min="0" placeholder="128000">
        </div>
        <div class="field">
          <label>Max output tokens</label>
          <input type="number" class="profile-max" min="0" placeholder="4096">
        </div>
      </div>
      <div class="row-actions">
        <button type="button" class="ghost tiny-btn remove-profile">Remove</button>
      </div>
    `;
    row.querySelector('.profile-name').value = data.name || '';
    row.querySelector('.profile-model').value = data.model || '';
    row.querySelector('.profile-provider').value = data.model_provider || '';
    row.querySelector('.profile-approval').value = data.approval_policy || '';
    row.querySelector('.profile-sandbox').value = data.sandbox_mode || '';
    row.querySelector('.profile-effort').value = data.model_reasoning_effort || '';
    const profileSummary = (data.model_reasoning_summary || '').toLowerCase() === 'none' ? '' : (data.model_reasoning_summary || '');
    row.querySelector('.profile-summary').value = profileSummary;
    row.querySelector('.profile-verbosity').value = data.model_verbosity || '';
    row.querySelector('.profile-context').value = data.model_context_window ?? '';
    row.querySelector('.profile-max').value = data.model_max_output_tokens ?? '';
    row.querySelector('.profile-supports').checked = Boolean(data.model_supports_reasoning_summaries);
    row.querySelector('.remove-profile').addEventListener('click', () => row.remove());
    row.querySelectorAll('input, textarea, select').forEach((el) => {
      el.addEventListener('input', debouncedPreview);
      el.addEventListener('change', debouncedPreview);
    });
    profileRows.appendChild(row);
  }

  function renderMcpRow(data = {}, options = {}) {
    const row = document.createElement('div');
    row.className = 'row-card mcp-row';
    row.innerHTML = `
      <div class="inline-group">
        <div class="field">
          <label>Name</label>
          <input type="text" class="mcp-name" placeholder="coordinator-memory">
        </div>
        <div class="field">
          <label>Command</label>
          <input type="text" class="mcp-command" placeholder="npx">
        </div>
      </div>
      <div class="field">
        <label>Args (one per line)</label>
        <textarea class="mcp-args" placeholder='-y&#10;@upstash/context7-mcp'></textarea>
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

  const MANAGED_MCP_NAMES = ['codex-memory', 'codex-orchestrator'];

  function collectSettings() {
    const base = defaultSettings();
    const features = {
      streamable_shell: featureStreamShell.checked,
      web_search_request: featureWebSearch.checked,
      view_image_tool: featureViewImage.checked,
    };
    const extraFeatures = parseKeyValue(extraFeaturesInput.value);
    Object.assign(features, extraFeatures);

    const profiles = Array.from(profileRows.querySelectorAll('.profile-row')).map((row) => {
      const name = row.querySelector('.profile-name')?.value.trim() || '';
      if (!name) return null;
      return {
        name,
        model: row.querySelector('.profile-model')?.value.trim() || '',
        model_provider: row.querySelector('.profile-provider')?.value.trim() || '',
        approval_policy: row.querySelector('.profile-approval')?.value.trim() || '',
        sandbox_mode: row.querySelector('.profile-sandbox')?.value.trim() || '',
        model_reasoning_effort: row.querySelector('.profile-effort')?.value.trim() || '',
        model_reasoning_summary: row.querySelector('.profile-summary')?.value.trim() || '',
        model_verbosity: row.querySelector('.profile-verbosity')?.value.trim() || '',
        model_supports_reasoning_summaries: row.querySelector('.profile-supports')?.checked || false,
        model_context_window: numberOrNull(row.querySelector('.profile-context')?.value),
        model_max_output_tokens: numberOrNull(row.querySelector('.profile-max')?.value),
      };
    }).filter(Boolean);

    const mcpServers = Array.from(mcpRows.querySelectorAll('.mcp-row')).map((row) => {
      const name = row.querySelector('.mcp-name')?.value.trim() || '';
      const command = row.querySelector('.mcp-command')?.value.trim() || '';
      if (!name || !command) return null;
      return {
        name,
        command,
        args: parseArgs(row.querySelector('.mcp-args')?.value || ''),
      };
    }).filter(Boolean);

    return {
      ...base,
      model: modelInput.value.trim() || base.model,
      approval_policy: approvalPolicyInput.value.trim() || base.approval_policy,
      sandbox_mode: sandboxModeInput.value.trim() || base.sandbox_mode,
      model_reasoning_effort: reasoningEffortInput.value.trim() || base.model_reasoning_effort,
      model_reasoning_summary: reasoningSummaryInput.value.trim() || base.model_reasoning_summary,
      model_verbosity: verbosityInput.value.trim() || base.model_verbosity,
      model_supports_reasoning_summaries: supportsSummariesInput.checked,
      model_context_window: numberOrNull(contextWindowInput.value),
      model_max_output_tokens: numberOrNull(maxTokensInput.value),
      notify: parseArgs(notifyInput.value),
      features,
    notice: defaultSettings().notice,
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

  function populateForm(settings) {
    const cfg = deepMerge(defaultSettings(), settings || {});
    setSelectValue(modelInput, cfg.model || '');
    setSelectValue(approvalPolicyInput, cfg.approval_policy || '');
    setSelectValue(sandboxModeInput, cfg.sandbox_mode || '');
    rebuildReasoningOptions(cfg.model || '', cfg.model_reasoning_effort || '');
    const summaryValue = (cfg.model_reasoning_summary || '').toLowerCase() === 'none' ? '' : (cfg.model_reasoning_summary || '');
    setSelectValue(reasoningSummaryInput, summaryValue);
    setSelectValue(verbosityInput, cfg.model_verbosity || '');
    contextWindowInput.value = cfg.model_context_window ?? '';
    maxTokensInput.value = cfg.model_max_output_tokens ?? '';
    supportsSummariesInput.checked = Boolean(cfg.model_supports_reasoning_summaries);
    notifyInput.value = (cfg.notify || []).join('\n');

    featureStreamShell.checked = Boolean(cfg.features?.streamable_shell);
    featureWebSearch.checked = Boolean(cfg.features?.web_search_request);
    featureViewImage.checked = cfg.features?.view_image_tool !== false;
    const featureExtras = { ...cfg.features };
    delete featureExtras.streamable_shell;
    delete featureExtras.web_search_request;
    delete featureExtras.view_image_tool;
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

    clearRows(profileRows);
    (cfg.profiles || []).forEach((profile) => renderProfileRow(profile));

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

  function setStatus(text, sha = null, updated = null) {
    if (statusEl) statusEl.textContent = text;
    if (shaEl) shaEl.textContent = sha || '—';
    if (updatedEl) updatedEl.textContent = updated ? formatTimestamp(updated) : '—';
  }

  async function loadConfig() {
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
        previewMetaEl.textContent = `saved sha ${data.sha256}${data.size_bytes ? ` · ${data.size_bytes} bytes` : ''}`;
      }
    } catch (err) {
      console.error('load config', err);
      setStatus('Failed to load config');
      if (previewEl) previewEl.textContent = 'Unable to load config.';
    }
  }

  async function renderPreview() {
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
    const settings = collectSettings();
    setStatus('Saving…');
    try {
      const res = await fetch('/admin/config/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ''}`);
      }
      const json = await res.json();
      const data = json.data || {};
      setStatus(`Saved (${data.status || 'ok'})`, data.sha256 || null, data.updated_at || null);
      if (previewEl) previewEl.textContent = data.content || '';
      if (data.sha256) {
        previewMetaEl.textContent = `sha ${data.sha256}${data.size_bytes ? ` · ${data.size_bytes} bytes` : ''}`;
      }
    } catch (err) {
      console.error('save config', err);
      setStatus('Save failed');
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

  function wireChangeEvents() {
    const inputs = document.querySelectorAll('input, textarea, select');
    inputs.forEach((el) => {
      el.addEventListener('input', debouncedPreview);
      el.addEventListener('change', debouncedPreview);
    });
  }

  function init() {
    addProfileBtn?.addEventListener('click', () => renderProfileRow());
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
        setTimeout(() => { previewMetaEl.textContent = lastRenderedSha ? `sha ${lastRenderedSha}${lastRenderedSize ? ` · ${lastRenderedSize} bytes` : ''}` : ''; }, 800);
      } catch (_) {
        previewMetaEl.textContent = 'Copy failed';
      }
    });
    wireChangeEvents();
    loadConfig().then(renderPreview);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
