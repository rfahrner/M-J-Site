// Site-wide row hover + board route-time visual accents.
//
// Standard load-board rows with multiple maximized routes are rendered as
// multiple <tr>s. Shift/driver cells live in the first row with rowspan,
// while later route rows only contain route-level cells. Native :hover on
// the later row therefore cannot reach the driver cells. This module keeps
// the hovered route row and its shared shift cells visually tied together,
// and applies the same strong full-row hover treatment to the other major
// operational tables across the site.

const TABLE_SELECTOR = 'table.board, table.driverlist, table.available-table';
// A comma is the lowest-precedence operator in a CSS selector, so appending
// ' tbody tr' to TABLE_SELECTOR does NOT mean "a row in any of these tables" --
// it parses as `table.board` OR `table.driverlist` OR `table.available-table
// tbody tr`, and closest() from a cell then answers with the <table>. Every
// class this module added on a board therefore landed on the table element,
// where no rule matches it, which is why the whole thing quietly did nothing
// on the two tables that are not last in the list. Distribute the suffix.
const ROW_SELECTOR = TABLE_SELECTOR.split(',')
  .map((sel) => `${sel.trim()} tbody tr`)
  .join(', ');
const HOVER_CLASS = 'site-row-hover-current';
const PARENT_CLASS = 'site-row-hover-parent';

function installStyles() {
  if (document.getElementById('board-row-hover-enhancement-styles')) return;

  const style = document.createElement('style');
  style.id = 'board-row-hover-enhancement-styles';
  style.textContent = `
    /* Keep the three operational return/dispatch times blue, while the
       driver's return ETA stays visibly distinct in yellow. */
    table.board th.col-dispatchTime,
    table.board td.col-dispatchTime,
    table.board th.col-lastStopDepart,
    table.board td.col-lastStopDepart,
    table.board th.col-returnToDC,
    table.board td.col-returnToDC {
      background: #c9ddf2 !important;
    }

    table.board th.col-returnEtaToDc,
    table.board td.col-returnEtaToDc {
      background: var(--butter-yellow) !important;
    }

    /* One consistent hover color across all primary operational tables.
       !important is deliberate: hover should temporarily win over status,
       zebra, completion, alert, and other background colors so the entire
       row reads as a single horizontal line. */
    table.board tbody tr.${HOVER_CLASS} > td,
    table.driverlist tbody tr.${HOVER_CLASS} > td,
    table.available-table tbody tr.${HOVER_CLASS} > td {
      background: #d7e8ff !important;
    }

    /* When hovering route 2+, the shift/driver cells are rowspanned from the
       first DOM row. Highlight only those shared pinned cells on the parent;
       do not light up route 1's route-level cells. */
    table.board tbody tr.${PARENT_CLASS} > td.pin {
      background: #d7e8ff !important;
    }

    /* The PRO# cell carries the completion / fully-documented tints and is
       itself a pinned cell, so without these it would turn blue whenever a
       later route of the same load is hovered and lose the green that says
       the shift is done. Match what the hovered row's own PRO# cell does. */
    table.board tbody tr.${PARENT_CLASS} > td.pin-pro.shift-complete-tint {
      background: rgba(34, 197, 94, 0.28) !important;
    }

    table.board tbody tr.${PARENT_CLASS} > td.pin-pro.pro-fully-documented {
      background: rgba(21, 128, 61, 0.42) !important;
    }
  `;
  document.head.appendChild(style);
}

function logicalParentId(tr) {
  if (!tr) return '';
  return tr.dataset.parentRow || tr.id || '';
}

// Which row each table currently has lit. Without this, applyHover() could not
// tell "the pointer moved to a different row" from "the pointer moved between
// two cells of the row it is already on", and did the full clear-and-re-add
// either way -- see the comment on applyHover().
const currentHover = new WeakMap();

function clearHover(table) {
  currentHover.delete(table);
  table.querySelectorAll(`tbody tr.${HOVER_CLASS}, tbody tr.${PARENT_CLASS}`).forEach((tr) => {
    tr.classList.remove(HOVER_CLASS, PARENT_CLASS);
  });
}

function applyHover(table, tr) {
  // mouseout bubbles, so it fires every time the pointer crosses from one cell
  // to the next INSIDE the row it is already on -- and its relatedTarget is
  // then that same row, which sent it straight back here. Every one of those
  // moves stripped the highlight off the row and its rowspanned parent and
  // immediately put it back, which is what read as the highlight jumping to
  // the neighbouring row and returning. Re-lighting the row that is already
  // lit is not work worth doing.
  if (currentHover.get(table) === tr) return;

  clearHover(table);
  currentHover.set(table, tr);
  tr.classList.add(HOVER_CLASS);
  watchForRedraws(table);

  // The rowspanned parent treatment is only needed on standard load boards.
  if (!table.matches('table.board')) return;

  const parentId = logicalParentId(tr);
  if (!parentId || !tr.dataset.parentRow) return;

  const parent = [...table.querySelectorAll('tbody tr')].find((row) => row.id === parentId);
  if (parent) parent.classList.add(PARENT_CLASS);
}

function rowFor(node) {
  return node?.closest?.(ROW_SELECTOR) || null;
}

// True when the pointer has landed on a cell that is rowspanned down from `tr`
// while one of tr's own route rows is the row currently lit.
//
// This is the flicker. A shift's shift-level cells (select, PRO#, Driver --
// the position:sticky pinned ones) are written once in the load's FIRST <tr>
// with rowspan, and its later routes are sibling rows carrying route-level
// cells only. So sliding the pointer left out of route 2's cells and into the
// pinned Driver column crosses into a cell that belongs, in the DOM, to route
// 1 -- and the highlight jumped a row and jumped back on the way out, for a
// move the dispatcher experiences as staying on one load. Hovering a shared
// cell means "this load", not "route 1", so hold whichever route is already
// lit instead of reassigning.
function holdsSharedCell(table, cell, tr) {
  const lit = currentHover.get(table);
  if (!lit || lit === tr) return false;
  if (!cell || (cell.rowSpan || 1) < 2) return false;
  return lit.dataset.parentRow === tr.id;
}

// A board redraw replaces the <tr> under the pointer. The browser sends no
// further mouseover until the pointer MOVES, so the highlight vanished and only
// came back when the dispatcher twitched the mouse -- on a board that redraws
// while they are reading it, that reads as the row blinking. Remember where the
// pointer is so the row can be found again after the table is rebuilt.
let pointerX = -1;
let pointerY = -1;

// Lazily, and only on a table the pointer has actually been over: a
// document-wide observer on this board is a mistake that has been made before
// (see the note about injected wrappers in CLAUDE.md).
const observedTables = new WeakSet();
let reapplyQueued = false;

function reapplyFromPointer() {
  if (pointerX < 0) return;
  const tr = rowFor(document.elementFromPoint(pointerX, pointerY));
  if (!tr) return;
  const table = tr.closest(TABLE_SELECTOR);
  if (!table) return;
  // The row that was lit before the redraw has been thrown away, so comparing
  // against it would make applyHover() think nothing had changed and skip.
  const lit = currentHover.get(table);
  if (lit && !lit.isConnected) currentHover.delete(table);
  applyHover(table, tr);
}

function watchForRedraws(table) {
  if (typeof MutationObserver === 'undefined') return;
  if (observedTables.has(table)) return;
  observedTables.add(table);
  new MutationObserver(() => {
    if (reapplyQueued) return;
    reapplyQueued = true;
    const run = () => {
      reapplyQueued = false;
      reapplyFromPointer();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }).observe(table, { childList: true, subtree: true });
}

function installHoverBehavior() {
  document.addEventListener('mousemove', (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  }, { passive: true });

  document.addEventListener('mouseover', (event) => {
    // Also recorded here, not only from mousemove: a dispatcher who has not
    // moved the mouse since the page drew still needs the row found again
    // after a redraw, and mouseover is the event that put them on it.
    pointerX = event.clientX;
    pointerY = event.clientY;

    const tr = rowFor(event.target);
    if (!tr) return;
    const table = tr.closest(TABLE_SELECTOR);
    if (!table) return;
    if (rowFor(event.relatedTarget) === tr) return;
    if (holdsSharedCell(table, event.target.closest?.('td, th'), tr)) return;
    applyHover(table, tr);
  });

  document.addEventListener('mouseout', (event) => {
    const tr = rowFor(event.target);
    if (!tr) return;
    const table = tr.closest(TABLE_SELECTOR);
    if (!table) return;

    const toTr = rowFor(event.relatedTarget);
    if (toTr && toTr.closest(TABLE_SELECTOR) === table) {
      if (holdsSharedCell(table, event.relatedTarget.closest?.('td, th'), toTr)) return;
      applyHover(table, toTr);
      return;
    }
    clearHover(table);
  });
}

function init() {
  installStyles();
  installHoverBehavior();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
