// Board row hover + route-time visual accents.
//
// Standard load-board rows with multiple maximized routes are rendered as
// multiple <tr>s. Shift/driver cells live in the first row with rowspan,
// while later route rows only contain route-level cells. Native :hover on
// the later row therefore cannot reach the driver cells. This module keeps
// the hovered route row and its shared shift cells visually tied together.

function installStyles() {
  if (document.getElementById('board-row-hover-enhancement-styles')) return;

  const style = document.createElement('style');
  style.id = 'board-row-hover-enhancement-styles';
  style.textContent = `
    /* Give the three route timing columns a distinct surface from the
       surrounding pistachio route block. Scoped to standard board tables. */
    table.board th.col-dispatchTime,
    table.board td.col-dispatchTime,
    table.board th.col-lastStopDepart,
    table.board td.col-lastStopDepart,
    table.board th.col-returnEtaToDc,
    table.board td.col-returnEtaToDc {
      background: #c9ddf2 !important;
    }

    /* The route row under the pointer always wins over status/column colors,
       including green completion/documentation cells. */
    table.board tbody tr.board-hover-current > td {
      background: #d7e8ff !important;
    }

    /* When hovering route 2+, the shift/driver cells are rowspanned from the
       first DOM row. Highlight only those pinned shift cells on the parent;
       do not light up route 1's route-level cells. */
    table.board tbody tr.board-hover-parent > td.pin {
      background: #d7e8ff !important;
    }
  `;
  document.head.appendChild(style);
}

function parentRowId(tr) {
  if (!tr) return '';
  return tr.dataset.parentRow || tr.id || '';
}

function clearHover(table) {
  table.querySelectorAll('tbody tr.board-hover-current, tbody tr.board-hover-parent').forEach((tr) => {
    tr.classList.remove('board-hover-current', 'board-hover-parent');
  });
}

function applyHover(table, tr) {
  clearHover(table);
  tr.classList.add('board-hover-current');

  const parentId = parentRowId(tr);
  if (!parentId || !tr.dataset.parentRow) return;

  const parent = [...table.querySelectorAll('tbody tr')].find((row) => row.id === parentId);
  if (parent) parent.classList.add('board-hover-parent');
}

function sameLogicalRow(a, b) {
  if (!a || !b) return false;
  return parentRowId(a) === parentRowId(b);
}

function installHoverBehavior() {
  document.addEventListener('mouseover', (event) => {
    const tr = event.target.closest?.('table.board tbody tr');
    if (!tr) return;
    const table = tr.closest('table.board');
    if (!table) return;

    const fromTr = event.relatedTarget?.closest?.('table.board tbody tr');
    if (fromTr === tr) return;
    applyHover(table, tr);
  });

  document.addEventListener('mouseout', (event) => {
    const tr = event.target.closest?.('table.board tbody tr');
    if (!tr) return;
    const table = tr.closest('table.board');
    if (!table) return;

    const toTr = event.relatedTarget?.closest?.('table.board tbody tr');
    if (toTr && sameLogicalRow(tr, toTr)) {
      applyHover(table, toTr);
      return;
    }
    if (toTr && toTr.closest('table.board') === table) {
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
