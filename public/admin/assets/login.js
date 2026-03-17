(() => {
  // Respect dashboard theme preference
  try {
    const stored = localStorage.getItem('adminTheme');
    if (stored && ['auto', 'light', 'dark'].includes(stored)) {
      document.body.dataset.theme = stored;
    }
  } catch (_) {}

  const form = document.getElementById('adminLoginForm');
  const usernameInput = document.getElementById('adminLoginUsername');
  const passwordInput = document.getElementById('adminLoginPassword');
  const errorEl = document.getElementById('adminLoginError');
  const submitBtn = document.getElementById('adminLoginSubmit');

  if (!form || !usernameInput || !passwordInput || !errorEl || !submitBtn) {
    return;
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

  function setBusy(isBusy) {
    submitBtn.disabled = isBusy;
    const label = submitBtn.querySelector('.btn-label');
    if (label) {
      label.textContent = isBusy ? 'Signing in\u2026' : 'Sign in';
    } else {
      submitBtn.textContent = isBusy ? 'Signing in\u2026' : 'Sign in';
    }
    usernameInput.disabled = isBusy;
    passwordInput.disabled = isBusy;
  }

  async function hydrateStatus() {
    try {
      const res = await api('/admin/auth/status');
      const status = res?.data || null;
      if (!status) {
        return;
      }

      if (status.authenticated || !status.enforced) {
        window.location.replace('/admin/');
        return;
      }

      usernameInput.focus();
    } catch (err) {
      setError('Admin access unavailable. Check mTLS and connectivity.');
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError('');

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) {
      setError('Enter username and password.');
      return;
    }

    setBusy(true);

    try {
      await api('/admin/auth/login', {
        method: 'POST',
        json: { username, password },
      });
      window.location.replace('/admin/');
    } catch (_) {
      setBusy(false);
      setError('Login failed. Check your credentials.');
      passwordInput.focus();
    }
  });

  hydrateStatus();
})();
