(() => {
  let statusEl;
  let shaEl;
  let updatedEl;
  let profilesRows;
  let addBtn;
  let saveBtn;
  let reloadBtn;

  let lastSavedSha = '';
  let loadedSettings = null;

  const MODEL_REASONING = {
    'gpt-5.2': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex': ['', 'low', 'medium', 'high'],
    'gpt-5.1-codex-max': ['', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.1-codex-mini': ['', 'medium', 'high'],
    'gpt-5.1': ['', 'low', 'medium', 'high'],
  };

  function deepClone(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map((v) => deepClone(v));
    if (typeof value !== 'object') return value;
    const out = {};
    Object.entries(value).forEach(([k, v]) => { out[k] = deepClone(v); });
    return out;
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

  function setStatus(text, sha = null, updated = null) {
    if (statusEl) statusEl.textContent = text;
    if (shaEl) shaEl.textContent = sha || '—';
    if (updatedEl) updatedEl.textContent = updated ? formatTimestamp(updated) : '—';
  }

  function clearRows(container) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
  }

  function cloneSelectOptions(fromSelect, toSelect, { includeBlank = false, blankLabel = '—' } = {}) {
    if (!toSelect) return;
    toSelect.innerHTML = '';
    if (includeBlank) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = blankLabel;
      toSelect.appendChild(opt);
    }
    const sourceOptions = Array.from(fromSelect?.options || []);
    sourceOptions.forEach((source) => {
      const opt = document.createElement('option');
      opt.value = source.value;
      opt.textContent = source.textContent;
      toSelect.appendChild(opt);
    });
  }

  function rebuildReasoningOptions(selectEl, model, currentValue) {
    if (!selectEl) return;
    const allowed = MODEL_REASONING[model] || [''];
    selectEl.innerHTML = '';
    allowed.forEach((optVal) => {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = optVal === '' ? '—' : optVal;
      selectEl.appendChild(opt);
    });
    selectEl.value = allowed.includes(currentValue || '') ? (currentValue || '') : '';
  }

  function markDirty() {
    setStatus('Edited (not saved)', shaEl?.textContent || null, updatedEl?.textContent || null);
  }

  function renderProfileRow(data = {}, defaults = {}, options = {}) {
    if (!profilesRows) return;
    const row = document.createElement('details');
    row.className = 'row-card profile-row profile-accordion';
    row.open = Boolean(options.open);
    row.__profileOriginal = deepClone(data || {});

    row.innerHTML = `
      <summary class="profile-summary">
        <div class="profile-summary-main">
          <div class="profile-summary-line">
            <span class="profile-chevron" aria-hidden="true"></span>
            <span class="profile-summary-name">Unnamed profile</span>
          </div>
          <div class="profile-summary-meta muted-note">Click to expand</div>
        </div>
        <div class="profile-summary-actions">
          <button type="button" class="ghost tiny-btn remove-profile">Delete</button>
        </div>
      </summary>
      <div class="profile-body">
        <div class="inline-group">
          <div class="field">
            <label>Name</label>
            <input type="text" class="profile-name" placeholder="ultra" value="">
            <div class="muted-note">Allowed: <code>A–Z a–z 0–9 _ -</code></div>
          </div>
          <div class="field">
            <label>Model</label>
            <select class="profile-model"></select>
          </div>
          <div class="field">
            <label>Model Reasoning Effort</label>
            <select class="profile-effort"></select>
          </div>
        </div>
        <div class="inline-group">
          <div class="field">
            <label>Approval policy</label>
            <select class="profile-approval"></select>
          </div>
          <div class="field">
            <label>Sandbox mode</label>
            <select class="profile-sandbox"></select>
          </div>
        </div>
        <div class="feature-list">
          <label class="feature-toggle">
            <input type="checkbox" class="profile-stream" style="width:auto; accent-color: var(--accent);">
            <div>
              <div class="feature-title">Stream shell output</div>
              <div class="feature-desc">Show long-running command output live instead of in one big dump.</div>
            </div>
          </label>
          <label class="feature-toggle">
            <input type="checkbox" class="profile-search" style="width:auto; accent-color: var(--accent);">
            <div>
              <div class="feature-title">Allow web search</div>
              <div class="feature-desc">Let Codex reach out for fresh context when it needs it.</div>
            </div>
          </label>
          <label class="feature-toggle">
            <input type="checkbox" class="profile-image" style="width:auto; accent-color: var(--accent);">
            <div>
              <div class="feature-title">Allow image viewer</div>
              <div class="feature-desc">Preview images directly in the conversation instead of downloading them.</div>
            </div>
          </label>
          <label class="feature-toggle">
            <input type="checkbox" class="profile-network" style="width:auto; accent-color: var(--accent);">
            <div>
              <div class="feature-title">Allow network access</div>
              <div class="feature-desc">Let workspace commands reach the internet.</div>
            </div>
          </label>
        </div>
      </div>
    `;

    const summaryNameEl = row.querySelector('.profile-summary-name');
    const summaryMetaEl = row.querySelector('.profile-summary-meta');

    const nameInput = row.querySelector('.profile-name');
    const modelSelect = row.querySelector('.profile-model');
    const effortSelect = row.querySelector('.profile-effort');
    const approvalSelect = row.querySelector('.profile-approval');
    const sandboxSelect = row.querySelector('.profile-sandbox');
    const streamToggle = row.querySelector('.profile-stream');
    const searchToggle = row.querySelector('.profile-search');
    const imageToggle = row.querySelector('.profile-image');
    const networkToggle = row.querySelector('.profile-network');

    const modelSource = document.getElementById('modelInput');
    const approvalSource = document.getElementById('approvalPolicyInput');
    const sandboxSource = document.getElementById('sandboxModeInput');

    cloneSelectOptions(modelSource, modelSelect);
    cloneSelectOptions(approvalSource, approvalSelect, { includeBlank: true });
    cloneSelectOptions(sandboxSource, sandboxSelect, { includeBlank: true });

    const modelVal = (data.model || defaults.model || '').trim();
    modelSelect.value = Array.from(modelSelect.options).some((o) => o.value === modelVal)
      ? modelVal
      : (defaults.model || modelSelect.value || '');

    rebuildReasoningOptions(effortSelect, modelSelect.value, data.model_reasoning_effort || defaults.model_reasoning_effort || '');

    const approvalVal = (data.approval_policy || defaults.approval_policy || '').trim();
    approvalSelect.value = Array.from(approvalSelect.options).some((o) => o.value === approvalVal) ? approvalVal : '';

    const sandboxVal = (data.sandbox_mode || defaults.sandbox_mode || '').trim();
    sandboxSelect.value = Array.from(sandboxSelect.options).some((o) => o.value === sandboxVal) ? sandboxVal : '';

    nameInput.value = (data.name || '').trim();
    nameInput.setAttribute('pattern', '^[A-Za-z0-9_-]+$');

    const features = data.features || {};
    streamToggle.checked = Boolean(typeof features.streamable_shell === 'boolean' ? features.streamable_shell : defaults.features?.streamable_shell);
    searchToggle.checked = Boolean(typeof features.web_search_request === 'boolean' ? features.web_search_request : defaults.features?.web_search_request);
    imageToggle.checked = typeof features.view_image_tool === 'boolean'
      ? features.view_image_tool
      : (defaults.features?.view_image_tool !== false);

    const sandboxWorkspaceWrite = data.sandbox_workspace_write || {};
    networkToggle.checked = Boolean(typeof sandboxWorkspaceWrite.network_access === 'boolean'
      ? sandboxWorkspaceWrite.network_access
      : defaults.sandbox_workspace_write?.network_access);

    modelSelect.addEventListener('change', () => {
      rebuildReasoningOptions(effortSelect, modelSelect.value, effortSelect.value);
    });

    const updateSummary = () => {
      if (!summaryNameEl || !summaryMetaEl) return;
      const name = (nameInput?.value || '').trim();
      summaryNameEl.textContent = name || (row.open ? 'New profile' : 'Unnamed profile');

      const bits = [];
      const model = (modelSelect?.value || '').trim();
      if (model) bits.push(model);
      const effort = (effortSelect?.value || '').trim();
      if (effort) bits.push(`effort=${effort}`);

      const approval = (approvalSelect?.value || '').trim();
      bits.push(`approval=${approval || 'default'}`);
      const sandbox = (sandboxSelect?.value || '').trim();
      bits.push(`sandbox=${sandbox || 'default'}`);

      const flags = [];
      if (streamToggle?.checked) flags.push('stream');
      if (searchToggle?.checked) flags.push('web');
      if (imageToggle?.checked) flags.push('image');
      if (networkToggle?.checked) flags.push('net');
      if (flags.length) bits.push(flags.join(','));

      summaryMetaEl.textContent = bits.length ? bits.join(' · ') : 'Click to expand';
    };

    row.querySelector('.remove-profile')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.remove();
      markDirty();
    });

    row.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('input', () => { updateSummary(); markDirty(); });
      el.addEventListener('change', () => { updateSummary(); markDirty(); });
    });

    profilesRows.appendChild(row);

    updateSummary();
    row.addEventListener('toggle', updateSummary);
    if (options.focusName) {
      nameInput?.focus();
    }

    return row;
  }

  function collectProfiles() {
    const rows = Array.from(profilesRows?.querySelectorAll('.profile-row') || []);
    const profiles = [];
    const names = new Set();
    const invalid = [];
    const duplicates = [];

    rows.forEach((row) => {
      const name = (row.querySelector('.profile-name')?.value || '').trim();
      if (!name) return;
      if (!/^[A-Za-z0-9_-]+$/.test(name)) invalid.push(name);
      if (names.has(name)) duplicates.push(name);
      names.add(name);

      const original = row.__profileOriginal && typeof row.__profileOriginal === 'object'
        ? deepClone(row.__profileOriginal)
        : {};
      delete original.model_provider;

      const model = (row.querySelector('.profile-model')?.value || '').trim();
      const effort = (row.querySelector('.profile-effort')?.value || '').trim();
      const approval = (row.querySelector('.profile-approval')?.value || '').trim();
      const sandbox = (row.querySelector('.profile-sandbox')?.value || '').trim();
      const streamableShell = Boolean(row.querySelector('.profile-stream')?.checked);
      const webSearch = Boolean(row.querySelector('.profile-search')?.checked);
      const viewImage = Boolean(row.querySelector('.profile-image')?.checked);
      const networkAccess = Boolean(row.querySelector('.profile-network')?.checked);

      profiles.push({
        ...original,
        name,
        model: model || '',
        approval_policy: approval || '',
        sandbox_mode: sandbox || '',
        model_reasoning_effort: effort || '',
        features: {
          ...(original.features && typeof original.features === 'object' ? original.features : {}),
          streamable_shell: streamableShell,
          web_search_request: webSearch,
          view_image_tool: viewImage,
        },
        sandbox_workspace_write: {
          ...(original.sandbox_workspace_write && typeof original.sandbox_workspace_write === 'object' ? original.sandbox_workspace_write : {}),
          network_access: networkAccess,
        },
      });
    });

    return { profiles, invalid, duplicates };
  }

  function defaultSettings() {
    return {
      model: 'gpt-5.1-codex',
      approval_policy: 'on-request',
      sandbox_mode: 'read-only',
      model_reasoning_effort: 'medium',
      features: {
        streamable_shell: false,
        web_search_request: false,
        view_image_tool: true,
      },
      sandbox_workspace_write: {
        network_access: false,
      },
      profiles: [],
    };
  }

  async function load() {
    setStatus('Loading…');
    try {
      const res = await fetch('/admin/config', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const data = json.data || {};
      lastSavedSha = data.sha256 || '';
      loadedSettings = data.settings && typeof data.settings === 'object' ? data.settings : defaultSettings();

      const cfg = loadedSettings || defaultSettings();
      const defaults = {
        model: cfg.model || 'gpt-5.1-codex',
        model_reasoning_effort: cfg.model_reasoning_effort || '',
        approval_policy: cfg.approval_policy || '',
        sandbox_mode: cfg.sandbox_mode || '',
        features: cfg.features || {},
        sandbox_workspace_write: cfg.sandbox_workspace_write || {},
      };

      clearRows(profilesRows);
      (cfg.profiles || []).forEach((p) => renderProfileRow(p, defaults, { open: false }));

      setStatus(data.status === 'missing' ? 'No saved config yet' : 'Loaded', data.sha256 || null, data.updated_at || null);
    } catch (err) {
      console.error('load profiles', err);
      setStatus('Failed to load');
    }
  }

  async function save() {
    const { profiles, invalid, duplicates } = collectProfiles();
    if (invalid.length) {
      setStatus(`Save failed (invalid names: ${invalid.join(', ')})`, shaEl?.textContent || null, updatedEl?.textContent || null);
      return;
    }
    if (duplicates.length) {
      const uniq = Array.from(new Set(duplicates));
      setStatus(`Save failed (duplicate names: ${uniq.join(', ')})`, shaEl?.textContent || null, updatedEl?.textContent || null);
      return;
    }

    const base = loadedSettings && typeof loadedSettings === 'object' ? deepClone(loadedSettings) : defaultSettings();
    base.profiles = profiles;

    setStatus('Saving…', lastSavedSha || null, updatedEl?.textContent || null);
    try {
      const res = await fetch('/admin/config/store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ settings: base, sha256: lastSavedSha || undefined }),
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        const errText = await res.text();
        if (errText) message += `: ${errText}`;
        throw new Error(message);
      }
      const json = await res.json();
      const data = json.data || {};
      lastSavedSha = data.sha256 || '';
      loadedSettings = data.settings && typeof data.settings === 'object' ? data.settings : base;
      setStatus(`Saved (${data.status || 'ok'})`, data.sha256 || null, data.updated_at || null);
    } catch (err) {
      console.error('save profiles', err);
      const details = err && err.message ? String(err.message) : '';
      setStatus(details ? `Save failed (${details})` : 'Save failed', shaEl?.textContent || null, updatedEl?.textContent || null);
    }
  }

  function initDomRefs() {
    statusEl = document.getElementById('profilesStatus');
    shaEl = document.getElementById('profilesSha');
    updatedEl = document.getElementById('profilesUpdated');
    profilesRows = document.getElementById('profilesRows');
    addBtn = document.getElementById('addProfileSettingsBtn');
    saveBtn = document.getElementById('saveProfiles');
    reloadBtn = document.getElementById('reloadProfiles');
  }

  let inited = false;
  function init() {
    if (inited) return;
    initDomRefs();
    if (!statusEl || !profilesRows) return;
    inited = true;

    addBtn?.addEventListener('click', () => {
      const defaults = loadedSettings && typeof loadedSettings === 'object' ? loadedSettings : defaultSettings();
      renderProfileRow({}, defaults, { open: true, focusName: true });
      markDirty();
    });
    saveBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      save();
    });
    reloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      load();
    });

    load();
  }

  window.__initProfiles = init;

  const hash = (window.location.hash || '').toLowerCase();
  if (hash.startsWith('#settings/profiles')) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
