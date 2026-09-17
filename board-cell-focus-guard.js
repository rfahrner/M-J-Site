/*
 * Guard against realtime/table redraws moving the cursor away from the exact
 * logical cell a dispatcher is editing.
 *
 * The board redraws after saves and realtime updates. A redraw destroys the
 * focused input node, then loadboard.js restores focus by row/field. Trip rows
 * can share the same row + field, and shift-level cells (Driver, PRO, Start,
 * etc.) do not always have data-trip at all. Track row + field + optional trip
 * so both kinds of cells restore to the exact logical location.
 */

let tracked = null;
let correcting = false;
let navigationIntentUntil = 0;

function esc(value) {
  if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(String(value));
  return String(value).replace(/(["\\])/g, '\\$1');
}

function cellIdentity(el) {
  if (!(el instanceof HTMLElement)) return null;
  const ds = el.dataset || {};
  if (!ds.row || !ds.field) return null;
  if (!el.closest('#board-table')) return null;
  return {
    row: String(ds.row),
    trip: ds.trip != null && ds.trip !== '' ? String(ds.trip) : null,
    field: String(ds.field),
  };
}

function sameLogicalCell(a, b) {
  return !!a && !!b &&
    a.row === b.row &&
    a.field === b.field &&
    (a.trip || null) === (b.trip || null);
}

function exactSelector(id) {
  let selector = `#board-table [data-row="${esc(id.row)}"][data-field="${esc(id.field)}"]`;
  if (id.trip != null) selector += `[data-trip="${esc(id.trip)}"]`;
  else selector += ':not([data-trip]), #board-table [data-row="' + esc(id.row) + '"][data-field="' + esc(id.field) + '"][data-trip=""]';
  return selector;
}

function exactCell(id) {
  if (!id) return null;
  if (id.trip != null) {
    return document.querySelector(`#board-table [data-row="${esc(id.row)}"][data-field="${esc(id.field)}"][data-trip="${esc(id.trip)}"]`);
  }
  return document.querySelector(`#board-table [data-row="${esc(id.row)}"][data-field="${esc(id.field)}"]:not([data-trip]), #board-table [data-row="${esc(id.row)}"][data-field="${esc(id.field)}"][data-trip=""]`);
}

function selectionFor(el) {
  return {
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
  };
}

function remember(el) {
  const id = cellIdentity(el);
  if (!id) return;
  tracked = { ...id, el, ...selectionFor(el) };
}

function refreshSelection(event) {
  if (!tracked || event.target !== tracked.el) return;
  Object.assign(tracked, selectionFor(tracked.el));
}

function closeDriverSuggestions() {
  const selectors = [
    '#driver-autocomplete',
    '#driver-autocomplete-list',
    '.driver-autocomplete',
    '.driver-autocomplete-list',
    '#board-table .autocomplete-list',
    '.autocomplete-list[data-driver-autocomplete]',
  ];
  document.querySelectorAll(selectors.join(',')).forEach((el) => {
    el.classList.add('hidden');
    if (el instanceof HTMLElement) el.style.display = 'none';
  });
}

// Click/tap, Tab, arrows and Enter are real navigation/selection requests.
// Give the board's own handlers a short window to move focus intentionally.
document.addEventListener('pointerdown', (event) => {
  if (cellIdentity(event.target)) navigationIntentUntil = performance.now() + 500;
}, true);

document.addEventListener('keydown', (event) => {
  if (!cellIdentity(event.target)) return;
  if (event.key === 'Tab' || event.key === 'Enter' || event.key.startsWith('Arrow')) {
    navigationIntentUntil = performance.now() + 500;
  }
}, true);

// The board accepts a driver with Enter but previously left the suggestion
// popup visible. Run after the board's keydown selection logic has completed.
document.addEventListener('keyup', (event) => {
  if (event.key !== 'Enter' || !cellIdentity(event.target)) return;
  requestAnimationFrame(closeDriverSuggestions);
}, true);

document.addEventListener('focusin', (event) => {
  if (correcting) return;
  const nextEl = event.target;
  const next = cellIdentity(nextEl);
  if (!next) return;

  const userNavigated = performance.now() <= navigationIntentUntil;
  const oldNodeWasReplaced = !!tracked?.el && !tracked.el.isConnected;

  // If a redraw replaced the active node, the only acceptable automatic
  // landing spot is the exact row + field + trip (when a trip exists).
  if (!userNavigated && oldNodeWasReplaced && tracked && !sameLogicalCell(tracked, next)) {
    const exact = exactCell(tracked);
    if (exact && exact !== nextEl) {
      const { start, end } = tracked;
      correcting = true;
      exact.focus({ preventScroll: true });
      if (start != null && typeof exact.setSelectionRange === 'function') {
        try { exact.setSelectionRange(start, end); } catch (_) { /* non-text input */ }
      }
      tracked = { ...tracked, el: exact };
      correcting = false;
      return;
    }
  }

  remember(nextEl);
}, true);

// A MutationObserver catches the case where a redraw removes the focused node
// and the board does not focus anything at all afterward.
const observer = new MutationObserver(() => {
  if (correcting || !tracked?.el || tracked.el.isConnected) return;
  if (performance.now() <= navigationIntentUntil) return;
  const exact = exactCell(tracked);
  if (!exact) return;
  const { start, end } = tracked;
  correcting = true;
  requestAnimationFrame(() => {
    try {
      exact.focus({ preventScroll: true });
      if (start != null && typeof exact.setSelectionRange === 'function') exact.setSelectionRange(start, end);
      tracked = { ...tracked, el: exact };
    } catch (_) { /* cell disappeared for good */ }
    correcting = false;
  });
});

function startObserver() {
  const board = document.getElementById('board-table');
  if (board) observer.observe(board, { childList: true, subtree: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObserver, { once: true });
else startObserver();

for (const type of ['input', 'keyup', 'mouseup', 'select']) {
  document.addEventListener(type, refreshSelection, true);
}
