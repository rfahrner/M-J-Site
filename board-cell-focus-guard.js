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
let pendingTabTarget = null;
let pendingTabUntil = 0;

const EDITABLE_SELECTOR = 'input:not([disabled]):not([readonly]):not([type="checkbox"]):not([tabindex="-1"]), textarea:not([disabled]):not([readonly]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"])';

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
    '#driver-ac-floating',
    '#driver-autocomplete',
    '#driver-autocomplete-list',
    '.driver-autocomplete',
    '.driver-autocomplete-list',
    '#board-table .autocomplete-list',
    '.autocomplete-list[data-driver-autocomplete]',
  ];
  document.querySelectorAll(selectors.join(',')).forEach((el) => el.classList.add('hidden'));
}

function tabDestination(el, reverse) {
  const tr = el.closest('tr');
  if (!tr) return null;
  const rowFields = Array.from(tr.querySelectorAll(EDITABLE_SELECTOR));
  const index = rowFields.indexOf(el);
  if (index === -1) return null;
  const inRow = reverse ? rowFields[index - 1] : rowFields[index + 1];
  if (inRow) return cellIdentity(inRow);

  let sibling = reverse ? tr.previousElementSibling : tr.nextElementSibling;
  while (sibling) {
    const fields = Array.from(sibling.querySelectorAll(EDITABLE_SELECTOR));
    const target = reverse ? fields[fields.length - 1] : fields[0];
    const identity = cellIdentity(target);
    if (identity) return identity;
    sibling = reverse ? sibling.previousElementSibling : sibling.nextElementSibling;
  }
  return null;
}

function focusExact(id, start = null, end = null) {
  const exact = exactCell(id);
  if (!exact) return false;
  correcting = true;
  try {
    exact.focus({ preventScroll: true });
    if (start != null && typeof exact.setSelectionRange === 'function') {
      try { exact.setSelectionRange(start, end); } catch (_) { /* non-text input */ }
    }
    tracked = { ...id, el: exact, ...selectionFor(exact) };
  } finally {
    correcting = false;
  }
  return true;
}

// Clicking/tapping is always intentional and cancels any pending keyboard move.
document.addEventListener('pointerdown', (event) => {
  if (!cellIdentity(event.target)) return;
  pendingTabTarget = null;
  pendingTabUntil = 0;
  navigationIntentUntil = performance.now() + 500;
}, true);

document.addEventListener('keydown', (event) => {
  const current = cellIdentity(event.target);
  if (!current) return;

  if (event.key === 'Tab') {
    // Capture the exact logical destination BEFORE blur/save/realtime redraws
    // can replace the row. This is the important distinction for multi-trip
    // shifts: row + field is not unique, but row + trip + field is.
    pendingTabTarget = tabDestination(event.target, event.shiftKey);
    pendingTabUntil = performance.now() + 1200;
    navigationIntentUntil = performance.now() + 500;
    return;
  }

  pendingTabTarget = null;
  pendingTabUntil = 0;
  if (event.key === 'Enter' || event.key.startsWith('Arrow')) {
    navigationIntentUntil = performance.now() + 500;
  }
}, true);

// The board accepts a driver with Enter on keydown. Close the floating picker
// on keyup, after the board has had a chance to apply the selection/save.
document.addEventListener('keyup', (event) => {
  if (event.key !== 'Enter' || !cellIdentity(event.target)) return;
  requestAnimationFrame(closeDriverSuggestions);
}, true);

document.addEventListener('focusin', (event) => {
  if (correcting) return;
  const nextEl = event.target;
  const next = cellIdentity(nextEl);
  if (!next) return;

  // Tab has a known intended destination. If the board's generic focus
  // restore lands on the first Trip ID/Route ID in the shift instead, correct
  // it immediately to the exact trip the user was tabbing through.
  if (pendingTabTarget && performance.now() <= pendingTabUntil) {
    if (sameLogicalCell(pendingTabTarget, next)) {
      pendingTabTarget = null;
      pendingTabUntil = 0;
      remember(nextEl);
      return;
    }
    if (focusExact(pendingTabTarget)) {
      pendingTabTarget = null;
      pendingTabUntil = 0;
      return;
    }
  } else {
    pendingTabTarget = null;
    pendingTabUntil = 0;
  }

  const userNavigated = performance.now() <= navigationIntentUntil;
  const oldNodeWasReplaced = !!tracked?.el && !tracked.el.isConnected;

  if (!userNavigated && oldNodeWasReplaced && tracked && !sameLogicalCell(tracked, next)) {
    if (focusExact(tracked, tracked.start, tracked.end)) return;
  }

  remember(nextEl);
}, true);

// A MutationObserver catches redraws that remove the focused node before the
// board can focus anything else. During Tab, prefer the captured destination;
// otherwise restore the exact cell that was being edited.
const observer = new MutationObserver(() => {
  if (correcting) return;

  if (pendingTabTarget && performance.now() <= pendingTabUntil) {
    const exactPending = exactCell(pendingTabTarget);
    if (exactPending && document.activeElement !== exactPending) {
      requestAnimationFrame(() => {
        if (!pendingTabTarget || performance.now() > pendingTabUntil) return;
        if (focusExact(pendingTabTarget)) {
          pendingTabTarget = null;
          pendingTabUntil = 0;
        }
      });
      return;
    }
  }

  if (!tracked?.el || tracked.el.isConnected) return;
  if (performance.now() <= navigationIntentUntil) return;
  const id = { row: tracked.row, trip: tracked.trip, field: tracked.field };
  const { start, end } = tracked;
  requestAnimationFrame(() => focusExact(id, start, end));
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
