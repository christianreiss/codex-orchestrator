(() => {
  const overlay = document.getElementById('adminAuthOverlay');
  const form = document.getElementById('adminAuthForm');
  const usernameInput = document.getElementById('adminAuthUsername');
  const passwordInput = document.getElementById('adminAuthPassword');
  const errorEl = document.getElementById('adminAuthError');
  const noticeEl = document.getElementById('adminAuthNotice');
  const forgotBtn = document.getElementById('adminAuthForgot');
  const logoutBtn = document.getElementById('navLogout');
  const navUser = document.getElementById('navUser');
  const navUserName = document.getElementById('navUserName');

  const resetModal = document.getElementById('adminResetModal');
  const resetClose = document.getElementById('adminResetClose');
  const resetIdentity = document.getElementById('adminResetIdentity');
  const resetToken = document.getElementById('adminResetToken');
  const resetPassword = document.getElementById('adminResetPassword');
  const resetPasswordConfirm = document.getElementById('adminResetPasswordConfirm');
  const resetError = document.getElementById('adminResetError');
  const resetRequest = document.getElementById('adminResetRequest');
  const resetSubmit = document.getElementById('adminResetSubmit');

  if (!overlay) return;

  let authStatus = null;

  function api(path, opts = {}) {
    const headers = { 'Accept': 'application/json', ...(opts.headers || {}) };
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

  function showOverlay(show) {
    overlay.classList.toggle('show', show);
    overlay.setAttribute('aria-hidden', show ? 'false' : 'true');
    document.body.classList.toggle('auth-locked', show);
  }

  function showError(target, message) {
    if (!target) return;
    if (!message) {
      target.textContent = '';
      target.classList.remove('show');
      return;
    }
    target.textContent = message;
    target.classList.add('show');
  }

  function openResetModal(token = '') {
    if (!resetModal) return;
    showOverlay(true);
    resetModal.classList.add('show');
    resetModal.setAttribute('aria-hidden', 'false');
    showError(resetError, '');
    if (token) resetToken.value = token;
  }

  function closeResetModal() {
    if (!resetModal) return;
    resetModal.classList.remove('show');
    resetModal.setAttribute('aria-hidden', 'true');
    showError(resetError, '');
    resetIdentity.value = '';
    resetToken.value = '';
    resetPassword.value = '';
    if (resetPasswordConfirm) resetPasswordConfirm.value = '';
  }

  async function fetchStatus() {
    try {
      const res = await api('/admin/auth/status');
      authStatus = res?.data || null;
      window.__adminAuthStatus = authStatus;
      const enforced = !!authStatus?.enforced;
      const authenticated = !!authStatus?.authenticated;
      const user = authStatus?.user || null;
      if (navUser) {
        if (authenticated) {
          if (navUserName) navUserName.textContent = 'Christian Reiss';
          navUser.style.display = '';
        } else {
          navUser.style.display = 'none';
        }
      }
      if (enforced && !authenticated) {
        showOverlay(true);
        if (noticeEl) noticeEl.textContent = 'Login required to access admin tools.';
      } else {
        showOverlay(false);
      }
      return authStatus;
    } catch (err) {
      showOverlay(true);
      if (noticeEl) noticeEl.textContent = 'Admin access unavailable. Check mTLS and connectivity.';
      showError(errorEl, err.message);
      return null;
    }
  }

  form?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    showError(errorEl, '');
    const username = usernameInput?.value || '';
    const password = passwordInput?.value || '';
    try {
      await api('/admin/auth/login', { method: 'POST', json: { username, password } });
      showOverlay(false);
      window.location.reload();
    } catch (err) {
      showError(errorEl, 'Login failed. Check your credentials.');
    }
  });

  forgotBtn?.addEventListener('click', () => openResetModal());
  resetClose?.addEventListener('click', () => closeResetModal());

  resetRequest?.addEventListener('click', async () => {
    showError(resetError, '');
    try {
      await api('/admin/auth/password/request', {
        method: 'POST',
        json: { identity: resetIdentity?.value || '' },
      });
      showError(resetError, 'If the account exists, a reset email was sent.');
    } catch (err) {
      showError(resetError, err.message);
    }
  });

  resetSubmit?.addEventListener('click', async () => {
    showError(resetError, '');
    const passwordValue = resetPassword?.value || '';
    const confirmValue = resetPasswordConfirm?.value || '';
    if (!passwordValue) {
      showError(resetError, 'Enter a new password.');
      return;
    }
    if (passwordValue !== confirmValue) {
      showError(resetError, 'Password confirmation does not match.');
      return;
    }
    try {
      await api('/admin/auth/password/reset', {
        method: 'POST',
        json: { token: resetToken?.value || '', password: passwordValue },
      });
      showError(resetError, 'Password updated. You can log in now.');
      resetPassword.value = '';
      if (resetPasswordConfirm) resetPasswordConfirm.value = '';
    } catch (err) {
      showError(resetError, err.message);
    }
  });

  logoutBtn?.addEventListener('click', async () => {
    try {
      await api('/admin/auth/logout', { method: 'POST' });
    } catch (_) {
      // ignore
    }
    window.location.reload();
  });

  const hash = window.location.hash || '';
  if (hash.startsWith('#reset')) {
    const query = hash.split('?')[1] || '';
    const params = new URLSearchParams(query);
    const token = params.get('token') || '';
    if (token) openResetModal(token);
  }

  fetchStatus();
})();
