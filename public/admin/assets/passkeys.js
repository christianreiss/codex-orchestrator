(() => {
  const panel = document.getElementById('passkeys-panel');
  if (!panel) return;

  const registerBtn = document.getElementById('passkeysRegisterBtn');
  const tableBody = document.querySelector('#passkeys-table tbody');
  const emptyState = document.getElementById('passkeysEmptyState');

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
      alert('WebAuthn is not supported in this browser.');
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

      // Prompt for a name.
      if (passkey?.id) {
        const name = prompt('Give this passkey a name:', passkey.name || 'My Passkey');
        if (name && name.trim()) {
          try {
            await api(`/admin/passkeys/${passkey.id}/name`, {
              method: 'POST',
              json: { name: name.trim() },
            });
          } catch (_) {}
        }
      }

      await loadPasskeys();
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        alert('Passkey registration failed: ' + (err.message || 'Unknown error'));
      }
    } finally {
      registerBtn.disabled = false;
      registerBtn.textContent = '+ Register passkey';
    }
  }

  async function deletePasskey(id) {
    if (!confirm('Delete this passkey?')) return;
    try {
      await api(`/admin/passkeys/${id}`, { method: 'DELETE' });
      await loadPasskeys();
    } catch (err) {
      alert('Failed to delete passkey: ' + (err.message || 'Unknown error'));
    }
  }

  async function renamePasskey(id) {
    const pk = passkeys.find((p) => p.id === id);
    const name = prompt('Rename passkey:', pk?.name || '');
    if (!name || !name.trim()) return;
    try {
      await api(`/admin/passkeys/${id}/name`, {
        method: 'POST',
        json: { name: name.trim() },
      });
      await loadPasskeys();
    } catch (err) {
      alert('Failed to rename passkey: ' + (err.message || 'Unknown error'));
    }
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
    // Only show when authenticated and WebAuthn is supported.
    if (!window.PublicKeyCredential) return;

    let status = window.__adminAuthStatus;
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

    show(panel, true);
    await loadPasskeys();
  }

  // Wait for the users panel to initialize first, then load passkeys.
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

  // Expose refresh for live updates.
  window.__passkeysRefresh = loadPasskeys;
})();
