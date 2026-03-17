(() => {
  const passkeyBtn = document.getElementById('passkeyLoginBtn');
  const passkeyDivider = document.getElementById('passkeyDivider');
  const errorEl = document.getElementById('adminLoginError');
  const usernameInput = document.getElementById('adminLoginUsername');

  if (!passkeyBtn || !usernameInput || !window.PublicKeyCredential || !window.isSecureContext) return;

  function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const init = { cache: 'no-store', headers, method: opts.method || 'GET' };
    if (Object.prototype.hasOwnProperty.call(opts, 'json')) {
      init.body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    }
    return fetch(path, init).then(async (res) => {
      const text = await res.text();
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch (_) {
          body = null;
        }
      }
      if (!res.ok) {
        const message = body?.message || `HTTP ${res.status}`;
        throw new Error(message);
      }
      return body;
    });
  }

  function hexToUint8Array(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function bufferToBase64url(buffer) {
    const bytes = new Uint8Array(buffer);
    let str = '';
    for (const b of bytes) str += String.fromCharCode(b);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function setError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
  }

  // Check auth status to decide whether to show the passkey button.
  api('/admin/auth/status').then((res) => {
    const data = res?.data;
    if (!data) return;
    if (data.authenticated || !data.enforced) return;
    if (!data.passkey_login_available) return;

    passkeyBtn.style.display = '';
    if (passkeyDivider) passkeyDivider.style.display = '';
  }).catch(() => {});

  passkeyBtn.addEventListener('click', async () => {
    setError('');
    const username = usernameInput.value.trim();
    if (!username) {
      setError('Enter your username to use passkey login.');
      usernameInput.focus();
      return;
    }

    passkeyBtn.disabled = true;
    passkeyBtn.textContent = 'Authenticating\u2026';
    usernameInput.disabled = true;

    try {
      const optRes = await api('/admin/auth/passkey/login/options', {
        method: 'POST',
        json: { username },
      });
      const options = optRes.data;

      const publicKey = {
        challenge: hexToUint8Array(options.challenge).buffer,
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
        allowCredentials: (options.allowCredentials || []).map((c) => ({
          type: c.type,
          id: hexToUint8Array(c.id).buffer,
        })),
      };

      const credential = await navigator.credentials.get({ publicKey });

      const body = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          authenticatorData: bufferToBase64url(credential.response.authenticatorData),
          clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
          signature: bufferToBase64url(credential.response.signature),
          userHandle: credential.response.userHandle
            ? bufferToBase64url(credential.response.userHandle)
            : null,
        },
      };

      await api('/admin/auth/passkey/login', { method: 'POST', json: body });
      window.location.replace('/admin/');
    } catch (err) {
      passkeyBtn.disabled = false;
      passkeyBtn.textContent = 'Sign in with passkey';
      usernameInput.disabled = false;
      if (err.name === 'NotAllowedError') return;
      setError(err.message || 'Passkey login failed.');
    }
  });
})();
