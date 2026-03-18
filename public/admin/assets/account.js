(() => {
  const accountPanel = document.getElementById('accountPanel');
  if (!accountPanel) return;

  const accessNotice = document.getElementById('accountAccessNotice');
  const privatePanels = Array.from(accountPanel.querySelectorAll('[data-account-panel]'));

  const currentPasswordInput = document.getElementById('accountCurrentPassword');
  const newPasswordInput = document.getElementById('accountNewPassword');
  const confirmPasswordInput = document.getElementById('accountConfirmPassword');
  const resetBtn = document.getElementById('accountPasswordReset');
  const saveBtn = document.getElementById('accountPasswordSave');
  const errorEl = document.getElementById('accountPasswordError');
  const statusEl = document.getElementById('accountPasswordStatus');

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

  function show(el, on) {
    if (!el) return;
    el.hidden = !on;
  }

  function setError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.classList.toggle('show', Boolean(message));
  }

  function setStatus(message) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
  }

  function clearPasswordForm() {
    if (currentPasswordInput) currentPasswordInput.value = '';
    if (newPasswordInput) newPasswordInput.value = '';
    if (confirmPasswordInput) confirmPasswordInput.value = '';
    setError('');
    setStatus('');
  }

  async function ensureStatus() {
    if (window.__adminAuthStatus) {
      return window.__adminAuthStatus;
    }
    if (window.__adminAuthStatusPromise) {
      return window.__adminAuthStatusPromise;
    }
    try {
      const res = await api('/admin/auth/status');
      window.__adminAuthStatus = res?.data || null;
      return window.__adminAuthStatus;
    } catch (_) {
      return null;
    }
  }

  function syncAccountAccess(status) {
    const authenticated = !!status?.authenticated;
    show(accessNotice, !authenticated);

    if (!authenticated) {
      privatePanels.forEach((panel) => {
        panel.hidden = true;
      });
      return;
    }

    const accountTab = (document.body?.dataset?.accountTab || 'password').toLowerCase();
    privatePanels.forEach((panel) => {
      const tab = (panel.dataset.accountPanel || '').toLowerCase();
      panel.hidden = tab !== accountTab;
    });
  }

  async function submitPasswordChange() {
    const currentPassword = String(currentPasswordInput?.value || '');
    const newPassword = String(newPasswordInput?.value || '');
    const confirmPassword = String(confirmPasswordInput?.value || '');

    setError('');
    setStatus('');

    if (!currentPassword) {
      setError('Enter your current password.');
      currentPasswordInput?.focus();
      return;
    }
    if (!newPassword) {
      setError('Enter a new password.');
      newPasswordInput?.focus();
      return;
    }
    if (!confirmPassword) {
      setError('Confirm the new password.');
      confirmPasswordInput?.focus();
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Password confirmation does not match.');
      confirmPasswordInput?.focus();
      return;
    }

    if (saveBtn) saveBtn.disabled = true;

    try {
      await api('/admin/auth/password/change', {
        method: 'POST',
        json: {
          current_password: currentPassword,
          new_password: newPassword,
          confirm_password: confirmPassword,
        },
      });
      clearPasswordForm();
      setStatus('Password updated. Other sessions were signed out.');
    } catch (err) {
      setError(err.message || 'Password update failed.');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  resetBtn?.addEventListener('click', clearPasswordForm);
  saveBtn?.addEventListener('click', submitPasswordChange);

  document.addEventListener('admin-auth-status', (event) => {
    syncAccountAccess(event.detail || null);
  });

  if (document.body && typeof MutationObserver === 'function') {
    const routeObserver = new MutationObserver(() => {
      syncAccountAccess(window.__adminAuthStatus || null);
    });
    routeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-view-mode', 'data-account-tab'],
    });
  }

  ensureStatus().then((status) => {
    syncAccountAccess(status);
  });
})();
