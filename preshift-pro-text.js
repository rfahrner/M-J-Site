import { supabaseClient, openSendTextModal } from './loadboard.js';

const CARRIER_DOCS_URL = 'https://rfahrner.github.io/M-J-Site/driver/';
const BOARD_FILE_TO_LOCATION = {
  '': 'atlanta',
  'index.html': 'atlanta',
  'dalaware.html': 'delaware',
  'buildingc.html': 'buildingc',
  'houston.html': 'houston',
};

let pendingTrackedMarker = null;
let refreshTimer = null;
let suppressObserverUntil = 0;

function currentFile() { return location.pathname.split('/').pop() || ''; }
function currentLocation() { return BOARD_FILE_TO_LOCATION[currentFile()] || null; }
function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function clean(value) { return String(value ?? '').trim(); }
function parseHHMM(value) {
  const m = clean(value).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}
function clockLabel(value) {
  const mins = parseHHMM(value);
  if (mins == null) return clean(value) || 'scheduled time';
  const h24 = Math.floor(mins / 60);
  const minute = String(mins % 60).padStart(2, '0');
  return `${h24 % 12 || 12}:${minute} ${h24 >= 12 ? 'PM' : 'AM'}`;
}
function nowMinutes(timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour:'numeric', minute:'numeric', hour12:false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  return h * 60 + m;
}
function todayKey(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

async function driverMap(ids) {
  const unique = [...new Set(ids.filter((id) => id != null).map(String))];
  const map = new Map();
  if (!unique.length || !supabaseClient) return map;
  const { data, error } = await supabaseClient.from('atlanta_drivers').select('id,"Driver Name","Driver Cell"').in('id', unique);
  if (!error) {
    for (const row of data || []) map.set(String(row.id), { name: clean(row['Driver Name']), phone: clean(row['Driver Cell']) });
  }
  return map;
}

function preShiftMessage(shiftStart) {
  return `This is D&L, we have you scheduled for ${clockLabel(shiftStart)}. Please reply with your ETA.`;
}
function carrierDocsMessage(pro) {
  return `Please submit signed images of your paperwork to the Carrier Docs app: ${CARRIER_DOCS_URL} upon completion of your route, using PRO#${pro}`;
}

function installTrackedModalWatcher() {
  const modal = document.getElementById('modal-send-text');
  if (!modal || modal.dataset.dispatchTracked === '1') return;
  modal.dataset.dispatchTracked = '1';

  document.addEventListener('click', (event) => {
    if (event.target.closest('#send-text-cancel,#send-text-close')) pendingTrackedMarker = null;
  }, true);

  new MutationObserver(() => {
    if (!modal.classList.contains('hidden') || !pendingTrackedMarker) return;
    const marker = pendingTrackedMarker;
    pendingTrackedMarker = null;
    Promise.resolve(marker()).then(() => scheduleRefresh(100)).catch((error) => console.error('Could not mark dispatch text sent', error));
  }).observe(modal, { attributes:true, attributeFilter:['class'] });
}

function openTrackedText(recipients, message, marker) {
  installTrackedModalWatcher();
  pendingTrackedMarker = marker;
  openSendTextModal(recipients, message, null);
  const modal = document.getElementById('modal-send-text');
  if (!modal || modal.classList.contains('hidden')) pendingTrackedMarker = null;
}

async function handleBasePreShiftClick(button) {
  const loc = currentLocation();
  if (!['atlanta','delaware','buildingc'].includes(loc)) return false;
  const item = button.closest('.alert-chat-item');
  const ids = clean(item?.dataset.alertJumpIds).split(',').map(Number).filter(Number.isFinite);
  if (!ids.length) return false;
  const { data: rows, error } = await supabaseClient
    .from('loads_shifts')
    .select('id,shift_start,driver_id,driver_name_text,driver_cell_snapshot,pre_shift_text_sent,pre_shift_text_sent_at')
    .in('id', ids);
  if (error || !rows?.length) return true;
  const unsent = rows.filter((row) => !row.pre_shift_text_sent_at && !['true','yes','1'].includes(clean(row.pre_shift_text_sent).toLowerCase()));
  if (!unsent.length) { item?.remove(); return true; }
  const drivers = await driverMap(unsent.map((row) => row.driver_id));
  const recipients = unsent.map((row) => {
    const drv = drivers.get(String(row.driver_id)) || {};
    return { name: drv.name || clean(row.driver_name_text) || 'Driver', phone: drv.phone || clean(row.driver_cell_snapshot) };
  }).filter((r) => r.phone);
  if (!recipients.length) return true;
  openSendTextModal(recipients, preShiftMessage(unsent[0].shift_start), unsent.map((row) => Number(row.id)));
  return true;
}

function extraAlertHtml({ icon, text, buttonAttrs, jumpId }) {
  return `<div class="alert-chat-item dispatch-extra-alert"${jumpId ? ` data-alert-jump-ids="${jumpId}"` : ''}>
    <span class="alert-chat-icon">${icon}</span>
    <span class="alert-chat-text">${esc(text)}</span>
    ${buttonAttrs ? `<button type="button" class="alert-action-btn" ${buttonAttrs}>Text</button>` : ''}
  </div>`;
}

async function houstonPreShiftAlerts() {
  if (currentLocation() !== 'houston' || !supabaseClient) return [];
  const today = todayKey('America/Chicago');
  const now = nowMinutes('America/Chicago');
  const { data, error } = await supabaseClient
    .from('loads_houston')
    .select('id,time,driver_name,driver_phone,shift_complete,pre_shift_text_sent_at')
    .eq('shift_date', today)
    .eq('shift_complete', false)
    .is('pre_shift_text_sent_at', null);
  if (error) { console.error('Houston pre-shift alert query failed', error); return []; }
  return (data || []).filter((row) => {
    const start = parseHHMM(row.time);
    if (start == null || !clean(row.driver_phone)) return false;
    const until = start - now;
    return until <= 60 && until > -180;
  }).map((row) => ({
    html: extraAlertHtml({
      icon:'📋',
      text:`${clean(row.driver_name) || 'Driver'} — ${clockLabel(row.time)} pre-shift ETA text`,
      jumpId:null,
      buttonAttrs:`data-houston-preshift-id="${row.id}" data-driver-name="${esc(clean(row.driver_name) || 'Driver')}" data-driver-phone="${esc(clean(row.driver_phone))}" data-shift-time="${esc(row.time)}"`,
    }),
  }));
}

async function carrierDocsAlerts() {
  const loc = currentLocation();
  if (!['atlanta','delaware'].includes(loc) || !supabaseClient) return [];
  const zone = 'America/New_York';
  const today = todayKey(zone);
  const now = nowMinutes(zone);
  const { data: shifts, error } = await supabaseClient
    .from('loads_shifts')
    .select('id,location,shift_start,pro_number,aljex_load_number,driver_id,driver_name_text,driver_cell_snapshot,shift_complete,called_off,carrier_docs_text_sent_at')
    .eq('location', loc)
    .eq('shift_date', today)
    .eq('shift_complete', false)
    .is('carrier_docs_text_sent_at', null);
  if (error || !shifts?.length) return [];

  let eligibleIds = new Set();
  if (loc === 'atlanta') {
    const ids = shifts.map((s) => s.id);
    const { data: trips, error: tripError } = await supabaseClient.from('loads_trips').select('shift_id,route_id,trip_id').in('shift_id', ids);
    if (tripError) return [];
    for (const trip of trips || []) if (clean(trip.route_id) || clean(trip.trip_id)) eligibleIds.add(Number(trip.shift_id));
  } else {
    for (const shift of shifts) {
      const start = parseHHMM(shift.shift_start);
      if (start != null && now >= start) eligibleIds.add(Number(shift.id));
    }
  }

  const eligible = shifts.filter((s) => eligibleIds.has(Number(s.id)) && !s.called_off);
  const drivers = await driverMap(eligible.map((s) => s.driver_id));
  return eligible.map((shift) => {
    const drv = drivers.get(String(shift.driver_id)) || {};
    const name = drv.name || clean(shift.driver_name_text) || 'Driver';
    const phone = drv.phone || clean(shift.driver_cell_snapshot);
    const pro = clean(shift.pro_number || shift.aljex_load_number);
    const triggerText = loc === 'atlanta' ? 'route entered' : `${clockLabel(shift.shift_start)} shift started`;
    const attrs = phone && pro
      ? `data-carrier-docs-shift="${shift.id}" data-driver-name="${esc(name)}" data-driver-phone="${esc(phone)}" data-pro="${esc(pro)}"`
      : '';
    return {
      html: extraAlertHtml({
        icon:'📲',
        text:`${name} — Carrier Docs reminder due (${triggerText})${pro ? ` · PRO#${pro}` : ' · PRO missing'}`,
        jumpId:shift.id,
        buttonAttrs:attrs,
      }),
    };
  });
}

async function refreshExtraAlerts() {
  clearTimeout(refreshTimer);
  const body = document.getElementById('alert-widget-body');
  const widget = document.getElementById('alert-widget');
  if (!body || !widget || !currentLocation()) return;
  suppressObserverUntil = Date.now() + 450;
  body.querySelectorAll('.dispatch-extra-alert').forEach((el) => el.remove());
  const extras = [...await houstonPreShiftAlerts(), ...await carrierDocsAlerts()];
  for (const extra of extras) body.insertAdjacentHTML('beforeend', extra.html);
  const count = body.querySelectorAll('.alert-chat-item').length;
  const countEl = document.getElementById('alert-widget-count');
  if (countEl) countEl.textContent = count ? `(${count})` : '';
  if (extras.length && !widget.classList.contains('expanded')) widget.classList.add('blinking');
}

function scheduleRefresh(delay = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshExtraAlerts(), delay);
}

function installAlertObserver() {
  const body = document.getElementById('alert-widget-body');
  if (!body || body.dataset.dispatchExtrasObserved === '1') return;
  body.dataset.dispatchExtrasObserved = '1';
  new MutationObserver(() => {
    if (Date.now() < suppressObserverUntil) return;
    scheduleRefresh(150);
  }).observe(body, { childList:true });
}

document.addEventListener('click', (event) => {
  const base = event.target.closest('[data-alert-action-key]');
  if (base && /^preshift-\d+$/.test(base.dataset.alertActionKey || '')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void handleBasePreShiftClick(base);
    return;
  }

  const hou = event.target.closest('[data-houston-preshift-id]');
  if (hou) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = Number(hou.dataset.houstonPreshiftId);
    openTrackedText(
      [{ name:hou.dataset.driverName, phone:hou.dataset.driverPhone }],
      preShiftMessage(hou.dataset.shiftTime),
      () => supabaseClient.from('loads_houston').update({ pre_shift_text_sent_at:new Date().toISOString() }).eq('id', id),
    );
    return;
  }

  const docs = event.target.closest('[data-carrier-docs-shift]');
  if (docs) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = Number(docs.dataset.carrierDocsShift);
    openTrackedText(
      [{ name:docs.dataset.driverName, phone:docs.dataset.driverPhone }],
      carrierDocsMessage(docs.dataset.pro),
      () => supabaseClient.from('loads_shifts').update({ carrier_docs_text_sent_at:new Date().toISOString() }).eq('id', id),
    );
  }
}, true);

document.addEventListener('change', (event) => {
  if (event.target.matches?.('[data-field="routeId"],[data-field="tripId"]')) scheduleRefresh(350);
});

function init() {
  installTrackedModalWatcher();
  installAlertObserver();
  scheduleRefresh(700);
  setInterval(() => {
    installTrackedModalWatcher();
    installAlertObserver();
    void refreshExtraAlerts();
  }, 60_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
