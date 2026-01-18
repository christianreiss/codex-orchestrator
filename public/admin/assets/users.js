(() => {
  const usersPanel = document.getElementById('users-panel');
  if (!usersPanel) return;

  const navUsers = document.querySelector('[data-nav="users"]');
  const menuUsers = Array.from(document.querySelectorAll('.menu-link')).find((el) => el.getAttribute('href') === '#users');

  const addBtn = document.getElementById('usersAddBtn');
  const wipeBtn = document.getElementById('usersWipeBtn');
  const tableBody = document.querySelector('#users-table tbody');
  const emptyState = document.getElementById('usersEmptyState');

  const modal = document.getElementById('usersModal');
  const modalTitle = document.getElementById('usersModalTitle');
  const modalClose = document.getElementById('usersModalClose');
  const modalCancel = document.getElementById('usersModalCancel');
  const modalSave = document.getElementById('usersModalSave');
  const modalError = document.getElementById('usersModalError');

  const inputName = document.getElementById('usersName');
  const inputUsername = document.getElementById('usersUsername');
  const inputEmail = document.getElementById('usersEmail');
  const inputAccess = document.getElementById('usersAccess');
  const inputActive = document.getElementById('usersActive');
  const inputPassword = document.getElementById('usersPassword');
  const inputPasswordConfirm = document.getElementById('usersPasswordConfirm');

  const wipeModal = document.getElementById('usersWipeModal');
  const wipeClose = document.getElementById('usersWipeClose');
  const wipeCancel = document.getElementById('usersWipeCancel');
  const wipeSubmit = document.getElementById('usersWipeSubmit');
  const wipeConfirm = document.getElementById('usersWipeConfirm');
  const wipeError = document.getElementById('usersWipeError');

  let users = [];
  let roles = {
    admin: 'Admin',
    fleet_operator: 'Fleet Operator',
    trusted_user: 'Trusted User',
    user: 'User',
  };
  let editingId = null;

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

  function show(el, on) {
    if (!el) return;
    el.style.display = on ? '' : 'none';
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

  function formatTimestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }

  function parseTimestamp(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function formatRelative(value) {
    const date = parseTimestamp(value);
    if (!date) return '—';
    const now = Date.now();
    const diff = now - date.getTime();
    const future = diff < 0;
    const delta = Math.abs(diff);
    const minutes = Math.round(delta / 60000);
    const hours = Math.round(delta / 3600000);
    const days = Math.round(delta / 86400000);
    const suffix = future ? 'from now' : 'ago';
    if (delta < 45 * 1000) return future ? 'in a few seconds' : 'just now';
    if (delta < 90 * 1000) return future ? 'in 1 minute' : '1 minute ago';
    if (delta < 45 * 60 * 1000) return `${minutes} min ${suffix}`;
    if (delta < 36 * 60 * 60 * 1000) return `${hours} h ${suffix}`;
    if (delta < 14 * 24 * 60 * 60 * 1000) return `${days} d ${suffix}`;
    return formatTimestamp(value);
  }

  function hydrateRoles(status) {
    roles = status?.roles || roles;
    if (!inputAccess) return;
    inputAccess.innerHTML = Object.entries(roles)
      .map(([key, label]) => `<option value="${key}">${label}</option>`)
      .join('');
  }

  function renderUsers() {
    if (!tableBody) return;
    tableBody.innerHTML = '';
    if (!Array.isArray(users) || users.length === 0) {
      show(emptyState, true);
      show(wipeBtn, false);
      return;
    }
    show(emptyState, false);
    show(wipeBtn, true);

    tableBody.innerHTML = users.map((user) => {
      const access = roles[user.access_level] || user.access_level;
      const status = user.active ? 'Active' : 'Disabled';
      const lastLoginAt = user.last_login_at || '';
      const lastLoginLabel = formatTimestamp(lastLoginAt);
      const lastLoginRelative = lastLoginAt ? formatRelative(lastLoginAt) : '—';
      const lastLoginSub = lastLoginRelative !== '—'
        ? `<div class="table-subtext">${lastLoginRelative}</div>`
        : '';
      return `
        <tr data-user-id="${user.id}">
          <td>${escapeHtml(user.name)}</td>
          <td>${escapeHtml(user.username)}</td>
          <td>${escapeHtml(user.email)}</td>
          <td>${escapeHtml(access)}</td>
          <td>${status}</td>
          <td><div>${lastLoginLabel}</div>${lastLoginSub}</td>
          <td class="row-actions">
            <button class="ghost tiny-btn" data-action="edit">Edit</button>
            <button class="ghost tiny-btn" data-action="delete">Delete</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function openModal(user = null) {
    editingId = user ? user.id : null;
    if (modalTitle) modalTitle.textContent = user ? 'Edit user' : 'Add user';
    inputName.value = user?.name || '';
    inputUsername.value = user?.username || '';
    inputEmail.value = user?.email || '';
    inputAccess.value = user?.access_level || Object.keys(roles)[0] || 'admin';
    inputActive.checked = user?.active ?? true;
    inputPassword.value = '';
    if (inputPasswordConfirm) inputPasswordConfirm.value = '';
    showError(modalError, '');
    modal?.classList.add('show');
  }

  function closeModal() {
    modal?.classList.remove('show');
    editingId = null;
    showError(modalError, '');
  }

  function openWipeModal() {
    wipeConfirm.value = '';
    showError(wipeError, '');
    wipeModal?.classList.add('show');
  }

  function closeWipeModal() {
    wipeModal?.classList.remove('show');
    showError(wipeError, '');
  }

  async function loadUsers() {
    try {
      const res = await api('/admin/users');
      users = res?.data?.users || [];
      renderUsers();
    } catch (err) {
      showError(modalError, err.message);
    }
  }

  async function ensureStatus() {
    const status = window.__adminAuthStatus;
    if (status) {
      hydrateRoles(status);
      return status;
    }
    try {
      const res = await api('/admin/auth/status');
      window.__adminAuthStatus = res?.data || null;
      hydrateRoles(res?.data || null);
      return res?.data || null;
    } catch (_) {
      return null;
    }
  }

  function hideUsersNav() {
    navUsers?.remove();
    menuUsers?.remove();
  }

  async function init() {
    const status = await ensureStatus();
    const user = status?.user || null;
    const isAdmin = user?.access_level === 'admin' || status?.admin_count === 0;

    if (!isAdmin) {
      hideUsersNav();
      return;
    }

    await loadUsers();
  }

  addBtn?.addEventListener('click', () => openModal(null));
  wipeBtn?.addEventListener('click', () => openWipeModal());
  modalClose?.addEventListener('click', closeModal);
  modalCancel?.addEventListener('click', closeModal);
  modal?.addEventListener('click', (ev) => {
    if (ev.target === modal) closeModal();
  });

  wipeClose?.addEventListener('click', closeWipeModal);
  wipeCancel?.addEventListener('click', closeWipeModal);
  wipeModal?.addEventListener('click', (ev) => {
    if (ev.target === wipeModal) closeWipeModal();
  });

  modalSave?.addEventListener('click', async () => {
    showError(modalError, '');
    const passwordValue = inputPassword.value;
    const confirmValue = inputPasswordConfirm?.value || '';
    if (passwordValue && passwordValue !== confirmValue) {
      showError(modalError, 'Password confirmation does not match.');
      return;
    }
    if (!passwordValue && confirmValue) {
      showError(modalError, 'Enter a password before confirming.');
      return;
    }
    const payload = {
      name: inputName.value,
      username: inputUsername.value,
      email: inputEmail.value,
      access_level: inputAccess.value,
      active: inputActive.checked,
    };
    if (passwordValue) {
      payload.password = passwordValue;
    }

    try {
      if (editingId) {
        const res = await api(`/admin/users/${editingId}`, { method: 'POST', json: payload });
        const updated = res?.data?.user;
        users = users.map((u) => (u.id === updated.id ? updated : u));
      } else {
        const res = await api('/admin/users', { method: 'POST', json: payload });
        const created = res?.data?.user;
        users = [...users, created].sort((a, b) => a.username.localeCompare(b.username));
      }
      closeModal();
      renderUsers();
      await ensureStatus();
    } catch (err) {
      showError(modalError, err.message);
    }
  });

  tableBody?.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const row = btn.closest('tr');
    if (!row) return;
    const id = Number(row.dataset.userId || 0);
    const user = users.find((u) => u.id === id);
    if (!user) return;
    const action = btn.dataset.action;

    if (action === 'edit') {
      openModal(user);
    } else if (action === 'delete') {
      if (!confirm(`Delete user ${user.username}?`)) return;
      try {
        await api(`/admin/users/${id}`, { method: 'DELETE' });
        users = users.filter((u) => u.id !== id);
        renderUsers();
        await ensureStatus();
      } catch (err) {
        showError(modalError, err.message);
      }
    }
  });

  wipeSubmit?.addEventListener('click', async () => {
    showError(wipeError, '');
    if (wipeConfirm.value !== 'WIPE') {
      showError(wipeError, 'Type WIPE to confirm.');
      return;
    }
    try {
      await api('/admin/users/wipe', { method: 'POST', json: { confirm: 'WIPE' } });
      users = [];
      renderUsers();
      closeWipeModal();
      window.location.reload();
    } catch (err) {
      showError(wipeError, err.message);
    }
  });

  init();
})();
