(() => {
  const logoutBtn = document.getElementById('navLogout');
  const navUser = document.getElementById('navUser');
  const navUserName = document.getElementById('navUserName');

  if (!logoutBtn && !navUser) {
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

  function showNavUser(user) {
    if (!navUser) {
      return;
    }

    if (!user) {
      navUser.style.display = 'none';
      return;
    }

    if (navUserName) {
      navUserName.textContent = user.name || user.username || 'Authenticated user';
    }
    navUser.style.display = '';
  }

  async function fetchStatus() {
    try {
      const res = await api('/admin/auth/status');
      const authStatus = res?.data || null;
      window.__adminAuthStatus = authStatus;

      const enforced = !!authStatus?.enforced;
      const authenticated = !!authStatus?.authenticated;
      const user = authenticated ? authStatus?.user || null : null;

      showNavUser(user);

      if (enforced && !authenticated) {
        window.location.replace('/admin/login');
        return null;
      }

      return authStatus;
    } catch (_) {
      showNavUser(null);
      return null;
    }
  }

  logoutBtn?.addEventListener('click', async () => {
    try {
      await api('/admin/auth/logout', { method: 'POST' });
    } catch (_) {
      // Best effort logout.
    }
    window.location.replace('/admin/login');
  });

  fetchStatus();
})();
