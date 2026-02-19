(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') {
    document.body.classList.add('embed');
  }

  const nav = document.querySelector('.main-nav');
  const navPanel = document.getElementById('navDrawer');
  const menuToggle = document.getElementById('navMenuToggle');
  const backdrop = document.getElementById('navDrawerBackdrop');
  const mtlsStatus = document.getElementById('mtlsStatus');
  if (!nav) return;

  const MOBILE_DRAWER_MEDIA = '(max-width: 940px)';
  const drawerMedia = typeof window.matchMedia === 'function'
    ? window.matchMedia(MOBILE_DRAWER_MEDIA)
    : null;

  const groups = Array.from(nav.querySelectorAll('.nav-item.has-children'));

  const setExpanded = (group, expanded) => {
    const trigger = group.querySelector('.nav-trigger');
    if (trigger) {
      trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    }
  };

  function closeAllGroups() {
    groups.forEach((group) => {
      group.classList.remove('open');
      setExpanded(group, false);
    });
  }

  function openGroup(group) {
    groups.forEach((current) => {
      if (current !== group) {
        current.classList.remove('open');
        setExpanded(current, false);
      }
    });
    group.classList.add('open');
    setExpanded(group, true);
  }

  groups.forEach((group) => {
    const trigger = group.querySelector('.nav-trigger');
    let hoverTimer;

    trigger?.addEventListener('click', (event) => {
      event.preventDefault();
      const isOpen = group.classList.contains('open');
      if (isOpen) {
        group.classList.remove('open');
        setExpanded(group, false);
        return;
      }
      openGroup(group);
    });

    group.addEventListener('pointerenter', () => {
      clearTimeout(hoverTimer);
      openGroup(group);
    });

    group.addEventListener('pointerleave', () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        group.classList.remove('open');
        setExpanded(group, false);
      }, 120);
    });

    group.addEventListener('focusin', () => openGroup(group));
  });

  const isCompactNav = () => (drawerMedia ? drawerMedia.matches : window.innerWidth <= 940);

  let drawerOpen = false;

  function applyDrawerState(open) {
    const compact = isCompactNav();
    drawerOpen = compact ? Boolean(open) : false;

    document.body.classList.toggle('nav-drawer-open', drawerOpen);

    if (menuToggle) {
      menuToggle.setAttribute('aria-expanded', drawerOpen ? 'true' : 'false');
    }
    if (navPanel) {
      navPanel.setAttribute('aria-hidden', compact ? (drawerOpen ? 'false' : 'true') : 'false');
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

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeAllGroups();
    closeDrawer({ focusToggle: true });
  });

  document.addEventListener('click', (event) => {
    if (!nav.contains(event.target)) {
      closeAllGroups();
    }
  });

  nav.querySelectorAll('.nav-dropdown a').forEach((link) => {
    link.addEventListener('click', () => closeAllGroups());
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
  };

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
      // If auth/mTLS checks fail, keep a deterministic status instead of stale text.
      window.__navStatus.setMtls({ required: true, present: false });
    }
  }

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
    if (/\/admin\/hosts\/\d+\/?$/.test(pathname)) return 'hosts';
    if (/\/admin\/?$/.test(pathname)) return 'dashboard';
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

    const hashView = inferViewFromHash(window.location.hash);
    if (hashView) return hashView;

    const pathView = inferViewFromPath(normalizePath(window.location.pathname));
    return pathView || 'dashboard';
  }

  function linkViewKey(link) {
    const datasetView = normalizePanelKey(link.dataset?.nav || '');
    if (datasetView) return datasetView;

    const href = String(link.getAttribute('href') || '').trim();
    if (!href) return '';

    if (href.startsWith('#')) {
      return inferViewFromHash(href);
    }

    let linkUrl = null;
    try {
      linkUrl = new URL(href, window.location.origin);
    } catch (_) {
      return '';
    }

    const queryView = normalizePanelKey(linkUrl.searchParams.get('view') || '');
    if (queryView) return queryView;

    return inferViewFromPath(normalizePath(linkUrl.pathname));
  }

  function syncActiveLinks() {
    const activeView = currentViewKey();
    document.querySelectorAll('.nav-item.has-children').forEach((group) => {
      group.classList.remove('active');
    });

    document.querySelectorAll('a.nav-item, .nav-dropdown a, a.menu-link').forEach((link) => {
      const linkView = linkViewKey(link);
      const isActive = !!linkView && linkView === activeView;
      link.classList.toggle('active', isActive);

      if (isActive) {
        const parentGroup = link.closest('.has-children');
        parentGroup?.classList.add('active');
      }
    });
  }

  const syncAndCloseForNavigation = () => {
    syncActiveLinks();
    closeAllGroups();
    closeDrawer();
  };

  document.querySelectorAll('a.nav-item, .nav-dropdown a, a.menu-link').forEach((link) => {
    link.addEventListener('click', () => {
      // Hash-driven routing runs after click; run an immediate sync as feedback.
      syncAndCloseForNavigation();
    });
  });

  window.addEventListener('hashchange', () => {
    syncAndCloseForNavigation();
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

  applyDrawerState(false);
  syncActiveLinks();
})();
