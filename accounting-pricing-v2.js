/*
 * Accounting pricing v2 presentation.
 *
 * Carrier Rate is owned by the load board and arrives in Accounting already
 * applied. The old Cost Level / Revenue Level controls no longer participate
 * in pricing. Atlanta keeps one small descriptive selector instead:
 *   Base rate / Driver Rate / Daily Rate.
 *
 * The database now owns Atlanta Customer Rate calculation, so the UI treats
 * both Carrier Rate and Atlanta Customer Rate as calculated/read-only values.
 */
import { supabaseClient } from './loadboard.js';
import { getAccountingRecordById } from './accounting.js';

const ACCOUNTING_TABLE = 'loads_accounting';
let scheduled = false;
let applying = false;

function activeLocation() {
  return document.querySelector('#acct-location-tabs .location-tab.is-active')?.dataset.location || 'atlanta';
}

function appliedOptions(selected) {
  const value = [1, 2, 3].includes(Number(selected)) ? Number(selected) : 1;
  return [
    [1, 'Base rate'],
    [2, 'Driver Rate'],
    [3, 'Daily Rate'],
  ].map(([id, label]) => `<option value="${id}"${value === id ? ' selected' : ''}>${label}</option>`).join('');
}

function installStyles() {
  if (document.getElementById('accounting-pricing-v2-styles')) return;
  const style = document.createElement('style');
  style.id = 'accounting-pricing-v2-styles';
  style.textContent = `
    #accounting-table input.accounting-board-rate,
    #accounting-table input.accounting-customer-calculated {
      background: var(--slate-100, #eef1f6) !important;
      cursor: default;
    }
    #accounting-table select[data-action="acct-applied-rate"] {
      min-width: 104px;
    }
  `;
  document.head.appendChild(style);
}

function normalizeHeader() {
  const headRow = document.querySelector('#accounting-table-head tr');
  if (!headRow) return;

  const headers = [...headRow.children];
  const cost = headers.find((th) => ['Cost Level', 'Applied'].includes(th.textContent.trim()));
  if (cost) {
    cost.textContent = 'Applied';
    cost.title = 'Which load-board rate source was applied';
  }

  const revenue = [...headRow.children].find((th) => th.textContent.trim() === 'Revenue Level');
  if (revenue) revenue.remove();
}

function normalizeRow(row) {
  if (!row?.id?.startsWith('acct-')) return;
  const id = row.id.slice(5);
  const rec = getAccountingRecordById(id);
  if (!rec) return;

  // Remove the old Revenue Level control entirely. Day Type now chooses
  // Core vs Holiday customer pricing in the database.
  const revenueSelect = row.querySelector('[data-action="acct-revenue-level"]');
  if (revenueSelect) revenueSelect.closest('td')?.remove();

  // Re-purpose the visual Cost Level cell only as the descriptive Applied
  // source. Changing this never recalculates a dollar amount.
  const applied = row.querySelector('[data-action="acct-cost-level"], [data-action="acct-applied-rate"]');
  if (applied) {
    applied.dataset.action = 'acct-applied-rate';
    const selected = Number(rec.cost_level);
    const expected = String([1, 2, 3].includes(selected) ? selected : 1);
    if (applied.dataset.appliedOptions !== 'v2') {
      applied.innerHTML = appliedOptions(expected);
      applied.dataset.appliedOptions = 'v2';
    }
    if (applied.value !== expected) applied.value = expected;
    applied.title = 'Label only — the dollar rate comes directly from the load board';
  }

  // A linked board record is the source of truth for carrier pay. Accounting
  // can see the applied dollar figure but cannot accidentally replace it with
  // a second calculation.
  const carrier = row.querySelector('[data-action="acct-carrier-pay"]');
  if (carrier && (rec.source_shift_id || rec.source_houston_id)) {
    carrier.readOnly = true;
    carrier.classList.add('accounting-board-rate');
    carrier.title = 'Applied on the load board';
  }

  // Atlanta customer revenue is fully calculated from the supplied Kroger
  // mileage tier + $50/stop + FSC*.133*miles formula.
  const customer = row.querySelector('[data-action="acct-customer-rate"]');
  if (customer && rec.location === 'atlanta') {
    customer.readOnly = true;
    customer.classList.add('accounting-customer-calculated');
    customer.title = 'Mileage tier + $50 per stop + FSC × .133 × miles';
  }
}

function normalizeTable() {
  scheduled = false;
  if (applying) return;
  applying = true;
  try {
    if (activeLocation() === 'atlanta') normalizeHeader();
    document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach(normalizeRow);
  } finally {
    applying = false;
  }
}

function scheduleNormalize() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(normalizeTable);
}

async function saveAppliedSource(select) {
  const id = Number(select.dataset.id);
  const value = Number(select.value);
  if (!id || ![1, 2, 3].includes(value) || !supabaseClient) return;
  const rec = getAccountingRecordById(id);
  const previous = rec?.cost_level;
  if (rec) {
    rec.cost_level = value;
    rec.revenue_level = 99;
  }
  const { error } = await supabaseClient
    .from(ACCOUNTING_TABLE)
    .update({ cost_level: value, revenue_level: 99 })
    .eq('id', id);
  if (error) {
    console.error('Could not save Applied rate source:', error);
    if (rec) rec.cost_level = previous;
    select.value = String([1, 2, 3].includes(Number(previous)) ? Number(previous) : 1);
  }
}

async function refreshCalculatedRow(id) {
  if (!supabaseClient || !id) return;
  const { data, error } = await supabaseClient
    .from(ACCOUNTING_TABLE)
    .select('id,total_revenue,total_carrier_pay,total_cost,fsc_payment,day_type,cost_level,revenue_level')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return;

  const rec = getAccountingRecordById(id);
  if (rec) Object.assign(rec, data);
  const row = document.getElementById(`acct-${id}`);
  if (!row) return;
  const customer = row.querySelector('[data-action="acct-customer-rate"]');
  const carrier = row.querySelector('[data-action="acct-carrier-pay"]');
  if (customer) customer.value = data.total_revenue == null ? '' : Number(data.total_revenue).toFixed(2);
  if (carrier) carrier.value = data.total_carrier_pay == null ? '' : Number(data.total_carrier_pay).toFixed(2);
}

function initAccountingPricingV2() {
  const table = document.getElementById('accounting-table');
  if (!table) return;
  installStyles();

  // Capture changes before accounting.js's delegated listener. The Applied
  // control has a new action name anyway, so the old Cost Level recalc path
  // cannot fire.
  table.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target.dataset.action === 'acct-applied-rate') {
      void saveAppliedSource(target);
      return;
    }

    if (target.dataset.action === 'acct-day-type' && activeLocation() === 'atlanta') {
      // accounting.js saves day_type; the DB trigger recalculates Customer
      // Rate in the same write. Re-read shortly after so the figure updates
      // immediately even if realtime delivery is a beat behind.
      const id = Number(target.dataset.id);
      setTimeout(() => void refreshCalculatedRow(id), 250);
    }
  }, true);

  new MutationObserver(scheduleNormalize).observe(table, { childList: true, subtree: true });
  document.getElementById('acct-location-tabs')?.addEventListener('click', scheduleNormalize);
  scheduleNormalize();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountingPricingV2, { once: true });
} else {
  initAccountingPricingV2();
}
