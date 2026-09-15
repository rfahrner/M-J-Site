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
  `;
  document.head.appendChild(style);
}

function logicalParentId(tr) {
  if (!tr) return '';
  return tr.dataset.parentRow || tr.id || '';
}

function clearHover(table) {
  table.querySelectorAll(`tbody tr.${HOVER_CLASS}, tbody tr.${PARENT_CLASS}`).forEach((tr) => {
    tr.classList.remove(HOVER_CLASS, PARENT_CLASS);
  });
}

function applyHover(table, tr) {
  clearHover(table);
  tr.classList.add(HOVER_CLASS);

  // The rowspanned parent treatment is only needed on standard load boards.
  if (!table.matches('table.board')) return;

  const parentId = logicalParentId(tr);
  if (!parentId || !tr.dataset.parentRow) return;

  const parent = [...table.querySelectorAll('tbody tr')].find((row) => row.id === parentId);
  if (parent) parent.classList.add(PARENT_CLASS);
}

function sameLogicalRow(a, b) {
  if (!a || !b) return false;
  return logicalParentId(a) === logicalParentId(b);
}

function installHoverBehavior() {
  document.addEventListener('mouseover', (event) => {
    const tr = event.target.closest?.(`${TABLE_SELECTOR} tbody tr`);
    if (!tr) return;
    const table = tr.closest(TABLE_SELECTOR);
    if (!table) return;

    const fromTr = event.relatedTarget?.closest?.(`${TABLE_SELECTOR} tbody tr`);
    if (fromTr === tr) return;
    applyHover(table, tr);
  });

  document.addEventListener('mouseout', (event) => {
    const tr = event.target.closest?.(`${TABLE_SELECTOR} tbody tr`);
    if (!tr) return;
    const table = tr.closest(TABLE_SELECTOR);
    if (!table) return;

    const toTr = event.relatedTarget?.closest?.(`${TABLE_SELECTOR} tbody tr`);
    if (toTr && toTr.closest(TABLE_SELECTOR) === table) {
      if (table.matches('table.board') && sameLogicalRow(tr, toTr)) {
        applyHover(table, toTr);
        return;
      }
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
