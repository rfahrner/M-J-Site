// Mondelez completed-row presentation.
//
// Mondelez rows represent the whole scheduled shift/load record. Completing a
// shift should not collapse that entire row into one giant pill. The load
// itself may be shown as a compact completed pill, while the rest of the row
// remains visible/editable (driver, start, DG, trailer, miles, stops, pay,
// notes, image, etc.), matching the way the other boards distinguish a shift
// from the loads run during it.

import { state, findDriver, escapeHtml, pick } from './loadboard.js';
import { mondelezState } from './mondelez.js';

const EMAIL_LOCATIONS = new Set(['morris', 'addison', 'indianapolis', 'westchester']);

function locationLabel(key) {
  const labels = {
    westchester: 'West Chester',
    morris: 'Morris',
    addison: 'Addison',
    indianapolis: 'Indianapolis',
    louisville: 'Louisville',
    spokane: 'Spokane',
    lasvegas: 'Las Vegas',
    boise: 'Boise',
    kent: 'Kent',
    saltlakecity: 'Salt Lake City',
    newberlin: 'New Berlin',
  };
  return labels[key] || key || '';
}

function rowForId(rowId) {
  const rows = mondelezState.rowsByDate[state.activeDate] || [];
  return rows.find((row) => row.id === rowId) || null;
}

function completedRowCells(row) {
  const drv = row.driverId ? findDriver(row.driverId) : null;
  const displayName = drv ? drv.name : row.driverName;
  const showLocationCol = mondelezState.activeTab === 'combined';

  return `
    <td class="pin pin-select"><input type="checkbox" class="chk" data-action="toggle-mdz-select" data-mdz-row="${row.id}" ${row.selected ? 'checked' : ''} title="Select"></td>
    <td class="pin pin-text">
      <button class="text-btn" data-action="text-mdz-driver" data-mdz-row="${row.id}" title="Text this driver">Text</button>
      ${EMAIL_LOCATIONS.has(row.location) ? `<button class="text-btn" data-action="email-mdz-driver" data-mdz-row="${row.id}" title="Email route info">Email</button>` : ''}
    </td>
    ${showLocationCol ? `<td class="col-mdz-location"><span class="static-text">${escapeHtml(locationLabel(row.location))}</span></td>` : ''}
    <td class="pin pin-pro shift-complete-tint">
      <button type="button" class="trip-chip trip-segment-done" data-open-mdz-load="${row.id}" title="Completed load — click to view or edit">${escapeHtml(row.aljexNumber || '(no Aljex#)')}</button>
    </td>
    <td class="pin pin-driver">
      <div class="driver-name-wrap"><input class="cell-input" data-driver-ac="true" placeholder="Type driver name…" data-mdz-row="${row.id}" data-mdz-field="driverName" value="${escapeHtml(displayName || '')}"></div>
    </td>
    <td class="col-cell"><span class="static-text">${escapeHtml(pick(drv && drv.phone, ''))}</span></td>
    <td class="col-shiftStart"><input class="cell-input small" style="width:52px;" placeholder="--:--" data-mdz-row="${row.id}" data-mdz-field="startTime" value="${escapeHtml(row.startTime)}"></td>
    <td class="col-mdz-group"><input class="cell-input small" style="width:88px;" placeholder="DG#" data-mdz-row="${row.id}" data-mdz-field="deliveryGroup" value="${escapeHtml(row.deliveryGroup)}"></td>
    <td class="col-mdz-driverapp"><input class="cell-input small" data-mdz-row="${row.id}" data-mdz-field="driverAppId" inputmode="numeric" maxlength="9" placeholder="9-digit ID" value="${escapeHtml(row.driverAppId)}"></td>
    <td class="col-mdz-trailer"><input class="cell-input small" data-mdz-row="${row.id}" data-mdz-field="trailerNumber" value="${escapeHtml(row.trailerNumber)}"></td>
    <td class="col-mdz-trailer"><input class="cell-input small" placeholder="Return #" data-mdz-row="${row.id}" data-mdz-field="returnTrailerNumber" value="${escapeHtml(row.returnTrailerNumber)}"></td>
    <td class="col-mdz-miles"><input class="cell-input small" style="width:52px;" inputmode="decimal" data-mdz-row="${row.id}" data-mdz-field="miles" value="${escapeHtml(row.miles)}"></td>
    <td class="col-mdz-stops"><input class="cell-input small" style="width:40px;" inputmode="numeric" data-mdz-row="${row.id}" data-mdz-field="stopCount" value="${escapeHtml(row.stopCount)}"></td>
    <td class="col-mdz-fsc"><input class="cell-input small" style="width:52px;" placeholder="FSC" data-mdz-row="${row.id}" data-mdz-field="fsc" value="${escapeHtml(row.fsc)}"></td>
    <td class="col-mdz-revenue"><input class="cell-input small" style="width:70px; font-weight:800;" data-mdz-row="${row.id}" data-mdz-field="revenueTotal" value="${escapeHtml(row.revenueTotal)}" title="${row.revenueManual ? 'Manually overridden' : 'Auto-calculated'}"></td>
    <td class="col-mdz-carrierpay"><input class="cell-input small" style="width:64px;" placeholder="Carrier Pay" data-mdz-row="${row.id}" data-mdz-field="carrierPay" value="${escapeHtml(row.carrierPay)}"></td>
    <td class="col-mdz-notes"><input class="cell-input" placeholder="Status / Notes" data-mdz-row="${row.id}" data-mdz-field="notes" value="${escapeHtml(row.notes)}"></td>
    <td class="col-mdz-image">
      <div class="mdz-image-dropzone" tabindex="0" data-action="image-dropzone" data-mdz-row="${row.id}" title="Click to browse, or drag/paste an image here">
        ${row.routeImageUrl
          ? `<div class="mdz-thumb-wrap">
               <img src="${escapeHtml(row.routeImageUrl)}" class="mdz-route-thumb" data-action="view-route-image" data-mdz-row="${row.id}" alt="Route image" title="Click to view full size">
               <button type="button" class="mdz-thumb-delete" data-action="delete-route-image" data-mdz-row="${row.id}" title="Delete image">&times;</button>
             </div>`
          : `<span class="mdz-upload-hint">Drop / paste / click</span>`}
        <input type="file" accept="image/*" data-action="upload-route-image" data-mdz-row="${row.id}" class="mdz-hidden-file-input">
      </div>
    </td>
    <td class="col-availRemove"><button type="button" class="available-remove-btn" data-action="delete-mdz-row" data-mdz-row="${row.id}" title="Delete">&times;</button></td>
  `;
}

function expandCompletedRows() {
  const table = document.getElementById('mondelez-table');
  if (!table) return;

  table.querySelectorAll('tbody tr[id]').forEach((tr) => {
    const row = rowForId(tr.id);
    if (!row || !row.shiftComplete) return;

    // The legacy completed renderer has one big colspan cell containing a
    // single load pill. Only replace that collapsed form; a row we already
    // expanded is left alone so the observer does not churn the DOM.
    const collapsedCell = tr.querySelector('td[colspan]');
    if (!collapsedCell) return;

    tr.innerHTML = completedRowCells(row);
    tr.dataset.completedRowExpanded = '1';
  });
}

function init() {
  if ((location.pathname.split('/').pop() || '') !== 'mondelez.html') return;
  const table = document.getElementById('mondelez-table');
  if (!table) return;

  expandCompletedRows();
  const observer = new MutationObserver(() => expandCompletedRows());
  observer.observe(table, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
