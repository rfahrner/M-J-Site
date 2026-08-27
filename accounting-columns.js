/* ================================================================
   Accounting column presentation rules

   Keeps display-only Accounting rules out of the already-large board
   module. accounting.js still owns the records, calculations, saves,
   realtime sync, and table rendering. This module normalizes the columns
   after each render:
   - Customer Rate always appears immediately before Carrier Rate.
   - Delaware gets the Customer Rate column too.
   - Atlanta identifies routes by Trip ID; Delaware by Route ID.
   - By Driver totals line up with the Customer/Carrier header order.
   ================================================================ */
import { supabaseClient } from './loadboard.js';
import { getAccountingRecordById } from './accounting.js';

const ACCOUNTING_ROUTES_TABLE = 'loads_accounting_routes';

let scheduled = false;
let applying = false;
let routeFetchInFlight = false;
const atlantaRoutesByAccountingId = new Map();

function activeLocation() {
  return document.querySelector('#acct-location-tabs .location-tab.is-active')?.dataset.location || 'atlanta';
}

function moneyInputCell(action, id, value) {
  const td = document.createElement('td');
  td.innerHTML = `
    <div style="display:flex; align-items:center; gap:2px;">
      <span class="subtext">$</span>
      <input class="cell-input" style="width:78px;" data-action="${action}" data-id="${id}" value="${value == null ? '' : Number(value).toFixed(2)}">
    </div>`;
  return td;
}

function ensureRateColumnOrder() {
  const headRow = document.querySelector('#accounting-table-head tr');
  const body = document.getElementById('accounting-table-body');
  if (!headRow || !body) return;

  let headers = [...headRow.children];
  let carrierHeader = headers.find((th) => th.textContent.trim() === 'Carrier Rate');
  let customerHeader = headers.find((th) => th.textContent.trim() === 'Customer Rate');
  if (!carrierHeader) return;

  if (!customerHeader) {
    customerHeader = document.createElement('th');
    customerHeader.textContent = 'Customer Rate';
  }
  if (customerHeader.nextElementSibling !== carrierHeader) {
    headRow.insertBefore(customerHeader, carrierHeader);
  }

  body.querySelectorAll('tr[id^="acct-"]').forEach((row) => {
    const carrierInput = row.querySelector('[data-action="acct-carrier-pay"]');
    if (!carrierInput) return;
    const carrierCell = carrierInput.closest('td');
    let customerInput = row.querySelector('[data-action="acct-customer-rate"]');
    let customerCell = customerInput?.closest('td') || null;

    if (!customerCell) {
      const accountingId = row.id.slice(5);
      const rec = getAccountingRecordById(accountingId);
      customerCell = moneyInputCell('acct-customer-rate', accountingId, rec?.total_revenue);
    }

    if (customerCell.nextElementSibling !== carrierCell) {
      row.insertBefore(customerCell, carrierCell);
    }
  });

  const emptyCell = body.querySelector('tr:not([id^="acct-"]) > td[colspan]');
  if (emptyCell) emptyCell.colSpan = headRow.children.length;
}

function normalizeRouteHeader() {
  const loc = activeLocation();
  if (loc !== 'atlanta' && loc !== 'delaware') return;
  const headRow = document.querySelector('#accounting-table-head tr');
  if (!headRow) return;
  const routeHeader = [...headRow.children].find((th) => {
    const text = th.textContent.trim();
    return text === 'Routes' || text === 'Trip ID' || text === 'Route ID';
  });
  if (routeHeader) routeHeader.textContent = loc === 'atlanta' ? 'Trip ID' : 'Route ID';
}

async function fetchAtlantaRouteIds() {
  if (activeLocation() !== 'atlanta' || !supabaseClient || routeFetchInFlight) return;
  const rows = [...document.querySelectorAll('#accounting-table-body tr[id^="acct-"]')];
  const missingIds = rows
    .map((row) => Number(row.id.slice(5)))
    .filter((id) => Number.isFinite(id) && !atlantaRoutesByAccountingId.has(id));
  if (!missingIds.length) return;

  routeFetchInFlight = true;
  try {
    for (let i = 0; i < missingIds.length; i += 150) {
      const ids = missingIds.slice(i, i + 150);
      const { data, error } = await supabaseClient
        .from(ACCOUNTING_ROUTES_TABLE)
        .select('accounting_id,route_number,route_id,trip_id')
        .in('accounting_id', ids);
      if (error) throw error;

      const grouped = new Map(ids.map((id) => [id, []]));
      (data || []).forEach((route) => {
        if (!grouped.has(Number(route.accounting_id))) grouped.set(Number(route.accounting_id), []);
        grouped.get(Number(route.accounting_id)).push(route);
      });
      grouped.forEach((routes, id) => {
        routes.sort((a, b) => Number(a.route_number || 0) - Number(b.route_number || 0));
        atlantaRoutesByAccountingId.set(id, routes);
      });
    }
  } catch (error) {
    console.error('Failed to load Atlanta Trip IDs for Accounting:', error);
  } finally {
    routeFetchInFlight = false;
  }
}

function applyAtlantaTripIds() {
  if (activeLocation() !== 'atlanta') return;
  document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach((row) => {
    const accountingId = Number(row.id.slice(5));
    const routes = atlantaRoutesByAccountingId.get(accountingId);
    if (!routes) return;

    const buttons = [...row.querySelectorAll('[data-open-acct-route-text]')];
    buttons.forEach((button, index) => {
      const routeId = String(button.dataset.openAcctRouteText || '').trim();
      const route = routes.find((candidate) => String(candidate.route_id || '').trim() === routeId) || routes[index];
      const tripId = String(route?.trip_id || '').trim();
      button.textContent = tripId || '—';
      button.title = tripId ? 'Open this trip\'s details' : 'Trip ID was not recorded for this older route';
      button.disabled = !tripId;
    });
  });
}

function fixByDriverColumnOrder() {
  const body = document.getElementById('accounting-driver-table-body');
  if (!body) return;
  body.querySelectorAll('tr').forEach((row) => {
    if (row.dataset.rateColumnsFixed === 'true' || row.cells.length < 7) return;
    // accounting.js renders carrier pay in cell 5 and revenue in cell 6,
    // while the existing headers are Customer Rate then Carrier Rate.
    // Move revenue ahead of carrier pay so the values match the headers.
    row.insertBefore(row.cells[5], row.cells[4]);
    row.dataset.rateColumnsFixed = 'true';
  });
}

async function applyAccountingPresentation() {
  scheduled = false;
  if (applying) return;
  applying = true;
  try {
    ensureRateColumnOrder();
    normalizeRouteHeader();
    fixByDriverColumnOrder();
    if (activeLocation() === 'atlanta') {
      await fetchAtlantaRouteIds();
      applyAtlantaTripIds();
    }
  } finally {
    applying = false;
  }
}

function scheduleApply() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => { applyAccountingPresentation(); });
}

function initAccountingColumns() {
  const table = document.getElementById('accounting-table');
  const driverTable = document.getElementById('accounting-driver-table');
  if (!table) return;

  const observer = new MutationObserver(scheduleApply);
  observer.observe(table, { childList: true, subtree: true });
  if (driverTable) observer.observe(driverTable, { childList: true, subtree: true });

  document.getElementById('acct-location-tabs')?.addEventListener('click', scheduleApply);
  scheduleApply();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountingColumns, { once: true });
} else {
  initAccountingColumns();
}
