(() => {
  const nav = document.querySelector('.main-nav');
  if (!nav) return;

  const groups = Array.from(nav.querySelectorAll('.nav-item.has-children'));

  function closeAll() {
    groups.forEach((g) => g.classList.remove('open'));
  }

  groups.forEach((group) => {
    const trigger = group.querySelector('.nav-trigger');
    trigger?.addEventListener('click', (ev) => {
      ev.preventDefault();
      const isOpen = group.classList.contains('open');
      closeAll();
      if (!isOpen) group.classList.add('open');
    });
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

  const here = normalize(window.location.pathname);
  nav.querySelectorAll('a.nav-item, .nav-dropdown a').forEach((link) => {
    const href = link.getAttribute('href');
    const linkPath = normalize(href ? href.split('?')[0] : '');
    if (linkPath === here) {
      link.classList.add('active');
      const parent = link.closest('.has-children');
      parent?.classList.add('active');
    }
  });
})();
