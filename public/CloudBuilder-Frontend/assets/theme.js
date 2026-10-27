(function () {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = null;
  try { const saved = localStorage.getItem('cloudbuilder-theme'); if (saved === 'light' || saved === 'dark') preference = saved; } catch (_) {}
  function apply(theme) {
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const dark = theme === 'dark';
    document.querySelectorAll('.cc-theme-toggle').forEach(function (button) {
      button.setAttribute('aria-pressed', String(dark));
      button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? '#0F0A0A' : '#F5EFED';
    dispatchEvent(new CustomEvent('cloudbuilder:themechange', {detail:{theme}}));
  }
  apply(preference || (system.matches ? 'dark' : 'light'));
  document.addEventListener('DOMContentLoaded', function () {
    apply(root.dataset.theme);
    document.querySelectorAll('.cc-theme-toggle').forEach(function (button) {
      button.addEventListener('click', function () {
        preference = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('cloudbuilder-theme', preference); } catch (_) {}
        apply(preference);
      });
    });
  });
  system.addEventListener('change', function () { if (!preference) apply(system.matches ? 'dark' : 'light'); });
  addEventListener('storage', function (event) {
    if (event.key !== 'cloudbuilder-theme') return;
    preference = event.newValue === 'light' || event.newValue === 'dark' ? event.newValue : null;
    apply(preference || (system.matches ? 'dark' : 'light'));
  });
})();
