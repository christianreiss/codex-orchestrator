(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') {
    document.body.classList.add('embed');
  }

  const rail = document.querySelector('.editorial-rail');
  const drawer = document.getElementById('navDrawer');
  const menuToggle = document.getElementById('navMenuToggle');
  const backdrop = document.getElementById('navDrawerBackdrop');
  const mtlsStatus = document.getElementById('mtlsStatus');
  const wsStatus = document.getElementById('wsStatus');
  if (!rail) return;

  const MOBILE_DRAWER_MEDIA = '(max-width: 940px)';
  const drawerMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_DRAWER_MEDIA)
    : null;
  const groups = Array.from(rail.querySelectorAll('.rail-group'));

  const isCompactRail = () => (drawerMedia ? drawerMedia.matches : window.innerWidth <= 940);
  const triggerFor = (group) => group.querySelector('[data-rail-trigger]');
  const hasOpenGroup = () => groups.some((group) => group.classList.contains('is-open'));
  const shouldOpenForFocus = (group, target) => {
    if (isCompactRail()) return false;
    const trigger = triggerFor(group);
    if (!trigger || target !== trigger) return true;
    if (typeof trigger.matches !== 'function') return true;
    try {
      return trigger.matches(':focus-visible');
    } catch (_) {
      return true;
    }
  };

  const setExpanded = (group, expanded) => {
    const trigger = triggerFor(group);
    if (trigger) {
      trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  };

  function closeAllGroups({ except = null } = {}) {
    groups.forEach((group) => {
      if (group === except) return;
      group.classList.remove('is-open');
      setExpanded(group, false);
    });
  }

  function openGroup(group) {
    closeAllGroups({ except: group });
    group.classList.add('is-open');
    setExpanded(group, true);
  }

  function toggleGroup(group) {
    if (group.classList.contains('is-open')) {
      group.classList.remove('is-open');
      setExpanded(group, false);
      return;
    }
    openGroup(group);
  }

  groups.forEach((group) => {
    const trigger = triggerFor(group);
    if (!trigger) return;

    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      toggleGroup(group);
    });

    trigger.addEventListener('pointerenter', () => {
      if (isCompactRail() || !hasOpenGroup()) return;
      openGroup(group);
    });

    group.addEventListener('focusin', (event) => {
      if (!shouldOpenForFocus(group, event.target)) return;
      openGroup(group);
    });
  });

  function syncRailHeightVar() {
    const body = document.body;
    if (!body) return;
    const railRect = rail.getBoundingClientRect();
    const railHeight = Math.max(0, Math.round(railRect.height));
    if (railHeight > 0) {
      body.style.setProperty('--nav-height', `${railHeight}px`);
      return;
    }
    body.style.removeProperty('--nav-height');
  }

  let drawerOpen = false;

  function applyDrawerState(open) {
    const compact = isCompactRail();
    drawerOpen = compact ? Boolean(open) : false;

    document.body.classList.toggle('editorial-rail-open', drawerOpen);

    if (menuToggle) {
      menuToggle.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
    }
    if (drawer) {
      drawer.setAttribute('aria-hidden', compact ? (drawerOpen ? 'false' : 'true') : 'false');
    }
    if (backdrop) {
      backdrop.hidden = !drawerOpen;
    }

    if (!drawerOpen) {
      closeAllGroups();
    }
  }

  function closeDrawer({ focusToggle = false } = {}) {
    if (!drawerOpen) return;
    applyDrawerState(false);
    if (focusToggle && menuToggle) {
      menuToggle.focus();
    }
  }

  menuToggle?.addEventListener('click', () => {
    applyDrawerState(!drawerOpen);
  });

  backdrop?.addEventListener('click', () => {
    closeDrawer({ focusToggle: true });
  });

  window.__railNav = {
    closeMenus: () => {
      closeAllGroups();
      closeDrawer();
    },
    closeGroups: closeAllGroups,
  };

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAllGroups();
    closeDrawer({ focusToggle: true });
  });

  document.addEventListener('click', (event) => {
    if (!rail.contains(event.target)) {
      closeAllGroups();
    }
  });

  rail.querySelectorAll('.rail-sub-link').forEach((link) => {
    link.addEventListener('click', () => {
      closeAllGroups();
      closeDrawer();
    });
  });

  function setStatusChip(element, state) {
    if (!element) return;
    element.classList.remove('ok', 'warn', 'err');
    const { label, variant } = state;
    if (variant) {
      element.classList.add(variant);
    }
    element.textContent = label;
  }

  window.__navStatus = {
    setMtls: (meta) => {
      if (!mtlsStatus) return;
      if (!meta) {
        setStatusChip(mtlsStatus, { label: 'mTLS: unknown', variant: 'warn' });
        return;
      }
      if (meta.enforced) {
        setStatusChip(mtlsStatus, { label: 'mTLS: enforced', variant: 'ok' });
        return;
      }
      if (meta.present) {
        setStatusChip(mtlsStatus, { label: 'mTLS: offered', variant: 'warn' });
        return;
      }
      setStatusChip(mtlsStatus, { label: 'mTLS: none', variant: 'err' });
    },
    setWs: (status) => {
      if (!wsStatus) return;
      const normalized = String(status || '').trim().toLowerCase();
      if (normalized === 'open') {
        setStatusChip(wsStatus, { label: 'Live: connected', variant: 'ok' });
        return;
      }
      if (normalized === 'connecting') {
        setStatusChip(wsStatus, { label: 'Live: connecting', variant: 'warn' });
        return;
      }
      if (normalized === 'closed') {
        setStatusChip(wsStatus, { label: 'Live: offline', variant: 'err' });
        return;
      }
      if (normalized === 'error') {
        setStatusChip(wsStatus, { label: 'Live: degraded', variant: 'err' });
        return;
      }
      setStatusChip(wsStatus, { label: 'Live: unknown', variant: 'warn' });
    },
  };

  window.addEventListener('admin-ws-status', (event) => {
    window.__navStatus.setWs(event?.detail?.status || '');
  });

  async function hydrateStatus() {
    try {
      const response = await fetch('/admin/overview', {
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const json = await response.json();
      window.__navStatus.setMtls(json?.data?.mtls ?? null);
    } catch (_) {
      window.__navStatus.setMtls({ required: true, present: false });
    }
  }

  window.__navStatus.setWs('connecting');
  hydrateStatus();

  const normalizePath = (path) => {
    if (!path) return '/';
    try {
      const url = new URL(path, window.location.origin);
      path = url.pathname;
    } catch (_) {
      // Keep raw path if URL parsing fails.
    }
    return path.replace(/\/+$/, '') || '/';
  };

  const normalizePanelKey = (value) => {
    const key = String(value || '').trim().toLowerCase();
    if (!key) return '';
    if (key === 'host-detail') return 'hosts';
    if (key === 'skills') return 'settings';
    return key;
  };

  const inferViewFromPath = (pathname) => {
    if (!pathname) return '';
    if (/\/admin\/hosts\/\d+/.test(pathname)) return 'hosts';
    if (/\/admin\/hosts/.test(pathname)) return 'hosts';
    if (/\/admin\/logs/.test(pathname)) return 'logs';
    if (/\/admin\/settings/.test(pathname)) return 'settings';
    if (/\/admin\/account/.test(pathname)) return 'account';
    if (/\/admin\/users/.test(pathname)) return 'users';
    if (/\/admin\/projects/.test(pathname)) return 'settings';
    if (/\/admin\/(dashboard)?\/?$/.test(pathname)) return 'dashboard';
    return '';
  };

  const inferViewFromHash = (hashValue) => {
    const cleanHash = String(hashValue || '').replace(/^#/, '').trim().toLowerCase();
    if (!cleanHash) return '';
    const [panel] = cleanHash.split('/');
    return normalizePanelKey(panel);
  };

  function currentViewKey() {
    const bodyView = normalizePanelKey(document.body?.dataset?.viewMode || '');
    if (bodyView) return bodyView;

    const pathView = inferViewFromPath(normalizePath(window.location.pathname));
    return pathView || 'dashboard';
  }

  function currentRouteState() {
    return {
      view: currentViewKey(),
      hostTab: String(document.body?.dataset?.hostTab || ''),
      logTab: String(document.body?.dataset?.logTab || ''),
      settingsTab: String(document.body?.dataset?.settingsTab || ''),
      accountTab: String(document.body?.dataset?.accountTab || ''),
    };
  }

  function linkViewKey(link) {
    const datasetView = normalizePanelKey(link.dataset?.nav || '');
    if (datasetView) return datasetView;

    const href = String(link.getAttribute('href') || '').trim();
    if (!href) return '';

    if (href.startsWith('#')) {
      return inferViewFromHash(href);
    }

    try {
      const linkUrl = new URL(href, window.location.origin);
      const queryView = normalizePanelKey(linkUrl.searchParams.get('view') || '');
      if (queryView) return queryView;
      return inferViewFromPath(normalizePath(linkUrl.pathname));
    } catch (_) {
      return '';
    }
  }

  function linkTabTarget(link) {
    if (Object.prototype.hasOwnProperty.call(link.dataset, 'hostTab')) {
      return ['hostTab', String(link.dataset.hostTab || '')];
    }
    if (Object.prototype.hasOwnProperty.call(link.dataset, 'logTab')) {
      return ['logTab', String(link.dataset.logTab || '')];
    }
    if (Object.prototype.hasOwnProperty.call(link.dataset, 'settingsTab')) {
      return ['settingsTab', String(link.dataset.settingsTab || '')];
    }
    if (Object.prototype.hasOwnProperty.call(link.dataset, 'accountTab')) {
      return ['accountTab', String(link.dataset.accountTab || '')];
    }
    return null;
  }

  function isLinkActive(link, routeState) {
    const viewKey = linkViewKey(link);
    if (!viewKey || viewKey !== routeState.view) return false;

    const tabTarget = linkTabTarget(link);
    if (!tabTarget) return true;

    const [field, value] = tabTarget;
    return String(routeState[field] || '') === value;
  }

  function syncActiveLinks() {
    const routeState = currentRouteState();

    groups.forEach((group) => {
      group.classList.remove('is-active');
    });

    document.querySelectorAll('a.rail-link, .rail-sub-link').forEach((link) => {
      const active = isLinkActive(link, routeState);
      link.classList.toggle('is-active', active);

      if (active) {
        link.setAttribute('aria-current', 'page');
        const parentGroup = link.closest('.rail-group');
        parentGroup?.classList.add('is-active');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  const syncAndCloseForNavigation = () => {
    syncActiveLinks();
    closeAllGroups();
    closeDrawer();
  };

  document.querySelectorAll('a.rail-link, .rail-sub-link').forEach((link) => {
    link.addEventListener('click', () => {
      syncAndCloseForNavigation();
    });
  });

  window.addEventListener('popstate', syncActiveLinks);

  if (document.body) {
    const observer = new MutationObserver((records) => {
      const viewChanged = records.some((record) => record.attributeName === 'data-view-mode');
      if (viewChanged) {
        syncActiveLinks();
      }
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-view-mode'],
    });
  }

  const handleViewportChange = () => {
    applyDrawerState(false);
    syncRailHeightVar();
    syncActiveLinks();
  };

  if (drawerMedia) {
    if (typeof drawerMedia.addEventListener === 'function') {
      drawerMedia.addEventListener('change', handleViewportChange);
    } else if (typeof drawerMedia.addListener === 'function') {
      drawerMedia.addListener(handleViewportChange);
    }
  } else {
    window.addEventListener('resize', handleViewportChange);
  }

  if (typeof ResizeObserver === 'function') {
    const railResizeObserver = new ResizeObserver(() => {
      syncRailHeightVar();
    });
    railResizeObserver.observe(rail);
  } else {
    window.addEventListener('resize', syncRailHeightVar);
  }

  applyDrawerState(false);
  syncRailHeightVar();
  syncActiveLinks();
})();
