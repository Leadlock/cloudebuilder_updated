document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('.scope-notice-toggle').forEach(function (button) {
    const card = button.closest('.scope-notice');
    const details = card.querySelector('.scope-notice-details');
    details.setAttribute('aria-hidden', 'true');
    button.addEventListener('click', function () {
      const expanded = card.classList.toggle('is-expanded');
      button.setAttribute('aria-expanded', String(expanded));
      details.setAttribute('aria-hidden', String(!expanded));
      button.textContent = expanded ? 'Hide scope details' : 'View scope details';
    });
  });
});
