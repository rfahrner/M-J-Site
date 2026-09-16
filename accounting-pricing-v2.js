/*
 * Accounting pricing v2 presentation.
 *
 * Accounting receives the rate that was applied on the load board, but the
 * dollar fields remain normal editable Accounting fields after they arrive.
 * "Applied" is informational only: Base rate / Driver Rate / Daily Rate.
 * Day Type and the old Revenue Level mechanic are no longer shown.
 */
import { getAccountingRecordById } from './accounting.js';

let scheduled = false;
let applying = false;

function appliedLabel(value) {
  return ({ 1: 'Base rate', 2: 'Driver Rate', 3: 'Daily Rate' })[Number(value)] || 'Base rate';
}

function installStyles() {
  if (document.getElementById('accounting-pricing-v2-styles')) return;
  const style = document.createElement('style');
  style.id = 'accounting-pricing-v2-styles';
  style.textContent = `
    #accounting-table .accounting-applied-label {
      display:block;
      min-width:104px;
      padding:7px 8px;
      text-align:left;
      white-space:nowrap;
    }
    #accounting-table input[data-action="acct-carrier-pay"],
    #accounting-table input[data-action="acct-customer-rate"] {
      cursor:text !important;
      user-select:text;
    }
  `;
  document.head.appendChild(style);
}

function removeHeaderByText(headRow, text) {
  const th = [...headRow.children].find((cell) => cell.textContent.trim() === text);
  if (th) th.remove();
}

function normalizeHeader() {
  const headRow = document.querySelector('#accounting-table-head tr');
  if (!headRow) return;

  const cost = [...headRow.children].find((th) => ['Cost Level', 'Applied'].includes(th.textContent.trim()));
  if (cost) {
    cost.textContent = 'Applied';
    cost.title = 'Rate source that was applied on the load board';
  }

  removeHeaderByText(headRow, 'Revenue Level');
  removeHeaderByText(headRow, 'Day Type');
}

function normalizeRow(row) {
  if (!row?.id?.startsWith('acct-')) return;
  const id = row.id.slice(5);
  const rec = getAccountingRecordById(id);
  if (!rec) return;

  // Old Revenue Level is gone.
  row.querySelector('[data-action="acct-revenue-level"]')?.closest('td')?.remove();

  // Applied is display-only. It reports what arrived from the board and
  // intentionally has no dropdown or change handler.
  const oldAppliedControl = row.querySelector('[data-action="acct-cost-level"], [data-action="acct-applied-rate"]');
  if (oldAppliedControl) {
    const td = oldAppliedControl.closest('td');
    if (td) {
      const label = document.createElement('span');
      label.className = 'accounting-applied-label';
      label.dataset.accountingAppliedLabel = '1';
      label.textContent = appliedLabel(rec.cost_level);
      label.title = 'Informational only — this is what the load board applied';
      td.replaceChildren(label);
    }
  } else {
    const label = row.querySelector('[data-accounting-applied-label]');
    if (label) label.textContent = appliedLabel(rec.cost_level);
  }

  // Day Type is no longer part of Accounting's workflow on any location tab.
  row.querySelector('[data-action="acct-day-type"]')?.closest('td')?.remove();

  // These are ordinary editable Accounting inputs. The board value / customer
  // formula provides the starting figure, but Accounting can click anywhere
  // in the number and type exactly like any other text cell.
  const carrier = row.querySelector('[data-action="acct-carrier-pay"]');
  if (carrier) {
    carrier.readOnly = false;
    carrier.removeAttribute('readonly');
    carrier.classList.remove('accounting-board-rate');
    carrier.title = 'Starts with the load-board rate; editable in Accounting';
  }

  const customer = row.querySelector('[data-action="acct-customer-rate"]');
  if (customer) {
    customer.readOnly = false;
    customer.removeAttribute('readonly');
    customer.classList.remove('accounting-customer-calculated');
    customer.title = 'Starts with the calculated customer rate; editable in Accounting';
  }
}

function normalizeTable() {
  scheduled = false;
  if (applying) return;
  applying = true;
  try {
    normalizeHeader();
    document.querySelectorAll('#accounting-table-body tr[id^="acct-"]').forEach(normalizeRow);

    const headRow = document.querySelector('#accounting-table-head tr');
    const emptyCell = document.querySelector('#accounting-table-body tr:not([id^="acct-"]) > td[colspan]');
    if (headRow && emptyCell) emptyCell.colSpan = headRow.children.length;

    // Keep the page explanation aligned with the simplified workflow.
    const heading = document.querySelector('#driverlist-view h1');
    const subtext = heading?.parentElement?.querySelector('.subtext');
    if (subtext) {
      subtext.textContent = 'Loads arrive automatically from the boards. Applied shows which board rate was used; Customer Rate and Carrier Rate remain editable in Accounting.';
    }
  } finally {
    applying = false;
  }
}

function scheduleNormalize() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(normalizeTable);
}

function initAccountingPricingV2() {
  const table = document.getElementById('accounting-table');
  if (!table) return;
  installStyles();
  new MutationObserver(scheduleNormalize).observe(table, { childList: true, subtree: true });
  document.getElementById('acct-location-tabs')?.addEventListener('click', scheduleNormalize);
  scheduleNormalize();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAccountingPricingV2, { once: true });
} else {
  initAccountingPricingV2();
}
