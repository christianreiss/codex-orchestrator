(() => {
  function resolveTheme(theme) {
    if (theme !== 'auto-pink') {
      return theme;
    }
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark-pink'
        : 'bright-pink';
    } catch (_) {
      return 'bright-pink';
    }
  }

  // Respect dashboard theme preference
  try {
    const stored = localStorage.getItem('adminTheme');
    if (stored && ['auto', 'auto-pink', 'light', 'dark', 'bright-pink', 'dark-pink'].includes(stored)) {
      document.body.dataset.theme = resolveTheme(stored);
    }
  } catch (_) {}

  // Resolve safe return URL from ?return= query param (same-origin paths only).
  const loginReturnUrl = (() => {
    try {
      const p = new URLSearchParams(window.location.search).get('return');
      if (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')) {
        return p;
      }
    } catch (_) {}
    return '/admin/';
  })();

  const form = document.getElementById('adminLoginForm');
  const loginCopy = document.getElementById('adminLoginCopy');
  const usernameInput = document.getElementById('adminLoginUsername');
  const passwordField = document.getElementById('adminLoginPasswordField');
  const passwordInput = document.getElementById('adminLoginPassword');
  const errorEl = document.getElementById('adminLoginError');
  const submitBtn = document.getElementById('adminLoginSubmit');

  if (!form || !loginCopy || !usernameInput || !passwordField || !passwordInput || !errorEl || !submitBtn) {
    return;
  }

  const state = {
    step: 'username',
    stagedUsername: '',
  };

  function warmAdminShell() {
    if (typeof window.fetch !== 'function') {
      return;
    }

    const hrefs = Array.from(document.querySelectorAll('link[data-admin-prefetch][href]'))
      .map((node) => node.getAttribute('href') || '')
      .filter(Boolean);

    hrefs.forEach((href) => {
      window.fetch(href, {
        credentials: 'same-origin',
        cache: 'force-cache',
      }).catch(() => {});
    });
  }

  function scheduleAdminShellWarmup() {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => warmAdminShell(), { timeout: 1200 });
      return;
    }
    window.setTimeout(() => warmAdminShell(), 180);
  }

  function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const init = {
      cache: 'no-store',
      headers,
      method: opts.method || 'GET',
    };

    if (Object.prototype.hasOwnProperty.call(opts, 'json')) {
      init.body = JSON.stringify(opts.json);
      headers['Content-Type'] = 'application/json';
    }

    return fetch(path, init).then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json();
    });
  }

  function setError(message) {
    errorEl.textContent = '';
    if (message) {
      requestAnimationFrame(() => {
        errorEl.textContent = message;
      });
    }
  }

  function normalizeUsername(value) {
    return value.trim().toLowerCase();
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
    for (const b of bytes) {
      str += String.fromCharCode(b);
    }
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function setStep(step, username = '') {
    state.step = step;
    state.stagedUsername = step === 'password' ? normalizeUsername(username) : '';
    passwordField.hidden = step !== 'password';
    passwordInput.required = step === 'password';
    if (step !== 'password') {
      passwordInput.value = '';
    }
    loginCopy.textContent = step === 'password'
      ? 'Password login is allowed for this account.'
      : 'Enter your username to continue.';
  }

  function setBusy(isBusy, busyLabel = 'Working\u2026') {
    submitBtn.disabled = isBusy;
    const label = submitBtn.querySelector('.btn-label');
    if (label) {
      label.textContent = isBusy ? busyLabel : 'Login';
    } else {
      submitBtn.textContent = isBusy ? busyLabel : 'Login';
    }
    usernameInput.disabled = isBusy;
    passwordInput.disabled = isBusy || state.step !== 'password';
  }

  async function hydrateStatus() {
    try {
      const res = await api('/admin/auth/status');
      const status = res?.data || null;
      if (!status) {
        return;
      }

      if (status.authenticated || !status.enforced) {
        window.location.replace(loginReturnUrl);
        return;
      }

      setStep('username');
      usernameInput.focus();
    } catch (err) {
      setError('Admin access unavailable. Check mTLS and connectivity.');
    }
  }

  async function beginPasskeyLogin(username) {
    if (!window.PublicKeyCredential || !window.isSecureContext) {
      throw new Error('Passkey login is unavailable in this browser.');
    }

    const optRes = await api('/admin/auth/passkey/login/options', {
      method: 'POST',
      json: { username },
    });
    const options = optRes?.data || {};

    const publicKey = {
      challenge: hexToUint8Array(options.challenge).buffer,
      rpId: options.rpId,
      timeout: options.timeout,
      userVerification: options.userVerification,
      allowCredentials: (options.allowCredentials || []).map((credential) => ({
        type: credential.type,
        id: hexToUint8Array(credential.id).buffer,
      })),
    };

    const credential = await navigator.credentials.get({ publicKey });
    if (!credential) {
      throw new Error('Passkey login failed.');
    }

    await api('/admin/auth/passkey/login', {
      method: 'POST',
      json: {
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
      },
    });
  }

  async function handleUsernameSubmit(username) {
    setBusy(true, 'Checking\u2026');

    try {
      const response = await api('/admin/auth/login/method', {
        method: 'POST',
        json: { username },
      });
      const method = response?.data?.method;

      if (method === 'password') {
        setStep('password', username);
        setBusy(false);
        passwordInput.focus();
        return;
      }

      if (method === 'passkey') {
        await beginPasskeyLogin(username);
        window.location.replace(loginReturnUrl);
        return;
      }

      throw new Error('Unsupported login method.');
    } catch (err) {
      setBusy(false);
      setStep('username');
      if (err?.name === 'NotAllowedError') {
        setError('Passkey login was canceled.');
        return;
      }
      setError('Login failed. Check your credentials.');
      usernameInput.focus();
    }
  }

  async function handlePasswordSubmit(username, password) {
    setBusy(true, 'Logging in\u2026');

    try {
      await api('/admin/auth/login', {
        method: 'POST',
        json: { username, password },
      });
      window.location.replace(loginReturnUrl);
    } catch (_) {
      setBusy(false);
      setError('Login failed. Check your credentials.');
      passwordInput.focus();
    }
  }

  usernameInput.addEventListener('input', () => {
    if (state.step !== 'password') {
      return;
    }

    if (normalizeUsername(usernameInput.value) !== state.stagedUsername) {
      setError('');
      setStep('username');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('');

    const username = usernameInput.value.trim();
    if (!username) {
      setError('Enter your username.');
      usernameInput.focus();
      return;
    }

    if (state.step !== 'password') {
      await handleUsernameSubmit(username);
      return;
    }

    const password = passwordInput.value;
    if (!password) {
      setError('Enter your password.');
      passwordInput.focus();
      return;
    }

    await handlePasswordSubmit(username, password);
  });

  scheduleAdminShellWarmup();
  hydrateStatus();
})();
