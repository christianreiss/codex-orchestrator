(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('embed') === '1') {
    document.body.classList.add('embed');
  }

  const nav = document.querySelector('.main-nav');
  const mtlsStatus = document.getElementById('mtlsStatus');
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

  function setStatusChip(el, state) {
    if (!el) return;
    el.classList.remove('ok', 'warn', 'err');
    const { label, variant } = state;
    if (variant) el.classList.add(variant);
    el.textContent = label;
  }

  // Expose setters so dashboard.js can reflect backend state
  window.__navStatus = {
    setMtls: (meta) => {
      if (!mtlsStatus) return;
      if (!meta) return setStatusChip(mtlsStatus, { label: 'mTLS: unknown', variant: 'warn' });
      // expected states: none, offered, enforced
      if (meta.enforced) return setStatusChip(mtlsStatus, { label: 'mTLS: enforced', variant: 'ok' });
      if (meta.present) return setStatusChip(mtlsStatus, { label: 'mTLS: offered', variant: 'warn' });
      return setStatusChip(mtlsStatus, { label: 'mTLS: none', variant: 'err' });
    },
  };

  async function hydrateStatus() {
    try {
      const resp = await fetch('/admin/overview', { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      window.__navStatus.setMtls(json?.data?.mtls ?? null);
    } catch (err) {
      // If mTLS/auth fail, surface a clear missing state so the chip doesn't sit on "checking…".
      window.__navStatus.setMtls({ required: true, present: false });
    }
  }

  hydrateStatus();

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
    const anchor = (window.location.hash || '').replace(/^#/, '');
    if (anchor) return anchor.toLowerCase();
    if (/\/admin\/?$/.test(pathname)) return 'dashboard';
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
