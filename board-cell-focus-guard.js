/*
 * Guard against realtime table redraws moving the cursor into the same column
 * on the first trip above the one being edited.
 *
 * loadboard.js already restores focus after a redraw, but its fallback selector
 * is keyed by row + field. A shift can contain several trip rows with the same
 * field name, so that selector can resolve to the first matching trip instead
 * of the exact trip the dispatcher was editing.
 *
 * This guard remembers the exact row + trip + field. If a redraw replaces the
 * focused DOM node and the generic restore lands on a sibling trip, immediately
 * move focus back to the exact trip. Normal clicks and Tab navigation are left
 * alone.
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
  if (!ds.row || !ds.field || !ds.trip) return null;
  if (!el.closest('#board-table')) return null;
  return {
    row: String(ds.row),
    trip: String(ds.trip),
    field: String(ds.field),
  };
}

function sameColumn(a, b) {
  return !!a && !!b && a.row === b.row && a.field === b.field;
}

function exactSelector(id) {
  return `#board-table [data-row="${esc(id.row)}"][data-trip="${esc(id.trip)}"][data-field="${esc(id.field)}"]`;
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

// A click/tap or keyboard Tab is a real navigation request and must win over
// the guard. The short window covers the focus() call made by the board's
// spreadsheet-style Tab handler on the next animation frame.
document.addEventListener('pointerdown', (event) => {
  if (cellIdentity(event.target)) navigationIntentUntil = performance.now() + 350;
}, true);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && cellIdentity(event.target)) navigationIntentUntil = performance.now() + 350;
}, true);

document.addEventListener('focusin', (event) => {
  if (correcting) return;
  const nextEl = event.target;
  const next = cellIdentity(nextEl);
  if (!next) return;

  const userNavigated = performance.now() <= navigationIntentUntil;
  const oldNodeWasReplaced = !!tracked?.el && !tracked.el.isConnected;

  if (!userNavigated && oldNodeWasReplaced && sameColumn(tracked, next) && tracked.trip !== next.trip) {
    const exact = document.querySelector(exactSelector(tracked));
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

for (const type of ['input', 'keyup', 'mouseup', 'select']) {
  document.addEventListener(type, refreshSelection, true);
}
