/*
 * Simple spreadsheet-style editing for the main load board.
 *
 * The board intentionally re-renders after Supabase realtime events. A render
 * destroys every input node. loadboard.js then restores focus using row+field;
 * on a multi-trip shift that selector is not unique, so the browser can land
 * on the same column in the FIRST trip while the dispatcher was editing trip 2.
 *
 * This helper keeps one boring rule: the user's logical cell is
 *   row + optional trip + field
 * and a background redraw is never allowed to turn that into another cell.
 *
 * It also keeps a just-typed value protected for a few seconds so an older
 * realtime echo cannot replace the local value during the board's 700ms
 * debounced save window.
 */

const CELL_SELECTOR = [
  '#board-table input[data-row][data-field]:not([disabled]):not([readonly]):not([type="checkbox"]):not([tabindex="-1"])',
  '#board-table textarea[data-row][data-field]:not([disabled]):not([readonly]):not([tabindex="-1"])',
  '#board-table select[data-row][data-field]:not([disabled]):not([tabindex="-1"])',
].join(',');

// Long enough to cover the board's 700ms debounce plus a normal Supabase
// round-trip/realtime echo. This is not permanent local ownership: after the
// short window, normal remote updates win again.
const DIRTY_PROTECT_MS = 5000;

let tracked = null;
let observer = null;
let correctingFocus = false;
let repairingValue = false;
let expectedFocus = null;
let pointerFocus = null;
let pointerFocusUntil = 0;
const recentDirty = new Map();

function esc(value) {
  if (window.CSS && typeof CSS.escape === 'function') return CSS.escape(String(value));
  return String(value).replace(/(["\\])/g, '\\$1');
}

function identity(el) {
  if (!(el instanceof HTMLElement) || !el.matches(CELL_SELECTOR)) return null;
  return {
    row: String(el.dataset.row || ''),
    field: String(el.dataset.field || ''),
    trip: el.dataset.trip != null && el.dataset.trip !== '' ? String(el.dataset.trip) : null,
  };
}

function keyFor(id) {
  return id ? `${id.row}\u001f${id.trip || ''}\u001f${id.field}` : '';
}

function sameIdentity(a, b) {
  return !!a && !!b && a.row === b.row && a.field === b.field && (a.trip || null) === (b.trip || null);
}

function snapshot(el, prior = null) {
  const id = identity(el);
  if (!id) return null;
  return {
    ...id,
    el,
    value: 'value' in el ? el.value : null,
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
    dirty: !!prior?.dirty,
  };
}

function exactCell(id) {
  if (!id) return null;
  let selector = `#board-table [data-row="${esc(id.row)}"][data-field="${esc(id.field)}"]`;
  selector += id.trip != null
    ? `[data-trip="${esc(id.trip)}"]`
    : ':not([data-trip]), #board-table [data-row="' + esc(id.row) + '"][data-field="' + esc(id.field) + '"][data-trip=""]';
  const el = document.querySelector(selector);
  return el instanceof HTMLElement && el.matches(CELL_SELECTOR) ? el : null;
}

function visibleCells() {
  return [...document.querySelectorAll(CELL_SELECTOR)].filter((el) => el.getClientRects().length > 0);
}

function restoreSelection(el, snap) {
  if (snap.start == null || typeof el.setSelectionRange !== 'function') return;
  try { el.setSelectionRange(snap.start, snap.end); } catch (_) { /* non-text control */ }
}

function rememberDirty(snap) {
  if (!snap || snap.value == null) return;
  recentDirty.set(keyFor(snap), {
    row: snap.row,
    trip: snap.trip,
    field: snap.field,
    value: snap.value,
    expires: Date.now() + DIRTY_PROTECT_MS,
  });
}

function pruneDirty() {
  const now = Date.now();
  for (const [key, dirty] of recentDirty) {
    if (dirty.expires <= now) recentDirty.delete(key);
  }
}

function feedValueBack(el, value) {
  if (!('value' in el) || el.value === value) return false;
  repairingValue = true;
  try {
    el.value = value;
    // Re-use the board's normal input path. That immediately repairs its
    // in-memory row/trip and schedules the ordinary Supabase save.
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    repairingValue = false;
  }
  return true;
}

function protectRecentDirtyValues() {
  pruneDirty();
  for (const dirty of recentDirty.values()) {
    const el = exactCell(dirty);
    if (el) feedValueBack(el, dirty.value);
  }
}

function repairTrackedCell() {
  if (!tracked) return false;
  const replacement = exactCell(tracked);
  if (!replacement) return false;

  // Only protect the value if the dispatcher actually typed in this cell.
  // Merely sitting in a blank cell should preserve focus but should not block
  // a legitimate remote dispatcher from filling that cell.
  if (tracked.dirty && tracked.value != null) feedValueBack(replacement, tracked.value);

  correctingFocus = true;
  try {
    if (document.activeElement !== replacement) replacement.focus({ preventScroll: true });
    restoreSelection(replacement, tracked);
  } finally {
    correctingFocus = false;
  }

  tracked = snapshot(replacement, tracked);
  return true;
}

function moveByTab(event) {
  const current = event.target;
  if (!(current instanceof HTMLElement) || !current.matches(CELL_SELECTOR)) return;

  const cells = visibleCells();
  const index = cells.indexOf(current);
  if (index < 0) return;

  const nextIndex = event.shiftKey ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= cells.length) {
    // The user is intentionally tabbing out of the grid.
    tracked = null;
    expectedFocus = null;
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const next = cells[nextIndex];
  expectedFocus = identity(next);
  correctingFocus = true;
  try {
    next.focus({ preventScroll: true });
    if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'time') {
      try { next.select(); } catch (_) { /* ignore */ }
    }
  } finally {
    correctingFocus = false;
  }
  tracked = snapshot(next);
  expectedFocus = null;
}

function closeDriverPickerAfterEnter(event) {
  if (event.key !== 'Enter') return;
  requestAnimationFrame(() => document.getElementById('driver-ac-floating')?.classList.add('hidden'));
}

function install() {
  const board = document.getElementById('board-table');
  if (!board) return;

  // Mouse/touch establishes a real user-selected cell. This is deliberately
  // separate from focusin because loadboard.js itself calls focus() after a
  // redraw, and that programmatic focus must NOT redefine the user's cell.
  document.addEventListener('pointerdown', (event) => {
    const cell = event.target instanceof HTMLElement && event.target.matches(CELL_SELECTOR)
      ? event.target
      : null;

    if (cell) {
      pointerFocus = identity(cell);
      pointerFocusUntil = performance.now() + 500;
      return;
    }

    // Clicking anywhere else is an intentional departure from the text cell.
    if (event.target.closest?.('#board-table')) {
      tracked = null;
      expectedFocus = null;
    } else {
      tracked = null;
      expectedFocus = null;
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') moveByTab(event);
  }, true);

  document.addEventListener('keyup', closeDriverPickerAfterEnter, true);

  document.addEventListener('focusin', (event) => {
    if (correctingFocus) return;
    const next = snapshot(event.target);
    if (!next) return;

    const pointerChosen = pointerFocus && performance.now() <= pointerFocusUntil && sameIdentity(pointerFocus, next);
    const tabChosen = expectedFocus && sameIdentity(expectedFocus, next);

    if (!tracked || pointerChosen || tabChosen) {
      tracked = next;
      pointerFocus = null;
      expectedFocus = null;
      return;
    }

    if (sameIdentity(tracked, next)) {
      // This can be the exact replacement node after a redraw.
      if (tracked.dirty && tracked.value != null) feedValueBack(event.target, tracked.value);
      tracked = snapshot(event.target, tracked);
      return;
    }

    // Critical case: renderBoardTable() destroyed the user's input, then the
    // board's older row+field restore focused the first matching trip above it.
    // Do not let that synthetic focus become the new truth. Correct it before
    // the browser paints the jump.
    if (tracked.el && !tracked.el.isConnected) {
      const old = tracked;
      if (repairTrackedCell()) {
        event.stopImmediatePropagation();
        tracked = snapshot(exactCell(old), old) || tracked;
        return;
      }
    }

    // A connected old node plus a different focus was not caused by replacing
    // the row. Treat it as a legitimate focus move rather than fighting it.
    tracked = next;
  }, true);

  document.addEventListener('input', (event) => {
    const snap = snapshot(event.target, tracked);
    if (!snap) return;

    if (!repairingValue) {
      snap.dirty = true;
      rememberDirty(snap);
    } else if (tracked && sameIdentity(tracked, snap)) {
      snap.dirty = tracked.dirty;
    }
    tracked = snap;
  }, true);

  // Keep cursor offsets current without changing logical ownership.
  for (const type of ['keyup', 'mouseup', 'select']) {
    document.addEventListener(type, (event) => {
      if (!tracked || event.target !== tracked.el) return;
      tracked = snapshot(event.target, tracked);
    }, true);
  }

  observer = new MutationObserver(() => {
    // First repair recently typed data. This also covers the short interval
    // after Tab where the user has moved on but their previous cell is still
    // waiting for the debounced DB save to become authoritative.
    protectRecentDirtyValues();

    if (!tracked || tracked.el?.isConnected) return;
    repairTrackedCell();
  });
  observer.observe(board, { childList: true, subtree: true });
}

window.addEventListener('beforeunload', () => observer?.disconnect());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
