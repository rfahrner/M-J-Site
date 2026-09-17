/*
 * Simple spreadsheet-style editing for the main load board.
 *
 * Goals:
 * - Tab moves to the next visible editable cell in DOM order.
 * - Shift+Tab moves backward.
 * - A realtime redraw must never erase what the dispatcher is actively typing.
 * - No row-selection/focus heuristics, no row jumping.
 *
 * This module runs in capture phase so it owns Tab before loadboard.js's older
 * row-aware Tab handler sees the event. Everything else is left to the board.
 */

const CELL_SELECTOR = [
  '#board-table input[data-row][data-field]:not([disabled]):not([readonly]):not([type="checkbox"]):not([tabindex="-1"])',
  '#board-table textarea[data-row][data-field]:not([disabled]):not([readonly]):not([tabindex="-1"])',
  '#board-table select[data-row][data-field]:not([disabled]):not([tabindex="-1"])',
].join(',');

let active = null;
let intentionalMove = false;
let observer = null;

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

function snapshot(el) {
  const id = identity(el);
  if (!id) return null;
  return {
    ...id,
    el,
    value: 'value' in el ? el.value : null,
    start: typeof el.selectionStart === 'number' ? el.selectionStart : null,
    end: typeof el.selectionEnd === 'number' ? el.selectionEnd : null,
  };
}

function sameIdentity(a, b) {
  return !!a && !!b && a.row === b.row && a.field === b.field && (a.trip || null) === (b.trip || null);
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

function protectTypedValue(el, snap) {
  if (snap.value == null || !('value' in el) || el.value === snap.value) return;
  el.value = snap.value;
  // Re-feed the value through the board's normal input handler so the in-memory
  // row/trip and debounced Supabase save are put back in sync too.
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function moveByTab(event) {
  const current = event.target;
  if (!(current instanceof HTMLElement) || !current.matches(CELL_SELECTOR)) return;

  const cells = visibleCells();
  const index = cells.indexOf(current);
  if (index < 0) return;

  const nextIndex = event.shiftKey ? index - 1 : index + 1;
  if (nextIndex < 0 || nextIndex >= cells.length) return; // allow normal browser escape at the ends

  event.preventDefault();
  event.stopImmediatePropagation();

  intentionalMove = true;
  const next = cells[nextIndex];
  next.focus({ preventScroll: true });
  if (typeof next.select === 'function' && next.tagName === 'INPUT' && next.type !== 'time') {
    try { next.select(); } catch (_) { /* ignore */ }
  }
  active = snapshot(next);
  queueMicrotask(() => { intentionalMove = false; });
}

function closeDriverPickerAfterEnter(event) {
  if (event.key !== 'Enter') return;
  requestAnimationFrame(() => document.getElementById('driver-ac-floating')?.classList.add('hidden'));
}

function install() {
  const board = document.getElementById('board-table');
  if (!board) return;

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') moveByTab(event);
  }, true);

  document.addEventListener('keyup', closeDriverPickerAfterEnter, true);

  document.addEventListener('focusin', (event) => {
    const snap = snapshot(event.target);
    if (snap) active = snap;
  }, true);

  document.addEventListener('input', (event) => {
    const snap = snapshot(event.target);
    if (snap) active = snap;
  }, true);

  // A normal click outside the board means the dispatcher intentionally left
  // the cell. Do not pull focus back afterward.
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest?.('#board-table')) active = null;
    else intentionalMove = true;
    queueMicrotask(() => { intentionalMove = false; });
  }, true);

  document.addEventListener('focusout', (event) => {
    const leaving = active?.el === event.target;
    if (!leaving) return;
    queueMicrotask(() => {
      // If the old node still exists, this was a real blur (Enter/click/etc.).
      // If it was destroyed by a redraw, leave active intact so the observer
      // can restore the exact cell and value.
      if (active?.el?.isConnected && !identity(document.activeElement)) active = null;
    });
  }, true);

  observer = new MutationObserver(() => {
    if (!active || intentionalMove || active.el?.isConnected) return;
    const replacement = exactCell(active);
    if (!replacement) return;

    const snap = { ...active };
    protectTypedValue(replacement, snap);
    replacement.focus({ preventScroll: true });
    restoreSelection(replacement, snap);
    active = snapshot(replacement);
  });
  observer.observe(board, { childList: true, subtree: true });
}

window.addEventListener('beforeunload', () => observer?.disconnect());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
else install();
