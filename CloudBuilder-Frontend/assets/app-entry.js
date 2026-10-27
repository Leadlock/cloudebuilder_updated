(function () {
  const configured = window.CLOUDBUILDER_CONFIG && window.CLOUDBUILDER_CONFIG.appEntryUrl;
  if (!configured) return;
  let destination;
  try {
    destination = new URL(configured, location.href);
    const rootRelative = typeof configured === 'string' && configured.startsWith('/') && !configured.startsWith('//');
    if (!rootRelative && destination.protocol !== 'https:') return;
    if (destination.username || destination.password) return;
  } catch (_) { return; }
  document.querySelectorAll('[data-app-entry], .hero-actions .btn-primary').forEach(function (link) {
    link.href = destination.href;
  });
})();
