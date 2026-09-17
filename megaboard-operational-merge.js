// Merge the rolling overnight / early-AM coverage rows into the normal day table
// when that location already has a table for the same operational day. This keeps
// current and handoff work together instead of showing two separate blocks.

let observer = null;
let scheduled = false;

function norm(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function prettyLongDate(key) {
  const [y, m, d] = String(key || '').split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return '';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function headerLabels(table) {
  return [...table.querySelectorAll('thead th')].map((th) => String(th.textContent || '').trim());
}

function rowMap(table, row) {
  const labels = headerLabels(table);
  const map = new Map();
  [...row.children].forEach((cell, index) => {
    const label = labels[index];
    if (label) map.set(norm(label), cell);
  });
  return map;
}

function aliasesFor(baseLabel) {
  const label = norm(baseLabel);
  const aliases = {
    'return eta to dc': ['return eta to dc', 'return eta'],
    'dg#': ['dg#', 'dg# / route'],
    'status / notes': ['status / notes', 'notes', 'comments'],
    'route image': ['route image', 'image'],
    'image': ['image', 'route image'],
    'phone': ['phone', 'cell'],
    'cell': ['cell', 'phone'],
    'time': ['time', 'shift start', 'start'],
    'shift start': ['shift start', 'start', 'time'],
    'start': ['start', 'shift start', 'time'],
  };
  return aliases[label] || [label];
}

function sourceCellFor(baseLabel, sourceCells) {
  for (const alias of aliasesFor(baseLabel)) {
    if (sourceCells.has(alias)) return sourceCells.get(alias);
  }
  return null;
}

function makeWindowBadge(windowText) {
  const text = String(windowText || '').trim();
  if (!text) return '';
  const cls = /overnight/i.test(text) ? 'carryover' : 'early';
  return `<span class="mega-operational-badge ${cls}">${text}</span>`;
}

function transformRow(sourceTable, sourceRow, baseTable, sourceKey) {
  const sourceCells = rowMap(sourceTable, sourceRow);
  const baseLabels = headerLabels(baseTable);
  const windowText = sourceCells.get('window')?.textContent?.trim() || '';
  const tr = document.createElement('tr');
  tr.className = `mega-operational-merged ${/overnight/i.test(windowText) ? 'carryover' : 'early'}`;
  tr.dataset.megaOperationalSource = sourceKey;

  baseLabels.forEach((baseLabel) => {
    const td = document.createElement('td');
    const source = sourceCellFor(baseLabel, sourceCells);

    if (source) {
      td.className = source.className || '';
      td.innerHTML = source.innerHTML;
    } else {
      td.textContent = '—';
    }

    if (norm(baseLabel) === 'status') {
      const badge = makeWindowBadge(windowText);
      td.innerHTML = `${badge}${badge && td.innerHTML ? ' ' : ''}${td.innerHTML}`;
    }

    tr.appendChild(td);
  });

  return tr;
}

function findBaseDayBlock(section, dateKey) {
  const wanted = prettyLongDate(dateKey);
  return [...section.querySelectorAll(':scope > .mega-location-body > .mega-day-block:not(.mega-operational-extra)')]
    .find((block) => String(block.querySelector('.mega-day-head span:first-child')?.textContent || '').trim() === wanted) || null;
}

function sourceKeyFor(block, section) {
  return `${section.dataset.megaLocation || ''}|${block.dataset.megaOperationalDate || ''}`;
}

function updateCounts(section, baseBlock, extraCount) {
  const dayCount = baseBlock.querySelector('.mega-day-count');
  if (dayCount) {
    if (!baseBlock.dataset.megaBaseLoadCount) {
      baseBlock.dataset.megaBaseLoadCount = String(parseInt(dayCount.textContent, 10) || 0);
    }
    const total = Number(baseBlock.dataset.megaBaseLoadCount || 0) + extraCount;
    dayCount.textContent = `${total} load${total === 1 ? '' : 's'}`;
  }

  const locationCount = section.querySelector(':scope > .mega-location-head .mega-count-badge');
  if (locationCount && /load/i.test(locationCount.textContent || '')) {
    if (!section.dataset.megaBaseLoadCount) {
      section.dataset.megaBaseLoadCount = String(parseInt(locationCount.textContent, 10) || 0);
    }
    const activeMerged = section.querySelectorAll('.mega-operational-merged').length;
    const total = Number(section.dataset.megaBaseLoadCount || 0) + activeMerged;
    locationCount.textContent = `${total} load${total === 1 ? '' : 's'}`;
  }
}

function mergeBlock(block) {
  const section = block.closest('.mega-location');
  const dateKey = block.dataset.megaOperationalDate;
  if (!section || !dateKey) return false;

  const baseBlock = findBaseDayBlock(section, dateKey);
  if (!baseBlock) {
    block.classList.remove('mega-operational-source-hidden');
    return false;
  }

  const sourceTable = block.querySelector('.mega-operational-table');
  const baseTable = baseBlock.querySelector('.mega-table');
  const baseBody = baseTable?.querySelector('tbody');
  if (!sourceTable || !baseTable || !baseBody) return false;

  const key = sourceKeyFor(block, section);
  baseBody.querySelectorAll(`.mega-operational-merged[data-mega-operational-source="${CSS.escape(key)}"]`).forEach((row) => row.remove());

  const sourceRows = [...sourceTable.querySelectorAll('tbody tr')];
  sourceRows.forEach((row) => baseBody.appendChild(transformRow(sourceTable, row, baseTable, key)));
  block.classList.add('mega-operational-source-hidden');
  updateCounts(section, baseBlock, sourceRows.length);
  return true;
}

function cleanStaleMergedRows(validKeys) {
  document.querySelectorAll('.mega-operational-merged').forEach((row) => {
    if (!validKeys.has(row.dataset.megaOperationalSource || '')) row.remove();
  });
}

function apply() {
  const blocks = [...document.querySelectorAll('#mega-locations .mega-operational-extra')];
  const validKeys = new Set();

  blocks.forEach((block) => {
    const section = block.closest('.mega-location');
    if (section) validKeys.add(sourceKeyFor(block, section));
  });

  cleanStaleMergedRows(validKeys);
  blocks.forEach(mergeBlock);
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    apply();
  });
}

function installStyles() {
  if (document.getElementById('megaboard-operational-merge-style')) return;
  const style = document.createElement('style');
  style.id = 'megaboard-operational-merge-style';
  style.textContent = `
    .mega-operational-source-hidden { display:none !important; }
    .mega-operational-merged.early td { background:#fffdf4; }
    .mega-operational-merged.carryover td { background:#f7fbff; }
    .mega-operational-merged .mega-operational-badge { margin-right:4px; }
  `;
  document.head.appendChild(style);
}

function init() {
  installStyles();
  const root = document.getElementById('mega-locations');
  if (!root) return;
  apply();
  observer = new MutationObserver(scheduleApply);
  observer.observe(root, { childList: true, subtree: true });
}

window.addEventListener('beforeunload', () => observer?.disconnect());

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
