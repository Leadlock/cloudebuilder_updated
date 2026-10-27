document.addEventListener('DOMContentLoaded', function () {
  const selectors = [
    '.cc-header-button', '.hero-actions .btn', '.scope-notice-primary',
    '.scope-notice-toggle', '.next-primary', '.next-secondary', '.detail-cta',
    '.cta-actions .btn', '.cta-actions .button', 'a.button.primary', 'a.button.ghost'
  ];
  document.querySelectorAll(selectors.join(',')).forEach(function (button) {
    if (button.classList.contains('vng-button')) return;
    button.classList.add('vng-button');
    const label = document.createElement('span');
    label.className = 'animated-button-label';
    while (button.firstChild) label.appendChild(button.firstChild);
    button.appendChild(label);
    // Some controls update their label after interaction. Restore the wrapper
    // if that existing behavior replaces the button's text content.
    new MutationObserver(function () {
      if (button.contains(label)) return;
      label.replaceChildren();
      while (button.firstChild) label.appendChild(button.firstChild);
      button.appendChild(label);
    }).observe(button, {childList:true});
  });
});
