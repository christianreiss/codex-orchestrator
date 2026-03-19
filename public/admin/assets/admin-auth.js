(() => {
  const accountGroup = document.getElementById('navAccountGroup');
  const logoutBtn = document.getElementById('navLogout');
  const accountSummary = document.getElementById('navAccountSummary');
  const accountName = document.getElementById('navAccountName');
  const accountTriggerLabel = document.getElementById('navAccountTriggerLabel');
  const passwordLink = document.getElementById('navAccountPasswordLink');
  const passkeysLink = document.getElementById('navAccountPasskeysLink');
  const logoutModal = document.getElementById('logoutModal');
  const logoutCancel = document.getElementById('logoutCancel');
  const logoutConfirm = document.getElementById('logoutConfirm');

  if (!logoutBtn && !accountSummary) {
    return;
  }

  const bootstrapStatus = (window.__adminBootstrap && typeof window.__adminBootstrap === 'object')
    ? window.__adminBootstrap
    : null;

  function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    const init = {
      cache: 'no-store',
      credentials: 'same-origin',
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

  function show(el, on) {
    if (!el) return;
    el.style.display = on ? '' : 'none';
  }

  function showLogoutModal(open) {
    if (!logoutModal) return;
    logoutModal.classList.toggle('show', Boolean(open));
  }

  function showAccountState(user) {
    const authenticated = Boolean(user);
    show(accountGroup, authenticated);
    show(accountSummary, authenticated);
    show(passwordLink, authenticated);
    show(passkeysLink, authenticated);
    show(logoutBtn, authenticated);

    const label = authenticated
      ? (user.name || user.username || 'Authenticated user')
      : 'Authenticated user';

    if (accountName) {
      accountName.textContent = label;
    }
    if (accountTriggerLabel) {
      accountTriggerLabel.textContent = label;
    }

    if (!authenticated) {
      showLogoutModal(false);
    }
  }

  function applyAuthStatus(rawStatus) {
    const authStatus = rawStatus && typeof rawStatus === 'object' ? rawStatus : null;
    window.__adminAuthStatus = authStatus;
    document.dispatchEvent(new CustomEvent('admin-auth-status', { detail: authStatus }));

    const enforced = !!authStatus?.enforced;
    const authenticated = !!authStatus?.authenticated;
    const user = authenticated ? authStatus?.user || null : null;

    showAccountState(user);

    if (enforced && !authenticated) {
      window.location.replace('/admin/login');
      return null;
    }

    return authStatus;
  }

  async function fetchStatus() {
    try {
      const res = await api('/admin/auth/status');
      return applyAuthStatus(res?.data || null);
    } catch (_) {
      return applyAuthStatus(bootstrapStatus);
    }
  }

  async function performLogout() {
    try {
      await api('/admin/auth/logout', { method: 'POST' });
    } catch (_) {
      // Best effort logout.
    }
    window.location.replace('/admin/login');
  }

  logoutBtn?.addEventListener('click', () => {
    window.__railNav?.closeMenus?.();
    showLogoutModal(true);
  });

  logoutCancel?.addEventListener('click', () => {
    showLogoutModal(false);
  });

  logoutModal?.addEventListener('click', (event) => {
    if (event.target === logoutModal) {
      showLogoutModal(false);
    }
  });

  logoutConfirm?.addEventListener('click', async () => {
    if (logoutConfirm) logoutConfirm.disabled = true;
    try {
      await performLogout();
    } finally {
      if (logoutConfirm) logoutConfirm.disabled = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    showLogoutModal(false);
  });

  if (bootstrapStatus) {
    applyAuthStatus(bootstrapStatus);
  }

  window.__adminAuthStatusPromise = fetchStatus();
})();
