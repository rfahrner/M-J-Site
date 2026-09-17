const ALLOWED_DRIVER_RATINGS = ['A', 'B', 'C', 'D', 'DNU', 'R'];

function normalizeDriverRating(value) {
  const rating = String(value || '').trim().toUpperCase();
  if (!rating) return '';
  if (rating.includes('DNU')) return 'DNU';
  const first = rating.charAt(0);
  return ALLOWED_DRIVER_RATINGS.includes(first) ? first : '';
}

function installDriverRatingDropdown() {
  const current = document.getElementById('ad-rating');
  if (!current || current.tagName === 'SELECT') return;

  const select = document.createElement('select');
  select.id = 'ad-rating';
  select.className = current.className;
  select.innerHTML = [
    '<option value="">-- none set --</option>',
    ...ALLOWED_DRIVER_RATINGS.map((rating) => `<option value="${rating}">${rating}</option>`),
  ].join('');

  // loadboard.js writes existing profile values through element.value.  Some
  // older records still contain legacy values such as A1/B2 or free-text DNU
  // notes.  Normalize those writes into the six supported ratings so opening
  // an old profile does not leave the dropdown blank or reintroduce free text.
  const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (nativeValue?.get && nativeValue?.set) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return nativeValue.get.call(this); },
      set(value) { nativeValue.set.call(this, normalizeDriverRating(value)); },
    });
  }

  select.value = current.value;
  current.replaceWith(select);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installDriverRatingDropdown, { once: true });
} else {
  installDriverRatingDropdown();
}
