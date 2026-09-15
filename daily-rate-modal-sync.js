/* Keeps the visible board Rate value and persisted shift rate aligned with the
   new date/driver hierarchy after the legacy Load Details renderer runs.
   Manual Rate values are never touched. */

let lb = null;
let rates = null;
let saveTimer = null;

function findRow(localId) {
  if (!lb?.state?.sheets || !localId) return null;
  for (const sheet of Object.values(lb.state.sheets)) {
    const row = (sheet || []).find((item) => String(item.id) === String(localId));
    if (row) return row;
  }
  return null;
}

async function syncOpenLoadRate() {
  if (!lb || !rates || !lb.loadDetailsState) return;
  const row = findRow(lb.loadDetailsState.rowId);
  if (!row || row.rateManual || !row.dbId) return;
  const locationKey = row.location || lb.state.activeLocation;
  if (!locationKey || locationKey === 'houston') return;

  const breakdown = rates.calcLoadRateBreakdown(locationKey, row);
  const numeric = Number(breakdown.total) || 0;
  const next = numeric ? String(Math.round(numeric * 100) / 100) : '';
  if (row.rate === next) return;

  row.rate = next;
  const boardInput = document.querySelector(`input[data-row="${CSS.escape(String(row.id))}"][data-field="rate"]`);
  if (boardInput && document.activeElement !== boardInput) boardInput.value = next;
  const modalInput = document.getElementById('ld-rate-total');
  if (modalInput && document.activeElement !== modalInput) modalInput.value = next;

  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!lb?.supabaseClient || row.rateManual) return;
    const { error } = await lb.supabaseClient.from('loads_shifts')
      .update({ rate: numeric || null, rate_manual: false })
      .eq('id', row.dbId);
    if (error) console.error('Could not persist hierarchy-correct rate from Load Details', error);
  }, 150);
}

async function init() {
  lb = await import('./loadboard.js');
  rates = await import('./boardrates.js');
  const body = document.getElementById('ld-tab-content');
  if (!body) return;
  new MutationObserver(() => setTimeout(() => void syncOpenLoadRate(), 30))
    .observe(body, { childList: true, subtree: true });
  document.addEventListener('change', (event) => {
    if (event.target.closest?.('#ld-tab-content')) setTimeout(() => void syncOpenLoadRate(), 60);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
else setTimeout(() => void init(), 0);
