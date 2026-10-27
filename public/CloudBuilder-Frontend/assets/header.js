document.addEventListener('DOMContentLoaded', function () {
  const header = document.querySelector('.cc-site-header');
  if (!header) return;
  const firstSection = document.querySelector('main > .hero') || document.querySelector('main > section');
  function updateHeaderSurface() {
    header.classList.toggle('cc-scrolled', !!firstSection && firstSection.getBoundingClientRect().bottom <= header.offsetHeight);
  }
  let scrollFrame = 0;
  addEventListener('scroll', function () {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(function () { updateHeaderSurface(); scrollFrame = 0; });
  }, {passive:true});
  addEventListener('resize', updateHeaderSurface);
  addEventListener('load', updateHeaderSurface);
  updateHeaderSurface();
  const nav = header.querySelector('.cc-links');
  const links = Array.from(nav.querySelectorAll('a'));
  const indicator = nav.querySelector('.cc-indicator');
  const toggle = header.querySelector('.cc-menu');
  const normalize = path => path.replace(/index\.html$/, '').replace(/\/$/, '') || '/';
  const currentPath = normalize(location.pathname);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let initializing = true;
  let pendingNavigation;
  let selected = links.find(link => {
    const url = new URL(link.href);
    return normalize(url.pathname) === currentPath && (url.hash ? url.hash === location.hash : true);
  }) || (currentPath === '/' ? links[0] : null);
  function position(link) {
    if (!link || !nav.getClientRects().length) { indicator.hidden = true; return; }
    indicator.hidden = false;
    indicator.style.width = link.offsetWidth + 'px';
    const mobile = innerWidth <= 1100;
    indicator.style.transform = 'translate(' + link.offsetLeft + 'px,' + (mobile ? link.offsetTop + link.offsetHeight - 3 : 0) + 'px)';
  }
  function select(link) {
    selected = link;
    links.forEach(item => item.removeAttribute('aria-current'));
    if (link) link.setAttribute('aria-current', new URL(link.href).hash ? 'location' : 'page');
    position(link);
  }
  let previous;
  try {
    const stored = sessionStorage.getItem('cc-nav-origin');
    if (stored !== null) previous = Number(stored);
    sessionStorage.removeItem('cc-nav-origin');
  } catch (_) {}
  select(selected);
  indicator.classList.add('cc-initial');
  if (Number.isInteger(previous) && links[previous]) position(links[previous]);
  indicator.getBoundingClientRect();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    indicator.classList.remove('cc-initial');
    indicator.getBoundingClientRect();
    position(selected);
    initializing = false;
  }));
  links.forEach(link => link.addEventListener('click', function (event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    clearTimeout(pendingNavigation);
    const target = new URL(link.href);
    const changed = selected !== link;
    select(link);
    // Let the underline finish its slide before a new document replaces it.
    pendingNavigation = setTimeout(function () {
      if (normalize(target.pathname) !== currentPath) {
        try { sessionStorage.setItem('cc-nav-origin', String(links.indexOf(link))); } catch (_) {}
      }
      header.classList.remove('cc-open');
      toggle.setAttribute('aria-expanded', 'false');
      location.assign(target.href);
    }, changed && !reducedMotion.matches ? 600 : 0);
  }));
  toggle.addEventListener('click', () => {
    const open = header.classList.toggle('cc-open');
    toggle.setAttribute('aria-expanded', String(open));
    if (open) position(selected);
  });
  header.addEventListener('keydown', event => {
    if (event.key === 'Escape' && header.classList.contains('cc-open')) {
      header.classList.remove('cc-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!header.contains(event.target)) { header.classList.remove('cc-open'); toggle.setAttribute('aria-expanded', 'false'); }
  });
  addEventListener('hashchange', () => {
    const link = links.find(item => { const url = new URL(item.href); return normalize(url.pathname) === currentPath && url.hash === location.hash; });
    if (link) select(link);
  });
  if ('ResizeObserver' in window) new ResizeObserver(() => { if (!initializing) position(selected); }).observe(nav);
});
