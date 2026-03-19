(() => {
  let initialized = false;
  let loading = false;
  let currentSlug = '';
  let currentProjects = [];
  let currentDetail = null;
  let moduleEnabled = false;
  let pendingDeleteSlug = '';
  let reloadQueued = false;
  let queuedLoadSlug = '';

  let projectsEnabledToggle;
  let projectsEnabledLabel;
  let projectsModuleStatus;
  let projectsManagedSkill;
  let projectsIndexMeta;
  let projectsTableWrap;
  let projectsTableBody;
  let projectsListEmptyState;
  let projectDeleteModal;
  let projectDeleteText;
  let cancelProjectDelete;
  let confirmProjectDelete;
  let projectDetailPanel;
  let projectDetailTitle;
  let projectDetailMeta;
  let projectDetailEmptyState;
  let projectDetailEmptyTitle;
  let projectDetailEmptyBody;
  let projectDetailLayout;
  let projectAboutTitle;
  let projectAboutName;
  let projectAboutDescription;
  let projectAboutSave;
  let projectAboutStatus;
  let projectRosterMarkdown;
  let projectRosterSave;
  let projectRosterStatus;
  let projectNoteId;
  let projectNoteHeader;
  let projectNoteBody;
  let projectNoteSave;
  let projectNoteReset;
  let projectNoteStatus;
  let projectNotesList;
  let projectTodoId;
  let projectTodoTitle;
  let projectTodoDetail;
  let projectTodoSave;
  let projectTodoReset;
  let projectTodoStatus;
  let projectTodosList;
  let projectFileName;
  let projectFileMime;
  let projectFileDescription;
  let projectFileContent;
  let projectFileSave;
  let projectFileStatus;
  let projectFilesList;
  let projectFeedbackType;
  let projectFeedbackTitle;
  let projectFeedbackBody;
  let projectFeedbackSave;
  let projectFeedbackStatus;
  let projectFeedbackList;
  let projectChangesList;

  function bindDom() {
    projectsEnabledToggle = document.getElementById('projectsEnabledToggle');
    projectsEnabledLabel = document.getElementById('projectsEnabledLabel');
    projectsModuleStatus = document.getElementById('projectsModuleStatus');
    projectsManagedSkill = document.getElementById('projectsManagedSkill');
    projectsIndexMeta = document.getElementById('projectsIndexMeta');
    projectsTableWrap = document.getElementById('projectsTableWrap');
    projectsTableBody = document.getElementById('projectsTableBody');
    projectsListEmptyState = document.getElementById('projectsListEmptyState');
    projectDeleteModal = document.getElementById('projectDeleteModal');
    projectDeleteText = document.getElementById('projectDeleteText');
    cancelProjectDelete = document.getElementById('cancelProjectDelete');
    confirmProjectDelete = document.getElementById('confirmProjectDelete');
    projectDetailPanel = document.getElementById('projectDetailPanel');
    projectDetailTitle = document.getElementById('projectDetailTitle');
    projectDetailMeta = document.getElementById('projectDetailMeta');
    projectDetailEmptyState = document.getElementById('projectDetailEmptyState');
    projectDetailEmptyTitle = document.getElementById('projectDetailEmptyTitle');
    projectDetailEmptyBody = document.getElementById('projectDetailEmptyBody');
    projectDetailLayout = document.getElementById('projectDetailLayout');
    projectAboutTitle = document.getElementById('projectAboutTitle');
    projectAboutName = document.getElementById('projectAboutName');
    projectAboutDescription = document.getElementById('projectAboutDescription');
    projectAboutSave = document.getElementById('projectAboutSave');
    projectAboutStatus = document.getElementById('projectAboutStatus');
    projectRosterMarkdown = document.getElementById('projectRosterMarkdown');
    projectRosterSave = document.getElementById('projectRosterSave');
    projectRosterStatus = document.getElementById('projectRosterStatus');
    projectNoteId = document.getElementById('projectNoteId');
    projectNoteHeader = document.getElementById('projectNoteHeader');
    projectNoteBody = document.getElementById('projectNoteBody');
    projectNoteSave = document.getElementById('projectNoteSave');
    projectNoteReset = document.getElementById('projectNoteReset');
    projectNoteStatus = document.getElementById('projectNoteStatus');
    projectNotesList = document.getElementById('projectNotesList');
    projectTodoId = document.getElementById('projectTodoId');
    projectTodoTitle = document.getElementById('projectTodoTitle');
    projectTodoDetail = document.getElementById('projectTodoDetail');
    projectTodoSave = document.getElementById('projectTodoSave');
    projectTodoReset = document.getElementById('projectTodoReset');
    projectTodoStatus = document.getElementById('projectTodoStatus');
    projectTodosList = document.getElementById('projectTodosList');
    projectFileName = document.getElementById('projectFileName');
    projectFileMime = document.getElementById('projectFileMime');
    projectFileDescription = document.getElementById('projectFileDescription');
    projectFileContent = document.getElementById('projectFileContent');
    projectFileSave = document.getElementById('projectFileSave');
    projectFileStatus = document.getElementById('projectFileStatus');
    projectFilesList = document.getElementById('projectFilesList');
    projectFeedbackType = document.getElementById('projectFeedbackType');
    projectFeedbackTitle = document.getElementById('projectFeedbackTitle');
    projectFeedbackBody = document.getElementById('projectFeedbackBody');
    projectFeedbackSave = document.getElementById('projectFeedbackSave');
    projectFeedbackStatus = document.getElementById('projectFeedbackStatus');
    projectFeedbackList = document.getElementById('projectFeedbackList');
    projectChangesList = document.getElementById('projectChangesList');
  }

  async function api(path, options = {}) {
    const init = {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
      },
    };
    if (options.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.json);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(`Invalid JSON from ${path}`);
    }
    if (!res.ok || payload.status === 'error') {
      throw new Error(payload.message || `Request failed (${res.status})`);
    }
    return payload;
  }

  function decodeHashValue(value) {
    try {
      return decodeURIComponent(String(value || ''));
    } catch (_) {
      return String(value || '');
    }
  }

  function currentRoute() {
    const pathname = window.location.pathname;
    const m = pathname.match(/^\/admin\/([^/]+)(?:\/(.+))?$/);
    const seg1 = (m?.[1] || '').toLowerCase();
    const seg2 = decodeURIComponent(m?.[2] || '');
    if (seg1 === 'projects') return { panel: 'project-detail', sub: seg2 };
    if (seg1 === 'settings') return { panel: 'settings', sub: seg2 };
    return { panel: seg1, sub: seg2 };
  }

  function detailRouteSlug() {
    const route = currentRoute();
    return route.panel === 'project-detail' ? route.sub : '';
  }

  function navigateToProjectDetail(slug) {
    if (!slug) return;
    history.pushState({}, '', '/admin/projects/' + encodeURIComponent(String(slug)));
    if (typeof window.__applyRouting === 'function') window.__applyRouting();
  }

  function navigateToProjectsSettings() {
    history.pushState({}, '', '/admin/settings/projects');
    if (typeof window.__applyRouting === 'function') window.__applyRouting();
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    const normalized = String(value).replace(/\.(\d{3})\d*(Z?)/, '.$1$2');
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return String(value);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${yy}, ${hh}:${min}`;
  }

  function formatBytes(value) {
    const size = Number(value || 0);
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clearChildren(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setModuleState(state) {
    moduleEnabled = Boolean(state?.enabled);
    if (projectsEnabledToggle) projectsEnabledToggle.checked = moduleEnabled;
    if (projectsEnabledLabel) projectsEnabledLabel.textContent = moduleEnabled ? 'Enabled' : 'Disabled';
    if (projectsModuleStatus) {
      const updated = state?.updated_at ? ` Last changed ${formatTimestamp(state.updated_at)}.` : '';
      projectsModuleStatus.textContent = moduleEnabled
        ? `Project coordination is live and available to MCP/REST/admin.${updated}`
        : `Project coordination is disabled.${updated}`;
    }
    if (projectsManagedSkill) {
      const slug = state?.managed_skill?.slug || 'coco';
      const copy = moduleEnabled
        ? `Managed skill: ${slug} is deployed through the normal skills sync and carries the native CoCo toolkit/help. Shared handoffs stay project-only; host-scoped MCP memory is not a fallback.`
        : `Managed skill: ${slug} stays withheld until the module is enabled and is removed from clients on the next sync when disabled.`;
      projectsManagedSkill.innerHTML = copy.replace(slug, `<code>${slug}</code>`);
    }
  }

  function resetNoteForm() {
    if (projectNoteId) projectNoteId.value = '';
    if (projectNoteHeader) projectNoteHeader.value = '';
    if (projectNoteBody) projectNoteBody.value = '';
    if (projectNoteStatus) projectNoteStatus.textContent = currentSlug ? 'Ready for a new note.' : 'No project loaded.';
  }

  function resetTodoForm() {
    if (projectTodoId) projectTodoId.value = '';
    if (projectTodoTitle) projectTodoTitle.value = '';
    if (projectTodoDetail) projectTodoDetail.value = '';
    if (projectTodoStatus) projectTodoStatus.textContent = currentSlug ? 'Ready for a new todo.' : 'No project loaded.';
  }

  function resetFileForm() {
    if (projectFileName) projectFileName.value = '';
    if (projectFileMime) projectFileMime.value = '';
    if (projectFileDescription) projectFileDescription.value = '';
    if (projectFileContent) projectFileContent.value = '';
    if (projectFileStatus) projectFileStatus.textContent = currentSlug ? 'Ready for a new file.' : 'No project loaded.';
  }

  function resetFeedbackForm() {
    if (projectFeedbackType) projectFeedbackType.value = 'feature';
    if (projectFeedbackTitle) projectFeedbackTitle.value = '';
    if (projectFeedbackBody) projectFeedbackBody.value = '';
    if (projectFeedbackStatus) projectFeedbackStatus.textContent = currentSlug ? 'Ready for a new feedback item.' : 'No project loaded.';
  }

  function resetTransientForms() {
    resetNoteForm();
    resetTodoForm();
    resetFileForm();
    resetFeedbackForm();
  }

  function clearDetailFields() {
    if (projectAboutTitle) projectAboutTitle.value = '';
    if (projectAboutName) projectAboutName.value = '';
    if (projectAboutDescription) projectAboutDescription.value = '';
    if (projectRosterMarkdown) projectRosterMarkdown.value = '';
  }

  function disableDetailInputs(disabled) {
    [
      projectAboutTitle,
      projectAboutName,
      projectAboutDescription,
      projectAboutSave,
      projectRosterMarkdown,
      projectRosterSave,
      projectNoteHeader,
      projectNoteBody,
      projectNoteSave,
      projectNoteReset,
      projectTodoTitle,
      projectTodoDetail,
      projectTodoSave,
      projectTodoReset,
      projectFileName,
      projectFileMime,
      projectFileDescription,
      projectFileContent,
      projectFileSave,
      projectFeedbackType,
      projectFeedbackTitle,
      projectFeedbackBody,
      projectFeedbackSave,
    ].forEach((el) => {
      if (el) el.disabled = disabled;
    });
  }

  function setProjectsEmptyState(title, body) {
    if (projectsTableWrap) projectsTableWrap.hidden = true;
    if (!projectsListEmptyState) return;
    projectsListEmptyState.hidden = false;
    projectsListEmptyState.innerHTML = `
      <div class="empty-state-title">${escapeHtml(title)}</div>
      <div class="muted" style="margin-top:6px;">${escapeHtml(body)}</div>
    `;
  }

  function renderProjectTable() {
    clearChildren(projectsTableBody);

    if (!moduleEnabled) {
      if (projectsIndexMeta) projectsIndexMeta.textContent = 'Module disabled. Enable it to browse known projects.';
      setProjectsEmptyState('Module disabled', 'Enable the module to browse or manage shared projects.');
      return;
    }

    if (!currentProjects.length) {
      if (projectsIndexMeta) projectsIndexMeta.textContent = 'No shared projects registered yet.';
      setProjectsEmptyState('No projects yet', 'Project creation is API-driven for now. Existing projects will appear here automatically.');
      return;
    }

    if (projectsIndexMeta) {
      const count = currentProjects.length;
      projectsIndexMeta.textContent = `${count} project${count === 1 ? '' : 's'} known. Open one for the full workspace.`;
    }
    if (projectsListEmptyState) projectsListEmptyState.hidden = true;
    if (projectsTableWrap) projectsTableWrap.hidden = false;

    currentProjects.forEach((project) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>
          <div class="project-list-summary">
            <div class="project-list-title">${escapeHtml(project.title || project.slug)}</div>
            <div class="project-list-slug">${escapeHtml(project.slug || '')}</div>
          </div>
        </td>
        <td>
          <div class="project-list-description">${escapeHtml(project.description || 'No description yet.')}</div>
        </td>
        <td>
          <div class="project-table-updated">${escapeHtml(formatTimestamp(project.updated_at))}</div>
        </td>
        <td>
          <div class="project-table-actions">
            <button type="button" class="ghost tiny-btn" data-action="open">Open</button>
            <button type="button" class="danger tiny-btn" data-action="delete">Delete</button>
          </div>
        </td>
      `;
      const openBtn = row.querySelector('button[data-action="open"]');
      const deleteBtn = row.querySelector('button[data-action="delete"]');
      openBtn?.addEventListener('click', () => navigateToProjectDetail(project.slug));
      deleteBtn?.addEventListener('click', () => openProjectDeleteModal(project.slug));
      projectsTableBody?.appendChild(row);
    });
  }

  function showProjectDetailEmpty(title, body) {
    if (projectDetailLayout) projectDetailLayout.hidden = true;
    if (projectDetailEmptyState) projectDetailEmptyState.hidden = false;
    if (projectDetailEmptyTitle) projectDetailEmptyTitle.textContent = title;
    if (projectDetailEmptyBody) projectDetailEmptyBody.textContent = body;
  }

  function showProjectDetailLayout() {
    if (projectDetailEmptyState) projectDetailEmptyState.hidden = true;
    if (projectDetailLayout) projectDetailLayout.hidden = false;
  }

  function renderNotes(notes) {
    clearChildren(projectNotesList);
    if (!projectNotesList) return;
    if (!notes.length) {
      const empty = document.createElement('div');
      empty.className = 'row-card';
      empty.innerHTML = '<strong>No notes yet</strong><div class="muted-note">Capture durable decisions and findings here.</div>';
      projectNotesList.appendChild(empty);
      return;
    }

    notes.forEach((note) => {
      const item = document.createElement('div');
      item.className = 'row-card';
      item.innerHTML = `
        <div class="row-head">
          <strong>${escapeHtml(note.header || 'Untitled')}</strong>
          <span class="pill-quiet">${escapeHtml(formatTimestamp(note.updated_at))}</span>
        </div>
        <div class="muted-note" style="margin-top:8px; white-space:pre-wrap;">${escapeHtml(note.body || '')}</div>
      `;
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.style.marginTop = '10px';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'ghost tiny-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        if (projectNoteId) projectNoteId.value = String(note.id || '');
        if (projectNoteHeader) projectNoteHeader.value = note.header || '';
        if (projectNoteBody) projectNoteBody.value = note.body || '';
        if (projectNoteStatus) projectNoteStatus.textContent = `Editing note #${note.id}`;
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost tiny-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteNote(note.id));
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);
      projectNotesList.appendChild(item);
    });
  }

  function renderTodos(todos) {
    clearChildren(projectTodosList);
    if (!projectTodosList) return;
    if (!todos.length) {
      const empty = document.createElement('div');
      empty.className = 'row-card';
      empty.innerHTML = '<strong>No todos yet</strong><div class="muted-note">Track action items here before they drift into chat history.</div>';
      projectTodosList.appendChild(empty);
      return;
    }

    todos.forEach((todo) => {
      const item = document.createElement('div');
      item.className = 'row-card';
      const tone = todo.done ? 'Done' : 'Open';
      item.innerHTML = `
        <div class="row-head">
          <strong>${escapeHtml(todo.title || 'Untitled')}</strong>
          <span class="pill-quiet">${escapeHtml(tone)}</span>
        </div>
        <div class="muted-note" style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(todo.detail || 'No detail.')}</div>
        <div class="muted-note" style="margin-top:8px;">Updated ${escapeHtml(formatTimestamp(todo.updated_at))}</div>
      `;
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.style.marginTop = '10px';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'ghost tiny-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        if (projectTodoId) projectTodoId.value = String(todo.id || '');
        if (projectTodoTitle) projectTodoTitle.value = todo.title || '';
        if (projectTodoDetail) projectTodoDetail.value = todo.detail || '';
        if (projectTodoStatus) projectTodoStatus.textContent = `Editing todo #${todo.id}`;
      });
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'ghost tiny-btn';
      toggleBtn.textContent = todo.done ? 'Mark Open' : 'Mark Done';
      toggleBtn.addEventListener('click', () => toggleTodo(todo.id, !todo.done));
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost tiny-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteTodo(todo.id));
      actions.appendChild(editBtn);
      actions.appendChild(toggleBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);
      projectTodosList.appendChild(item);
    });
  }

  function renderFiles(files) {
    clearChildren(projectFilesList);
    if (!projectFilesList) return;
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'row-card';
      empty.innerHTML = '<strong>No files yet</strong><div class="muted-note">Store rollout notes, snippets, and project artifacts here.</div>';
      projectFilesList.appendChild(empty);
      return;
    }

    files.forEach((file) => {
      const item = document.createElement('div');
      item.className = 'row-card';
      item.innerHTML = `
        <div class="row-head">
          <strong>${escapeHtml(file.stored_name || 'unnamed')}</strong>
          <span class="pill-quiet">${escapeHtml(formatBytes(file.size_bytes || 0))}</span>
        </div>
        <div class="muted-note" style="margin-top:6px;">${escapeHtml(file.description || 'No description.')}</div>
        <div class="muted-note" style="margin-top:8px;">${escapeHtml(file.mime_type || 'text/plain')} · Updated ${escapeHtml(formatTimestamp(file.updated_at))}</div>
      `;
      const actions = document.createElement('div');
      actions.className = 'row-actions';
      actions.style.marginTop = '10px';
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'ghost tiny-btn';
      loadBtn.textContent = 'Load';
      loadBtn.addEventListener('click', () => {
        if (projectFileName) projectFileName.value = file.stored_name || '';
        if (projectFileDescription) projectFileDescription.value = file.description || '';
        if (projectFileMime) projectFileMime.value = file.mime_type || '';
        if (projectFileContent) projectFileContent.value = file.content || '';
        if (projectFileStatus) projectFileStatus.textContent = `Loaded ${file.stored_name}`;
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'ghost tiny-btn';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteFile(file.id));
      actions.appendChild(loadBtn);
      actions.appendChild(delBtn);
      item.appendChild(actions);
      projectFilesList.appendChild(item);
    });
  }

  function renderFeedback(items) {
    clearChildren(projectFeedbackList);
    if (!projectFeedbackList) return;
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'row-card';
      empty.innerHTML = '<strong>No feedback yet</strong><div class="muted-note">Feature asks and bugs land here for triage.</div>';
      projectFeedbackList.appendChild(empty);
      return;
    }

    items.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'row-card';
      item.innerHTML = `
        <div class="row-head">
          <strong>${escapeHtml(entry.title || 'Untitled')}</strong>
          <span class="pill-quiet">${escapeHtml(entry.type || 'note')}</span>
        </div>
        <div class="muted-note" style="margin-top:6px; white-space:pre-wrap;">${escapeHtml(entry.body || '')}</div>
        <div class="muted-note" style="margin-top:8px;">${escapeHtml(entry.status || 'open')} · ${escapeHtml(formatTimestamp(entry.updated_at))}</div>
      `;
      projectFeedbackList.appendChild(item);
    });
  }

  function renderChanges(changes) {
    clearChildren(projectChangesList);
    if (!projectChangesList) return;
    if (!changes.length) {
      const empty = document.createElement('div');
      empty.className = 'row-card';
      empty.innerHTML = '<strong>No recent changes</strong><div class="muted-note">Mutations will start appearing here once the project is active.</div>';
      projectChangesList.appendChild(empty);
      return;
    }

    changes.slice(-10).reverse().forEach((change) => {
      const item = document.createElement('div');
      item.className = 'row-card';
      const label = [change.event_type, change.action].filter(Boolean).join(' / ');
      item.innerHTML = `
        <div class="row-head">
          <strong>${escapeHtml(label || 'change')}</strong>
          <span class="pill-quiet">#${escapeHtml(String(change.seq || '0'))}</span>
        </div>
        <div class="muted-note" style="margin-top:6px;">${escapeHtml(formatTimestamp(change.created_at))}</div>
        <div class="muted-note" style="margin-top:8px; white-space:pre-wrap;">${escapeHtml(JSON.stringify(change.payload || {}, null, 2))}</div>
      `;
      projectChangesList.appendChild(item);
    });
  }

  function renderDetail() {
    if (!moduleEnabled) {
      currentDetail = null;
      disableDetailInputs(true);
      clearDetailFields();
      resetTransientForms();
      renderNotes([]);
      renderTodos([]);
      renderFiles([]);
      renderFeedback([]);
      renderChanges([]);
      if (projectDetailTitle) projectDetailTitle.textContent = 'Project coordination disabled';
      if (projectDetailMeta) projectDetailMeta.textContent = 'Enable the module from Settings to unlock project workspaces.';
      showProjectDetailEmpty('Project coordination disabled', 'Enable the module from Settings → Projects to browse shared workspaces.');
      return;
    }

    if (!currentDetail || !currentSlug) {
      disableDetailInputs(true);
      clearDetailFields();
      resetTransientForms();
      renderNotes([]);
      renderTodos([]);
      renderFiles([]);
      renderFeedback([]);
      renderChanges([]);
      if (projectDetailTitle) projectDetailTitle.textContent = 'Unknown project';
      if (projectDetailMeta) projectDetailMeta.textContent = 'The requested project could not be loaded.';
      showProjectDetailEmpty('Project not found', 'The requested project does not exist or is no longer available.');
      return;
    }

    const project = currentDetail.project || {};
    const about = project.about || {};
    const counts = project.counts || {};
    const title = about.title || currentSlug;

    disableDetailInputs(false);
    showProjectDetailLayout();

    if (projectDetailTitle) projectDetailTitle.textContent = title;
    if (projectDetailMeta) {
      projectDetailMeta.textContent = `${currentSlug} · ${counts.notes || 0} notes · ${counts.open_todos || 0} open todos · ${counts.files || 0} files · Updated ${formatTimestamp(project.updated_at)}`;
    }

    if (projectAboutTitle) projectAboutTitle.value = about.title || '';
    if (projectAboutName) projectAboutName.value = about.name || '';
    if (projectAboutDescription) projectAboutDescription.value = about.description || '';
    if (projectRosterMarkdown) projectRosterMarkdown.value = project.roster_markdown || '';
    if (projectAboutStatus) projectAboutStatus.textContent = `Loaded ${currentSlug}`;
    if (projectRosterStatus) projectRosterStatus.textContent = `Loaded ${currentSlug}`;

    renderNotes(Array.isArray(currentDetail.notes) ? currentDetail.notes : []);
    renderTodos(Array.isArray(currentDetail.todos) ? currentDetail.todos : []);
    renderFiles(Array.isArray(currentDetail.files) ? currentDetail.files : []);
    renderFeedback(Array.isArray(currentDetail.feedback) ? currentDetail.feedback : []);
    renderChanges(Array.isArray(currentDetail.recent_changes) ? currentDetail.recent_changes : []);
  }

  async function loadState() {
    const resp = await api('/admin/projects/state');
    setModuleState(resp.data || {});
  }

  async function loadProjectsList() {
    if (!moduleEnabled) {
      currentProjects = [];
      renderProjectTable();
      return;
    }

    const resp = await api('/admin/projects');
    currentProjects = Array.isArray(resp?.data?.projects) ? resp.data.projects : [];
    renderProjectTable();
  }

  async function loadProjectDetail(slug) {
    if (!moduleEnabled || !slug) {
      currentSlug = String(slug || '');
      currentDetail = null;
      renderDetail();
      return;
    }

    currentSlug = String(slug);
    const resp = await api(`/admin/projects/${encodeURIComponent(currentSlug)}`);
    currentDetail = resp.data || null;
    renderDetail();
  }

  async function loadSettingsView() {
    await loadState();
    await loadProjectsList();
  }

  async function loadProjectDetailView(slug) {
    const normalizedSlug = String(slug || '').trim();
    if (normalizedSlug !== currentSlug) {
      currentSlug = normalizedSlug;
      currentDetail = null;
      resetTransientForms();
    }

    await loadState();
    if (!moduleEnabled || !currentSlug) {
      renderDetail();
      return;
    }

    try {
      await loadProjectDetail(currentSlug);
    } catch (err) {
      currentDetail = null;
      disableDetailInputs(true);
      clearDetailFields();
      resetTransientForms();
      renderNotes([]);
      renderTodos([]);
      renderFiles([]);
      renderFeedback([]);
      renderChanges([]);
      if (projectDetailTitle) projectDetailTitle.textContent = currentSlug || 'Project load failed';
      if (projectDetailMeta) projectDetailMeta.textContent = err.message || 'Unable to load project details.';
      showProjectDetailEmpty('Project load failed', err.message || 'Unable to load project details.');
    }
  }

  async function loadAll(preferredSlug = '') {
    if (loading) {
      reloadQueued = true;
      queuedLoadSlug = preferredSlug || detailRouteSlug() || currentSlug;
      return;
    }
    loading = true;
    try {
      const route = currentRoute();
      if (route.panel === 'project-detail') {
        await loadProjectDetailView(preferredSlug || route.sub || currentSlug);
      } else {
        await loadSettingsView();
      }
    } catch (err) {
      if (projectsModuleStatus) projectsModuleStatus.textContent = `Load failed: ${err.message}`;
    } finally {
      loading = false;
      if (reloadQueued) {
        const nextSlug = queuedLoadSlug;
        reloadQueued = false;
        queuedLoadSlug = '';
        loadAll(nextSlug);
      }
    }
  }

  async function saveModuleEnabled(enabled) {
    try {
      const resp = await api('/admin/projects/state', {
        method: 'POST',
        json: { enabled },
      });
      setModuleState(resp.data || {});
      await loadAll(currentSlug);
    } catch (err) {
      if (projectsModuleStatus) projectsModuleStatus.textContent = `Update failed: ${err.message}`;
      if (projectsEnabledToggle) projectsEnabledToggle.checked = moduleEnabled;
    }
  }

  async function saveAbout() {
    if (!currentSlug) return;
    if (projectAboutStatus) projectAboutStatus.textContent = 'Saving…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/about`, {
        method: 'POST',
        json: {
          about: {
            title: projectAboutTitle?.value || '',
            name: projectAboutName?.value || '',
            description: projectAboutDescription?.value || '',
          },
        },
      });
      if (projectAboutStatus) projectAboutStatus.textContent = 'Saved';
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectAboutStatus) projectAboutStatus.textContent = `Save failed: ${err.message}`;
    }
  }

  async function saveRoster() {
    if (!currentSlug) return;
    if (projectRosterStatus) projectRosterStatus.textContent = 'Saving…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/roster`, {
        method: 'POST',
        json: {
          roster_markdown: projectRosterMarkdown?.value || '',
        },
      });
      if (projectRosterStatus) projectRosterStatus.textContent = 'Saved';
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectRosterStatus) projectRosterStatus.textContent = `Save failed: ${err.message}`;
    }
  }

  async function saveNote() {
    if (!currentSlug) return;
    if (projectNoteStatus) projectNoteStatus.textContent = 'Saving…';
    try {
      const id = projectNoteId?.value ? Number(projectNoteId.value) : null;
      const path = id
        ? `/admin/projects/${encodeURIComponent(currentSlug)}/notes/${id}`
        : `/admin/projects/${encodeURIComponent(currentSlug)}/notes`;
      await api(path, {
        method: 'POST',
        json: {
          header: projectNoteHeader?.value || '',
          body: projectNoteBody?.value || '',
        },
      });
      resetNoteForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectNoteStatus) projectNoteStatus.textContent = `Save failed: ${err.message}`;
    }
  }

  async function deleteNote(id) {
    if (!currentSlug || !id) return;
    if (!window.__confirm || !await window.__confirm('Delete note', `Delete note #${id}?`, { action: 'Delete' })) return;
    if (projectNoteStatus) projectNoteStatus.textContent = 'Deleting…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/notes/${id}`, { method: 'DELETE' });
      resetNoteForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectNoteStatus) projectNoteStatus.textContent = `Delete failed: ${err.message}`;
    }
  }

  async function saveTodo() {
    if (!currentSlug) return;
    if (projectTodoStatus) projectTodoStatus.textContent = 'Saving…';
    try {
      const id = projectTodoId?.value ? Number(projectTodoId.value) : null;
      const path = id
        ? `/admin/projects/${encodeURIComponent(currentSlug)}/todos/${id}`
        : `/admin/projects/${encodeURIComponent(currentSlug)}/todos`;
      await api(path, {
        method: 'POST',
        json: {
          title: projectTodoTitle?.value || '',
          detail: projectTodoDetail?.value || '',
        },
      });
      resetTodoForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectTodoStatus) projectTodoStatus.textContent = `Save failed: ${err.message}`;
    }
  }

  async function toggleTodo(id, done) {
    if (!currentSlug || !id) return;
    if (projectTodoStatus) projectTodoStatus.textContent = done ? 'Marking done…' : 'Marking open…';
    try {
      const suffix = done ? 'done' : 'undone';
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/todos/${id}/${suffix}`, { method: 'POST' });
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectTodoStatus) projectTodoStatus.textContent = `Update failed: ${err.message}`;
    }
  }

  async function deleteTodo(id) {
    if (!currentSlug || !id) return;
    if (!window.__confirm || !await window.__confirm('Delete todo', `Delete todo #${id}?`, { action: 'Delete' })) return;
    if (projectTodoStatus) projectTodoStatus.textContent = 'Deleting…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/todos/${id}`, { method: 'DELETE' });
      resetTodoForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectTodoStatus) projectTodoStatus.textContent = `Delete failed: ${err.message}`;
    }
  }

  async function saveFile() {
    if (!currentSlug) return;
    if (projectFileStatus) projectFileStatus.textContent = 'Saving…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/files`, {
        method: 'POST',
        json: {
          stored_name: projectFileName?.value || '',
          description: projectFileDescription?.value || '',
          mime_type: projectFileMime?.value || '',
          content: projectFileContent?.value || '',
        },
      });
      resetFileForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectFileStatus) projectFileStatus.textContent = `Save failed: ${err.message}`;
    }
  }

  async function deleteFile(id) {
    if (!currentSlug || !id) return;
    if (!window.__confirm || !await window.__confirm('Delete file', `Delete file #${id}?`, { action: 'Delete' })) return;
    if (projectFileStatus) projectFileStatus.textContent = 'Deleting…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/files/${id}`, { method: 'DELETE' });
      resetFileForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectFileStatus) projectFileStatus.textContent = `Delete failed: ${err.message}`;
    }
  }

  async function saveFeedback() {
    if (!currentSlug) return;
    if (projectFeedbackStatus) projectFeedbackStatus.textContent = 'Saving…';
    try {
      await api(`/admin/projects/${encodeURIComponent(currentSlug)}/feedback`, {
        method: 'POST',
        json: {
          type: projectFeedbackType?.value || 'feature',
          title: projectFeedbackTitle?.value || '',
          body: projectFeedbackBody?.value || '',
        },
      });
      resetFeedbackForm();
      await loadProjectDetailView(currentSlug);
    } catch (err) {
      if (projectFeedbackStatus) projectFeedbackStatus.textContent = `Save failed: ${err.message}`;
    }
  }

  function openProjectDeleteModal(slug) {
    pendingDeleteSlug = String(slug || '').trim();
    const project = currentProjects.find((entry) => String(entry.slug) === pendingDeleteSlug);
    const label = project?.title || pendingDeleteSlug || 'this project';
    if (projectDeleteText) {
      projectDeleteText.textContent = `Delete ${label}? This removes the project and all shared notes, todos, files, feedback, and history.`;
    }
    projectDeleteModal?.classList.add('show');
  }

  function closeProjectDeleteModal() {
    projectDeleteModal?.classList.remove('show');
    pendingDeleteSlug = '';
  }

  async function confirmDeleteProjectAction() {
    if (!pendingDeleteSlug) return;
    if (confirmProjectDelete) {
      confirmProjectDelete.disabled = true;
      confirmProjectDelete.textContent = 'Deleting…';
    }
    try {
      const deletedSlug = pendingDeleteSlug;
      await api(`/admin/projects/${encodeURIComponent(deletedSlug)}`, { method: 'DELETE' });
      closeProjectDeleteModal();
      if (detailRouteSlug() === deletedSlug) {
        navigateToProjectsSettings();
        return;
      }
      await loadSettingsView();
    } catch (err) {
      if (window.__toast) window.__toast({ message: `Delete failed: ${err.message}`, level: 'error' });
    } finally {
      if (confirmProjectDelete) {
        confirmProjectDelete.disabled = false;
        confirmProjectDelete.textContent = 'Delete';
      }
    }
  }

  function wireEvents() {
    if (projectsEnabledToggle) {
      projectsEnabledToggle.addEventListener('change', () => {
        saveModuleEnabled(projectsEnabledToggle.checked);
      });
    }
    if (projectAboutSave) {
      projectAboutSave.addEventListener('click', (event) => {
        event.preventDefault();
        saveAbout();
      });
    }
    if (projectRosterSave) {
      projectRosterSave.addEventListener('click', (event) => {
        event.preventDefault();
        saveRoster();
      });
    }
    if (projectNoteSave) {
      projectNoteSave.addEventListener('click', (event) => {
        event.preventDefault();
        saveNote();
      });
    }
    if (projectNoteReset) {
      projectNoteReset.addEventListener('click', (event) => {
        event.preventDefault();
        resetNoteForm();
      });
    }
    if (projectTodoSave) {
      projectTodoSave.addEventListener('click', (event) => {
        event.preventDefault();
        saveTodo();
      });
    }
    if (projectTodoReset) {
      projectTodoReset.addEventListener('click', (event) => {
        event.preventDefault();
        resetTodoForm();
      });
    }
    if (projectFileSave) {
      projectFileSave.addEventListener('click', (event) => {
        event.preventDefault();
        saveFile();
      });
    }
    if (projectFeedbackSave) {
      projectFeedbackSave.addEventListener('click', (event) => {
        event.preventDefault();
        saveFeedback();
      });
    }
    if (projectDeleteModal) {
      projectDeleteModal.addEventListener('click', (event) => {
        if (event.target === projectDeleteModal) closeProjectDeleteModal();
      });
    }
    if (cancelProjectDelete) {
      cancelProjectDelete.addEventListener('click', closeProjectDeleteModal);
    }
    if (confirmProjectDelete) {
      confirmProjectDelete.addEventListener('click', confirmDeleteProjectAction);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && projectDeleteModal?.classList.contains('show')) {
        e.preventDefault();
        closeProjectDeleteModal();
      }
    });
  }

  function init() {
    bindDom();
    if (!projectsEnabledToggle && !projectsTableBody && !projectDetailPanel) return;

    if (!initialized) {
      initialized = true;
      wireEvents();
      resetTransientForms();
    }

    loadAll();
  }

  window.__initProjects = init;
  window.__loadProjectDetailByRoute = (slug = '') => {
    init();
    loadAll(decodeHashValue(slug));
  };

  window.addEventListener('admin-data-dirty', (event) => {
    if (!initialized) return;
    const domains = Array.isArray(event?.detail?.domains) ? event.detail.domains : [];
    if (!domains.includes('projects')) return;

    const route = currentRoute();
    if (route.panel === 'project-detail') {
      loadAll(route.sub || currentSlug);
      return;
    }
    if (route.panel === 'settings' && route.sub.toLowerCase() === 'projects') {
      loadAll();
    }
  });
})();
