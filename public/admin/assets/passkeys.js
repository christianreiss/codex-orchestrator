(() => {
  const panel = document.getElementById('passkeys-panel');
  if (!panel) return;

  const registerBtn = document.getElementById('passkeysRegisterBtn');
  const tableBody = document.querySelector('#passkeys-table tbody');
  const emptyState = document.getElementById('passkeysEmptyState');
  const unsupportedNote = document.getElementById('passkeysUnsupportedNote');

  let passkeys = [];

  function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const init = { cache: 'no-store', headers, method: opts.method || 'GET' };
    if (Object.prototype.hasOwnProperty.call(opts, 'json')) {
      init.body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    }
    return fetch(path, init).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    });
  }

  function show(el, on) {
    if (!el) return;
    el.style.display = on ? '' : 'none';
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTimestamp(value) {
    if (!value) return '\u2014';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  function hexToUint8Array(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function base64urlToUint8Array(base64url) {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function render() {
    if (!tableBody) return;
    tableBody.innerHTML = '';

    if (!Array.isArray(passkeys) || passkeys.length === 0) {
      show(emptyState, true);
      return;
    }
    show(emptyState, false);

    tableBody.innerHTML = passkeys.map((pk) => `
      <tr data-passkey-id="${pk.id}">
        <td>${escapeHtml(pk.name)}</td>
        <td>${formatTimestamp(pk.created_at)}</td>
        <td>${formatTimestamp(pk.last_used_at)}</td>
        <td class="row-actions">
          <button class="ghost tiny-btn" data-action="rename">Rename</button>
          <button class="ghost tiny-btn" data-action="delete">Delete</button>
        </td>
      </tr>
    `).join('');
  }

  async function loadPasskeys() {
    try {
      const res = await api('/admin/passkeys');
      passkeys = res?.data?.passkeys || [];
      render();
    } catch (_) {
      passkeys = [];
      render();
    }
  }

  async function registerPasskey() {
    if (!window.PublicKeyCredential) {
      if (window.__toast) window.__toast({ message: 'WebAuthn is not supported in this browser.', level: 'warn' });
      return;
    }

    try {
      registerBtn.disabled = true;
      registerBtn.textContent = 'Registering\u2026';

      const optRes = await api('/admin/auth/passkey/register/options', { method: 'POST' });
      const options = optRes.data;

      const publicKey = {
        challenge: hexToUint8Array(options.challenge).buffer,
        rp: options.rp,
        user: {
          id: base64urlToUint8Array(options.user.id).buffer,
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        attestation: options.attestation,
        authenticatorSelection: options.authenticatorSelection,
        excludeCredentials: (options.excludeCredentials || []).map((c) => ({
          type: c.type,
          id: base64urlToUint8Array(c.id).buffer,
          transports: c.transports,
        })),
      };

      const credential = await navigator.credentials.create({ publicKey });

      const body = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          attestationObject: bufferToBase64url(credential.response.attestationObject),
          clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
          transports: typeof credential.response.getTransports === 'function'
            ? credential.response.getTransports()
            : [],
        },
      };

      const regRes = await api('/admin/auth/passkey/register', { method: 'POST', json: body });
      const passkey = regRes?.data?.passkey;

      await loadPasskeys();

      // Inline rename for the new passkey.
      if (passkey?.id && tableBody) {
        const row = tableBody.querySelector(`tr[data-passkey-id="${passkey.id}"]`);
        if (row) startInlineRename(row, passkey.id, passkey.name || 'My Passkey');
      }
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        if (window.__toast) window.__toast({ message: 'Passkey registration failed: ' + (err.message || 'Unknown error'), level: 'error' });
      }
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = '+ Register passkey';
    }
  }

  async function deletePasskey(id) {
    if (!window.__confirm || !await window.__confirm('Delete passkey', 'Delete this passkey?', { action: 'Delete' })) return;
    try {
      await api(`/admin/passkeys/${id}`, { method: 'DELETE' });
      await loadPasskeys();
    } catch (err) {
      if (window.__toast) window.__toast({ message: 'Failed to delete passkey: ' + (err.message || 'Unknown error'), level: 'error' });
    }
  }

  function startInlineRename(row, id, currentName) {
    const cell = row?.cells?.[0];
    if (!cell) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-rename';
    input.value = currentName;
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();
    let submitted = false;
    async function submit() {
      if (submitted) return;
      submitted = true;
      const val = input.value.trim();
      if (val && val !== currentName) {
        try {
          await api(`/admin/passkeys/${id}/name`, { method: 'POST', json: { name: val } });
        } catch (err) {
          if (window.__toast) window.__toast({ message: 'Failed to rename passkey: ' + (err.message || 'Unknown error'), level: 'error' });
        }
      }
      await loadPasskeys();
    }
    input.addEventListener('blur', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { submitted = true; loadPasskeys(); }
    });
  }

  async function renamePasskey(id) {
    if (!tableBody) return;
    const row = tableBody.querySelector(`tr[data-passkey-id="${id}"]`);
    const pk = passkeys.find((p) => p.id === id);
    if (row) startInlineRename(row, id, pk?.name || '');
  }

  if (tableBody) {
    tableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const row = btn.closest('tr');
      const id = row ? parseInt(row.dataset.passkeyId, 10) : 0;
      if (!id) return;
      if (btn.dataset.action === 'delete') deletePasskey(id);
      if (btn.dataset.action === 'rename') renamePasskey(id);
    });
  }

  if (registerBtn) {
    registerBtn.addEventListener('click', registerPasskey);
  }

  async function init() {
    let status = window.__adminAuthStatus;
    if (!status && window.__adminAuthStatusPromise) {
      status = await window.__adminAuthStatusPromise;
    }
    if (!status) {
      try {
        const res = await api('/admin/auth/status');
        status = res?.data || null;
        window.__adminAuthStatus = status;
      } catch (_) {
        return;
      }
    }

    if (!status?.authenticated) return;

    const supported = !!window.PublicKeyCredential;
    show(unsupportedNote, !supported);
    if (registerBtn) {
      registerBtn.disabled = !supported;
      registerBtn.style.display = supported ? '' : 'none';
    }
    show(panel, true);
    await loadPasskeys();
  }

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

  // Expose refresh for live updates.
  window.__passkeysRefresh = loadPasskeys;
})();
