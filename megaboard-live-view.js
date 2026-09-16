// Megaboard is intended to be a live operational view, not a route-history view.
// Keep one row per load on the standard boards: the newest still-open route,
// falling back to the most recent route when every route is complete. Also hide
// Rate / Rating columns from the Megaboard presentation without changing any
// native board or underlying data.

function normalizedCellText(cell) {
  return String(cell?.textContent || '').trim();
}

function headerIndex(table, label) {
  const headers = [...table.querySelectorAll('thead th')];
  return headers.findIndex((th) => normalizedCellText(th).toLowerCase() === label.toLowerCase());
}

function hideColumnByLabel(table, label) {
  const index = headerIndex(table, label);
  if (index < 0) return;
  const rows = table.querySelectorAll('tr');
  rows.forEach((row) => {
    const cell = row.children[index];
    if (cell) cell.style.display = 'none';
  });
}

function loadKeyForRow(row, indexes) {
  const cells = row.children;
  const pro = normalizedCellText(cells[indexes.pro]);
  if (pro && pro !== '—') return `pro:${pro}`;

  // PROs can still be blank on a live load. Use stable shift-level fields as a
  // fallback so consecutive route rows from the same load still collapse.
  const driver = normalizedCellText(cells[indexes.driver]);
  const shiftStart = normalizedCellText(cells[indexes.shiftStart]);
  const notes = indexes.notes >= 0 ? normalizedCellText(cells[indexes.notes]) : '';
  return `shift:${driver}|${shiftStart}|${notes}`;
}

function keepCurrentRouteOnly(table) {
  const indexes = {
    pro: headerIndex(table, 'PRO#'),
    driver: headerIndex(table, 'Driver'),
    shiftStart: headerIndex(table, 'Shift Start'),
    notes: headerIndex(table, 'Notes'),
    status: headerIndex(table, 'Status'),
  };
  if (indexes.pro < 0 || indexes.driver < 0 || indexes.shiftStart < 0 || indexes.status < 0) return;

  const rows = [...table.querySelectorAll('tbody tr')];
  const groups = new Map();
  rows.forEach((row) => {
    // Reset in case the table survived a partial DOM update.
    row.style.display = '';
    const key = loadKeyForRow(row, indexes);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });

  groups.forEach((groupRows) => {
    if (groupRows.length <= 1) return;

    // Rows are emitted in trip_number order. If more than one route is still
    // technically open, the last one is the live/current route. If all are
    // closed, keep the last route so completed loads still show useful context.
    const openRows = groupRows.filter((row) => {
      const status = normalizedCellText(row.children[indexes.status]).toLowerCase();
      return status === 'open';
    });
    const keep = openRows.length ? openRows[openRows.length - 1] : groupRows[groupRows.length - 1];
    groupRows.forEach((row) => {
      if (row !== keep) row.style.display = 'none';
    });
  });
}

function applyLiveView() {
  document.querySelectorAll('#mega-locations .mega-table').forEach((table) => {
    hideColumnByLabel(table, 'Rate');
    hideColumnByLabel(table, 'Rating');
  });

  document.querySelectorAll('#mega-locations .mega-standard-table').forEach(keepCurrentRouteOnly);
}

let scheduled = false;
function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    applyLiveView();
  });
}

function init() {
  const locations = document.getElementById('mega-locations');
  if (!locations) return;
  applyLiveView();
  const observer = new MutationObserver(scheduleApply);
  observer.observe(locations, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
