(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') {
    document.body.classList.add('embed');
  }

  const nav = document.querySelector('.main-nav');
  if (!nav) return;

  const groups = Array.from(nav.querySelectorAll('.nav-item.has-children'));

  const setExpanded = (group, expanded) => {
    const trigger = group.querySelector('.nav-trigger');
    if (trigger) trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };

  function closeAll() {
    groups.forEach((g) => {
      g.classList.remove('open');
      setExpanded(g, false);
    });
  }

  function openGroup(group) {
    groups.forEach((g) => {
      if (g !== group) {
        g.classList.remove('open');
        setExpanded(g, false);
      }
    });
    group.classList.add('open');
    setExpanded(group, true);
  }

  groups.forEach((group) => {
    const trigger = group.querySelector('.nav-trigger');
    let hoverTimer;
    trigger?.addEventListener('click', (ev) => {
      ev.preventDefault();
      const isOpen = group.classList.contains('open');
      if (isOpen) {
        group.classList.remove('open');
        setExpanded(group, false);
      } else {
        openGroup(group);
      }
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

  document.addEventListener('click', (ev) => {
    if (!nav.contains(ev.target)) closeAll();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeAll();
  });
  nav.querySelectorAll('.nav-dropdown a').forEach((link) => {
    link.addEventListener('click', () => closeAll());
  });

  const normalize = (path) => {
    if (!path) return '/';
    try {
      const url = new URL(path, window.location.origin);
      path = url.pathname;
    } catch (_) {
      // ignore
    }
    return path.replace(/\/+$/, '') || '/';
  };

  const inferViewFromPath = (pathname) => {
    if (!pathname) return '';
    if (/agents\\.html$/.test(pathname)) return 'agents';
    if (/prompts\\.html$/.test(pathname)) return 'prompts';
    if (/settings\\.html$/.test(pathname)) return 'settings';
    if (/hosts\\.html$/.test(pathname)) return 'hosts';
    if (/memories\\.html$/.test(pathname)) return 'memories';
    if (/mcp-logs\\.html$/.test(pathname)) return 'memories';
    if (/logs\\.html$/.test(pathname)) return 'logs';
    if (/config\\.html$/.test(pathname)) return 'settings';
    if (/\\/admin\\/?$/.test(pathname)) return 'dashboard';
    return '';
  };

  const currentUrl = new URL(window.location.href);
  const herePath = normalize(currentUrl.pathname);
  const hereView = (
    document.body?.dataset?.viewMode ||
    currentUrl.searchParams.get('view') ||
    inferViewFromPath(herePath) ||
    'dashboard'
  ).toLowerCase();
  const hereStatus = (currentUrl.searchParams.get('host') || currentUrl.searchParams.get('status') || '').toLowerCase();

  document.querySelectorAll('a.nav-item, .nav-dropdown a, a.menu-link').forEach((link) => {
    const href = link.getAttribute('href');
    let linkUrl = null;
    try {
      linkUrl = new URL(href, window.location.origin);
    } catch (_) {
      // ignore
    }
    const linkPath = normalize(linkUrl?.pathname || (href ? href.split('?')[0] : ''));
    const linkView = (
      linkUrl?.searchParams.get('view') ||
      inferViewFromPath(linkUrl?.pathname) ||
      ''
    ).toLowerCase();
    const linkStatus = (linkUrl?.searchParams.get('host') || linkUrl?.searchParams.get('status') || '').toLowerCase();

    const pathMatch = linkPath === herePath;
    const viewMatch = linkView ? linkView === hereView : true;
    const statusMatch = linkStatus ? linkStatus === hereStatus : true;

    if (pathMatch && viewMatch && statusMatch) {
      link.classList.add('active');
      const parent = link.closest('.has-children');
      parent?.classList.add('active');
    }
  });
})();
