(() => {
  'use strict';

  const allowed = new Set(['atlanta', 'delaware', 'houston', 'mondelez', 'preferred']);
  const requested = new URLSearchParams(window.location.search).get('location');
  if (!allowed.has(requested || '')) return;

  let attempts = 0;
  const openRequestedTab = () => {
    const button = document.querySelector(`#driverlist-location-tabs .location-tab[data-location="${CSS.escape(requested)}"]`);
    if (button) {
      if (!button.classList.contains('is-active')) button.click();
      return;
    }
    attempts += 1;
    if (attempts < 40) setTimeout(openRequestedTab, 100);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openRequestedTab);
  else openRequestedTab();
})();
