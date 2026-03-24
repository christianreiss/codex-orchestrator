(() => {
  const usersPanel = document.getElementById('users-panel');
  if (!usersPanel) return;

  const navUsers = document.querySelector('[data-nav="users"]');

  const filterInput = document.getElementById('users-filter');
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
  let userFilterText = '';
  let roles = {
    admin: 'Admin',
    fleet_operator: 'Fleet Operator',
    trusted_user: 'Trusted User',
    user: 'User',
  };
  let editingId = null;
  let userSort = { key: 'username', direction: 'asc' };
  let usersEnabled = false;
  let usersLiveRefreshTimer = null;
  let usersLiveRefreshInFlight = false;
  let usersLiveRefreshQueued = false;

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

  const ROLE_ORDER = { admin: 0, fleet_operator: 1, trusted_user: 2, user: 3 };

  function filteredUsers() {
    if (!userFilterText) return users;
    const needle = userFilterText.toLowerCase();
    return users.filter((u) => {
      const access = (roles[u.access_level] || u.access_level || '').toLowerCase();
      return (u.name || '').toLowerCase().includes(needle)
        || (u.username || '').toLowerCase().includes(needle)
        || (u.email || '').toLowerCase().includes(needle)
        || access.includes(needle);
    });
  }

  function sortedUsers() {
    const list = [...filteredUsers()];
    const { key, direction } = userSort;
    list.sort((a, b) => {
      let aVal, bVal;
      if (key === 'name') {
        aVal = (a.name || '').toLowerCase();
        bVal = (b.name || '').toLowerCase();
      } else if (key === 'username') {
        aVal = (a.username || '').toLowerCase();
        bVal = (b.username || '').toLowerCase();
      } else if (key === 'access') {
        aVal = ROLE_ORDER[a.access_level] ?? 99;
        bVal = ROLE_ORDER[b.access_level] ?? 99;
      } else if (key === 'status') {
        aVal = a.active ? 0 : 1;
        bVal = b.active ? 0 : 1;
      } else if (key === 'last_login') {
        const aTs = a.last_login_at ? new Date(a.last_login_at).getTime() : 0;
        const bTs = b.last_login_at ? new Date(b.last_login_at).getTime() : 0;
        aVal = aTs;
        bVal = bTs;
      } else {
        return 0;
      }
      let result;
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        result = aVal - bVal;
      } else {
        result = String(aVal).localeCompare(String(bVal), undefined, { sensitivity: 'base' });
      }
      return direction === 'desc' ? -result : result;
    });
    return list;
  }

  function updateUserSortIndicators() {
    document.querySelectorAll('#users-table .sort-link[data-users-sort]').forEach((link) => {
      const key = link.getAttribute('data-users-sort');
      const indicator = link.querySelector('.sort-indicator');
      const isActive = key === userSort.key;
      link.classList.toggle('sorted', isActive);
      link.setAttribute('aria-sort', isActive ? (userSort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      if (indicator) {
        indicator.textContent = isActive ? (userSort.direction === 'asc' ? '▲' : '▼') : '↕';
      }
    });
  }

  function renderUsers() {
    if (!tableBody) return;
    tableBody.innerHTML = '';
    if (!Array.isArray(users) || users.length === 0) {
      show(emptyState, true);
      if (emptyState) emptyState.textContent = 'No users yet. Create the first admin to enable login.';
      show(wipeBtn, false);
      return;
    }
    show(wipeBtn, true);
    const visible = sortedUsers();
    if (visible.length === 0) {
      show(emptyState, true);
      if (emptyState) emptyState.textContent = 'No users match the current filter.';
      return;
    }
    show(emptyState, false);

    tableBody.innerHTML = visible.map((user) => {
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
    updateUserSortIndicators();
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
  }

  async function init() {
    const status = await ensureStatus();
    const user = status?.user || null;
    const isAdmin = user?.access_level === 'admin' || status?.admin_count === 0;

    if (!isAdmin) {
      usersEnabled = false;
      hideUsersNav();
      return;
    }

    usersEnabled = true;
    await loadUsers();
  }

  async function refreshUsersLive() {
    if (!usersEnabled) return;
    if (usersLiveRefreshInFlight) {
      usersLiveRefreshQueued = true;
      return;
    }
    usersLiveRefreshInFlight = true;
    try {
      await ensureStatus();
      await loadUsers();
    } finally {
      usersLiveRefreshInFlight = false;
      if (usersLiveRefreshQueued) {
        usersLiveRefreshQueued = false;
        scheduleLiveUsersRefresh(500);
      }
    }
  }

  function scheduleLiveUsersRefresh(delay = 700) {
    if (!usersEnabled) return;
    if (usersLiveRefreshInFlight) {
      usersLiveRefreshQueued = true;
      return;
    }
    if (usersLiveRefreshTimer) return;
    usersLiveRefreshTimer = window.setTimeout(() => {
      usersLiveRefreshTimer = null;
      refreshUsersLive();
    }, delay);
  }

  window.addEventListener('admin-data-dirty', (event) => {
    const domains = event?.detail?.domains;
    if (!Array.isArray(domains) || !domains.includes('users')) return;
    const viewMode = (document.body?.dataset?.viewMode || '').toLowerCase();
    scheduleLiveUsersRefresh(viewMode === 'users' ? 250 : 700);
  });

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
        if (!updated) throw new Error('Unexpected response: missing user data');
        users = users.map((u) => (u.id === updated.id ? updated : u));
      } else {
        const res = await api('/admin/users', { method: 'POST', json: payload });
        const created = res?.data?.user;
        if (!created) throw new Error('Unexpected response: missing user data');
        users = [...users, created].sort((a, b) => (a.username || '').localeCompare(b.username || ''));
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
      const confirmed = window.__confirm
        ? await window.__confirm('Delete user', `Delete user ${user.username}?`, { action: 'Delete' })
        : window.confirm(`Delete user ${user.username}?`);
      if (!confirmed) return;
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

  if (filterInput) {
    filterInput.addEventListener('input', () => {
      userFilterText = filterInput.value.trim().toLowerCase();
      renderUsers();
    });
    filterInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && filterInput.value) {
        e.preventDefault();
        filterInput.value = '';
        userFilterText = '';
        renderUsers();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (modal?.classList.contains('show')) { e.preventDefault(); closeModal(); return; }
    if (wipeModal?.classList.contains('show')) { e.preventDefault(); closeWipeModal(); return; }
  });

  // Wire up sortable column headers in the users table.
  document.querySelectorAll('#users-table .sort-link[data-users-sort]').forEach((link) => {
    const activate = () => {
      const key = link.getAttribute('data-users-sort');
      if (!key) return;
      if (userSort.key === key) {
        userSort = { key, direction: userSort.direction === 'asc' ? 'desc' : 'asc' };
      } else {
        userSort = { key, direction: key === 'last_login' ? 'desc' : 'asc' };
      }
      renderUsers();
    };
    link.addEventListener('click', (e) => { e.preventDefault(); activate(); });
    link.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });

  init();
})();
