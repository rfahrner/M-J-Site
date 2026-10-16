import { supabaseClient, openSendTextModal, setDriverSyncStatus, logAlertTextClick, formatTextAddresses } from './loadboard.js';
import { DISPATCH_ROUTE_MESSAGE, dispatchRoutePrompt, acknowledgeDispatchRouteText, isCallRequiredRoute } from './dispatch-route-text.js';
import { boardDateKey, offsetDate, shiftRelativeNow, clockMinutes, OPERATING_WINDOW_MIN } from './overnight-times.js';

/*
 * The Carrier Docs link, derived from wherever this page is served rather
 * than written down.
 *
 * It used to be the literal GitHub Pages URL. That string goes out in a TEXT
 * TO A DRIVER -- "submit your paperwork to <url>" -- so the day the site
 * moves host, or the repository goes private and Pages stops serving, every
 * driver texted gets a dead link and simply stops submitting paperwork.
 * Nothing on our screens would say so; it would look like drivers being slow.
 *
 * `./driver/` against the current page resolves identically on the old host
 * (…/M-J-Site/index.html -> …/M-J-Site/driver/) and on any new one, so this
 * is a no-op today and right afterwards without anyone remembering it.
 *
 * NOTE: the paperwork-pwa-submit edge function keeps its own ALLOWED_ORIGINS
 * list. A new domain has to be added there too, or the PWA loads for the
 * driver and its upload is refused. See docs/HOSTING_CUTOVER.md.
 */
const CARRIER_DOCS_URL = new URL('./driver/', document.baseURI).href;
const CARRIER_DOCS_ALERTS_PAUSED = true;
const BOARD_FILE_TO_LOCATION = {
  '': 'atlanta',
  'index.html': 'atlanta',
  'dalaware.html': 'delaware',
  'buildingc.html': 'buildingc',
  'houston.html': 'houston',
};

let pendingTrackedMarker = null;
let refreshTimer = null;
// The observer is DISCONNECTED while we write, never time-gated. See
// installAlertObserver().
let alertObserver = null;
let observedAlertBody = null;
// What we last painted. alerts.js wipes the widget on its own 60-second scan,
// and recomputing takes three database round trips -- on a real connection
// that is most of a second with the alert MISSING. Repainting from this first
// makes the wipe invisible; the refresh behind it then corrects anything that
// actually changed.
let lastExtrasHtml = [];

function currentFile() { return location.pathname.split('/').pop() || ''; }
function currentLocation() { return BOARD_FILE_TO_LOCATION[currentFile()] || null; }
function esc(value) {
  return String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
}
function clean(value) { return String(value ?? '').trim(); }
/*
 * The shift clock is read by overnight-times.js, not by a copy kept here.
 *
 * There used to be a local parseHHMM in this file matching /^(\d{1,2}):(\d{2})/
 * -- colon only. The board stores BOTH formats, and which one you get depends
 * on who entered the day, not on the row: Delaware's 2026-10-15 was ten shifts
 * of "1300"/"1400"/"2000", its 2026-10-13 was eight of "12:00"/"14:00". Over
 * thirty days, 114 of Delaware's 206 shift_start values and 46 of 46 Houston
 * times were bare digits.
 *
 * So the failure was not a scattered miss. On a bare-digit day every single
 * shift parsed as null, every timing rule in this file read "no start time",
 * and the whole day's alerts were silently absent -- with nothing on screen
 * saying a rule had been skipped rather than satisfied. loadboard.js's
 * parseHHMM has always had the optional colon; only this private copy drifted,
 * and it drifted invisibly because the broken form still returns a plausible
 * null.
 *
 * clockMinutes() is the superset (optional colon, optional seconds) and this
 * module already imported the file it lives in.
 */
const parseHHMM = clockMinutes;
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
/*
 * Delaware's BOL-photo request. Ron's wording, verbatim and deliberately so:
 * drivers have been answering this exact text for a while and the phrasing is
 * what they recognise. Do not "tidy" the punctuation.
 */
const DELAWARE_BOL_MESSAGE = 'Please send a photo of your BOL(s)-with the Route number it is for this shift (e.g.: 1st Route, 2nd route, 3rd Load) to this text thread OR text it in, also confirm how many stops, and total miles for the route w/ photo of each BOL.';
// How many names the alert spells out before it stops; a sixteen-driver
// Delaware evening would otherwise push the Text button off the widget.
const BOL_NAMES_SHOWN = 6;
// The latest a shift whose start time is unreadable could still be running:
// 23:59 of its own day, plus the board's operating window. Derived rather than
// chosen, so it moves with OPERATING_WINDOW_MIN instead of drifting from it.
const UNKNOWN_START_WINDOW_MIN = 1439 + OPERATING_WINDOW_MIN;

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
  // Alert Text buttons are intentional direct messages. Grouped/mass text
  // flows continue to use the default DNU block.
  openSendTextModal(recipients, message, null, { allowDnu: true });
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
  await logAlertTextClick({loadIds:unsent.filter(row => {const drv=drivers.get(String(row.driver_id)) || {};return drv.phone || clean(row.driver_cell_snapshot);}).map(row => row.id),label:'Pre-shift ETA reminder',message:preShiftMessage(unsent[0].shift_start)});
  openSendTextModal(
    recipients,
    preShiftMessage(unsent[0].shift_start),
    unsent.map((row) => Number(row.id)),
    { allowDnu: recipients.length === 1 },
  );
  return true;
}

async function markBolTextSent(shiftIds) {
  try {
    const { error } = await supabaseClient
      .from('loads_shifts')
      .update({ bol_text_sent_at: new Date().toISOString() })
      .in('id', shiftIds);
    if (error) throw error;
  } catch (error) {
    // Say so. An unmarked send means the alert comes back and somebody texts
    // the same drivers twice, which is annoying but visible; a silent failure
    // here would look exactly like the alert misbehaving again.
    setDriverSyncStatus(`Text sent, but the BOL request could not be marked sent (${error.message || error}). The alert will ask again.`, 'error');
  }
  scheduleRefresh(100);
}

async function handleDelawareBolClick(button) {
  const ids = clean(button.dataset.delawareBolShifts).split(',').map(Number).filter(Number.isFinite);
  if (!ids.length) return;
  // Re-read before sending. The alert may have been painted a minute ago, and
  // another dispatcher on another screen may have sent it in the meantime;
  // `.is(bol_text_sent_at, null)` is what stops the second dispatcher texting
  // the whole shift again.
  const { data: rows, error } = await supabaseClient
    .from('loads_shifts')
    .select('id,driver_id,driver_name_text,driver_cell_snapshot,bol_text_sent_at')
    .in('id', ids)
    .is('bol_text_sent_at', null);
  if (error) {
    setDriverSyncStatus(`Could not check the BOL request before sending (${error.message || error}).`, 'error');
    return;
  }
  if (!rows?.length) { scheduleRefresh(100); return; }
  const drivers = await driverMap(rows.map((row) => row.driver_id));
  const sendable = rows.map((row) => {
    const drv = drivers.get(String(row.driver_id)) || {};
    return {
      id: Number(row.id),
      name: drv.name || clean(row.driver_name_text) || 'Driver',
      phone: drv.phone || clean(row.driver_cell_snapshot),
    };
    // formatTextAddresses(), not truthiness. openSendTextModal() drops any
    // recipient this rejects, and shiftIds below is frozen BEFORE the modal
    // runs -- so a malformed cell used to mean the driver was never texted and
    // their shift was marked as though they had been, permanently removing
    // them from the alert's `.is(bol_text_sent_at, null)` query.
    //
    // The modal also de-dupes by normalised number. Two shifts sharing a cell
    // (the duplicate driver profiles in CLAUDE.md) therefore receive one text
    // and both get marked, which is right: that number was asked.
  }).filter((person) => formatTextAddresses(person.phone).length > 0);
  if (!sendable.length) {
    setDriverSyncStatus('No usable driver phone number for those shifts, so the BOL request cannot be sent.', 'error');
    return;
  }
  const shiftIds = sendable.map((person) => person.id);
  /*
   * History is recorded, but a failure to record it does NOT stop the text.
   *
   * Every other alert here awaits logAlertTextClick() ahead of the modal with
   * nothing around it, so one bad RPC -- or a row-count mismatch, which is how
   * writeAlertTextClick() reports partial success -- turns the Text button
   * into a button that shows an error and sends nothing. For a reminder that
   * can be chased later that is a defensible trade. For this one it is not:
   * the drivers are already out on their routes, and a missing audit row is
   * worth less than the BOLs.
   */
  try {
    await logAlertTextClick({ loadIds: shiftIds, label: 'Delaware BOL photo request', message: DELAWARE_BOL_MESSAGE });
  } catch (error) {
    setDriverSyncStatus(`Sending the BOL request, but it could not be added to the load history (${error.message || error}).`, 'error');
  }
  openSendTextModal(
    sendable.map(({ name, phone }) => ({ name, phone })),
    DELAWARE_BOL_MESSAGE,
    // NOT the third argument: that one writes pre_shift_text_sent, which is
    // the ETA reminder's marker. Sharing it would make either text silence
    // the other.
    null,
    { allowDnu: true, onSent: () => { void markBolTextSent(shiftIds); } },
  );
}

function extraAlertHtml({ icon, text, buttonAttrs, jumpId, buttonLabel = 'Text' }) {
  return `<div class="alert-chat-item dispatch-extra-alert"${jumpId ? ` data-alert-jump-ids="${jumpId}"` : ''}>
    <span class="alert-chat-icon">${icon}</span>
    <span class="alert-chat-text">${esc(text)}</span>
    ${buttonAttrs ? `<button type="button" class="alert-action-btn" ${buttonAttrs}>${esc(buttonLabel)}</button>` : ''}
  </div>`;
}

async function houstonPreShiftAlerts() {
  if (currentLocation() !== 'houston' || !supabaseClient) return [];
  const today = todayKey('America/Chicago');
  const now = nowMinutes('America/Chicago');
  const { data, error } = await supabaseClient
    .from('loads_houston')
    .select('id,time,driver_name,driver_phone,shift_complete,pre_shift_text_sent_at,called_off,load_cancelled')
    .eq('shift_date', today)
    .eq('shift_complete', false)
    .is('pre_shift_text_sent_at', null);
  if (error) { console.error('Houston pre-shift alert query failed', error); return []; }
  return (data || []).filter((row) => {
    const start = parseHHMM(row.time);
    if (row.called_off || row.load_cancelled || start == null || !clean(row.driver_phone)) return false;
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
  if (CARRIER_DOCS_ALERTS_PAUSED) return [];
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

/*
 * Delaware: every driver gets asked for BOL photos at the start of their
 * shift, and the ask stays up until somebody sends it.
 *
 * WHY THE SHIFT-RELATIVE CLOCK AND NOT shift_date === today
 * Delaware runs around the clock -- the last thirty days contain starts at
 * 0001, 0200, 0300 and 2200. At 02:00 the shift that needs this text was
 * entered under YESTERDAY's date and is six hours old; under a plain
 * "today" test the night dispatcher would never be prompted for it. So
 * eligibility is measured the way the board's own alert scan measures it:
 * shiftRelativeNow() counts from the shift's own midnight, and the shift is
 * live from its start until OPERATING_WINDOW_MIN past it. That is also what
 * stops the ask piling up forever -- "stays until sent" means until sent or
 * until the shift is over, not until the end of time.
 *
 * WHY ONE GROUPED ALERT
 * The whole shift gets the same text. Ten separate lines with ten Text
 * buttons is ten modals and ten chances to miss one; one line sends the lot.
 *
 * WHY allowDnu
 * One Delaware shift in five runs on a DNU-rated driver (41 of 206 over
 * thirty days, eight drivers). A driver who is out on a route tonight has to
 * send their BOLs whatever their rating says, and the default group block
 * would drop them from the send while this code marked their shift as texted
 * -- the text never sent and the alert never asking again. Alert Text buttons
 * are intentional direct messages, as openTrackedText() says; this is one.
 */
async function delawareBolAlerts() {
  if (currentLocation() !== 'delaware' || !supabaseClient) return [];
  const now = new Date(), today = boardDateKey(now);
  const { data: shifts, error } = await supabaseClient
    .from('loads_shifts')
    .select('id,shift_date,shift_start,driver_id,driver_name_text,driver_cell_snapshot,shift_complete,called_off,tonu,load_cancelled,bol_text_sent_at')
    .eq('location', 'delaware')
    .in('shift_date', [offsetDate(today, -1), today, offsetDate(today, 1)])
    .is('bol_text_sent_at', null);
  /*
   * A failure here must not throw. refreshExtraAlerts() wraps the whole set in
   * one try/catch, so an exception out of this function removes the PA/FA CALL
   * alerts from the screen as well -- and the most likely failure is the most
   * dangerous version of that: code deployed ahead of the migration, so
   * bol_text_sent_at does not exist yet and every refresh wipes the call
   * alerts for the whole board. Reported on its own line instead, where it
   * costs nothing but a dispatcher noticing.
   */
  if (error) {
    console.error('Delaware BOL alert query failed', error);
    return [{
      html: extraAlertHtml({
        icon: '🧾',
        text: `BOL photos — could not check which shifts still need the request (${error.message || error})`,
      }),
    }];
  }
  if (!shifts?.length) return [];

  const live = shifts.filter((shift) =>
    !shift.shift_complete && !shift.called_off && !shift.tonu && !shift.load_cancelled);
  if (!live.length) return [];

  const started = [], noStartTime = [];
  for (const shift of live) {
    const since = shiftRelativeNow(shift.shift_date, now);
    if (since == null) continue;
    const start = parseHHMM(shift.shift_start);
    if (start == null) {
      /*
       * An unreadable start time cannot be timed, so it is REPORTED rather
       * than quietly dropped -- and the window for reporting it is derived
       * from the same operating window rather than guessed.
       *
       * Reading it the most generous way: a shift dated D could have started
       * as late as 23:59 that day, so it can still be live until
       * 23:59 + OPERATING_WINDOW_MIN. Below zero means the shift is dated
       * tomorrow and has not begun, which is why a blank start on a shift
       * pencilled in for tomorrow does not nag all day.
       *
       * The first version of this read `shift.shift_date === today`, which
       * also excluded YESTERDAY -- the whole population the three-day window
       * and the shift-relative clock exist for. At 02:00 a yesterday-dated
       * shift with a blank Shift Start produced nothing at all: no ask, and no
       * notice that there was nothing to ask with.
       */
      if (since >= 0 && since <= UNKNOWN_START_WINDOW_MIN) noStartTime.push(shift);
      continue;
    }
    const elapsed = since - start;
    if (elapsed >= 0 && elapsed <= OPERATING_WINDOW_MIN) started.push(shift);
  }
  if (!started.length && !noStartTime.length) return [];

  const drivers = await driverMap([...started, ...noStartTime].map((shift) => shift.driver_id));
  const named = (shift) => {
    const drv = drivers.get(String(shift.driver_id)) || {};
    return {
      id: Number(shift.id),
      name: drv.name || clean(shift.driver_name_text) || 'Driver',
      phone: drv.phone || clean(shift.driver_cell_snapshot),
      hasDriver: !!(drv.name || clean(shift.driver_name_text) || clean(shift.driver_cell_snapshot)),
    };
  };
  // "Has a phone" has to mean the number openSendTextModal() will accept, not
  // merely a non-empty string. A cell stored as "7208173663 x2", as nine
  // digits, or as two numbers run together is dropped there -- so counting it
  // here makes the alert promise a driver the modal never addresses.
  const textable = (person) => formatTextAddresses(person.phone).length > 0;
  const extras = [];

  if (started.length) {
    const people = started.map(named).filter((person) => person.hasDriver);
    const sendable = people.filter(textable);
    const nophone = people.filter((person) => !textable(person));
    if (people.length) {
      const names = sendable.length ? sendable : people;
      const shown = names.slice(0, BOL_NAMES_SHOWN).map((person) => person.name).join(', ');
      const more = names.length > BOL_NAMES_SHOWN ? ` +${names.length - BOL_NAMES_SHOWN} more` : '';
      const skipped = nophone.length
        ? ` · ${nophone.length} without a usable phone number (${nophone.map((person) => person.name).join(', ')})`
        : '';
      extras.push({
        html: extraAlertHtml({
          icon: '🧾',
          jumpId: people.map((person) => person.id).join(','),
          buttonLabel: 'Text',
          // De-duped by phone inside the modal, so a driver holding two of
          // tonight's shifts is texted once and both shifts are marked -- the
          // message covers every route on the shift, which is the point of it.
          buttonAttrs: sendable.length
            ? `data-delaware-bol-shifts="${sendable.map((person) => person.id).join(',')}"`
            : '',
          text: sendable.length
            ? `BOL photos — ${sendable.length} driver${sendable.length === 1 ? '' : 's'} on shift: ${shown}${more}${skipped}`
            : `BOL photos — no usable phone number for ${shown}${more}; the request cannot be texted`,
        }),
      });
    }
  }

  if (noStartTime.length) {
    const people = noStartTime.map(named).filter((person) => person.hasDriver);
    if (people.length) {
      const shown = people.slice(0, BOL_NAMES_SHOWN).map((person) => person.name).join(', ');
      const more = people.length > BOL_NAMES_SHOWN ? ` +${people.length - BOL_NAMES_SHOWN} more` : '';
      extras.push({
        html: extraAlertHtml({
          icon: '⏱️',
          jumpId: people.map((person) => person.id).join(','),
          text: `BOL photos — no Shift Start on ${people.length} shift${people.length === 1 ? '' : 's'} (${shown}${more}), so the request is not timed yet`,
        }),
      });
    }
  }

  return extras;
}

async function dispatchedRouteAlerts() {
  const loc = currentLocation();
  if (!['atlanta','delaware','buildingc'].includes(loc) || !supabaseClient) return [];
  const now = new Date(), today = boardDateKey(now);
  const {data:shifts,error} = await supabaseClient.from('loads_shifts').select('*')
    .eq('location',loc).in('shift_date',[offsetDate(today,-1),today,offsetDate(today,1)]);
  if (error) throw error;
  if (!shifts?.length) return [];
  const {data:trips,error:tripError} = await supabaseClient.from('loads_trips').select('*').in('shift_id',shifts.map(s=>s.id));
  if (tripError) throw tripError;
  const drivers = await driverMap(shifts.map(s=>s.driver_id));
  const extras = [];
  for (const shift of shifts) {
    const drv = drivers.get(String(shift.driver_id)) || {};
    const name = drv.name || clean(shift.driver_name_text) || 'Driver';
    const phone = drv.phone || clean(shift.driver_cell_snapshot);
    const rowTrips = (trips || []).filter(t=>t.shift_id===shift.id).sort((a,b)=>a.trip_number-b.trip_number);
    for (const trip of rowTrips) {
      const callRequired = isCallRequiredRoute(trip);
      // Backhaul/salvage affects texting only; a PA/FA route still needs the call.
      // Do not clear a call alert for a newly entered route before dispatch time exists.
      // Unlike routine text reminders, this call alert is due as soon as the route is entered.
      const prompt = dispatchRoutePrompt(shift,trip,now,rowTrips);
      if (!prompt && !(callRequired && !shift.shift_complete && !shift.tonu && !shift.called_off && !shift.load_cancelled && !trip.complete && !trip.minimized && clean(trip.route_id || trip.trip_id) && trip.dispatch_text_event_id && trip.dispatch_call_ack_event_id !== trip.dispatch_text_event_id)) continue;
      const label = clean(trip.route_id || trip.trip_id);
      if (callRequired) {
        extras.push({html:extraAlertHtml({icon:'📞',jumpId:shift.id,buttonLabel:'Call',
          buttonAttrs:`data-special-call-trip="${trip.id}" data-special-call-event="${esc(trip.dispatch_text_event_id)}" data-special-call-route="${esc(label)}" data-special-call-driver="${esc(name)}"`,
          text:`${name} (${shift.pro_number || 'No PRO'}, ${label}) — reefer load: call driver and verify they have confirmed the temp`})});
        continue;
      }
      const attrs = !prompt.waitingForMessage && phone
        ? `data-dispatch-route="${esc(label)}" data-dispatch-text-shift="${shift.id}" data-dispatch-text-trip="${trip.id}" data-dispatch-event="${esc(prompt.eventId)}" data-dispatch-time="${esc(prompt.dispatchTime)}" data-dispatch-driver-key="${esc(prompt.driverKey)}" data-driver-name="${esc(name)}" data-driver-phone="${esc(phone)}"` : '';
      extras.push({html:extraAlertHtml({icon:'📲',jumpId:shift.id,buttonAttrs:attrs,
        text:`${name} (${shift.pro_number || 'No PRO'}, ${label}) — ${prompt.waitingForMessage ? 'FA/GA dispatch message awaiting setup' : phone ? 'send dispatched-route reminder' : 'dispatch reminder needs a driver phone number'}`})});
    }
  }
  return extras;
}

// One place that writes our alerts, with the observer off so our own writes
// are never mistaken for someone else's.
function paintExtras(body, htmlList) {
  if (alertObserver) alertObserver.disconnect();
  try {
    body.querySelectorAll('.dispatch-extra-alert').forEach((el) => el.remove());
    for (const html of htmlList) body.insertAdjacentHTML('beforeend', html);
  } finally {
    if (alertObserver && observedAlertBody === body) alertObserver.observe(body, { childList: true });
  }
  const count = body.querySelectorAll('.alert-chat-item').length;
  const countEl = document.getElementById('alert-widget-count');
  if (countEl) countEl.textContent = count ? `(${count})` : '';
}

// Synchronous, inside the observer callback: no await, no debounce, so the
// wipe and the repaint land in the same frame and nothing blinks.
function restoreExtrasNow() {
  if (!lastExtrasHtml.length) return;
  const body = document.getElementById('alert-widget-body');
  if (!body || body.querySelector('.dispatch-extra-alert')) return;
  paintExtras(body, lastExtrasHtml);
}

async function refreshExtraAlerts() {
  clearTimeout(refreshTimer);
  const body = document.getElementById('alert-widget-body');
  const widget = document.getElementById('alert-widget');
  if (!body || !widget || !currentLocation()) return;
  // Install HERE, not only in init(). alerts.js builds #alert-widget-body when
  // it mounts the widget, which is AFTER this module's init() runs -- so the
  // install found no element, returned early, and the observer was never
  // created. Nothing restored a wiped alert except the 60-second interval,
  // which is exactly the "there for a bit and then it disappears" everyone
  // was seeing. By the time we are rendering, the element certainly exists.
  installAlertObserver();
  let extras;
  try { extras = [...await houstonPreShiftAlerts(), ...await carrierDocsAlerts(), ...await delawareBolAlerts(), ...await dispatchedRouteAlerts()]; }
  catch(error) { console.error('Could not refresh dispatch reminders',error);return; }
  lastExtrasHtml = extras.map((extra) => extra.html);
  paintExtras(body, lastExtrasHtml);
  if (extras.length && !widget.classList.contains('expanded')) widget.classList.add('blinking');
}

function scheduleRefresh(delay = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshExtraAlerts(), delay);
}

function installAlertObserver() {
  const body = document.getElementById('alert-widget-body');
  if (!body) return;
  // Track the ELEMENT, not a flag on it. alerts.js rebuilds the whole widget
  // in places, which replaces #alert-widget-body -- a dataset flag goes with
  // the old node and the observer is left watching something detached, so the
  // extras stop coming back at all until the next minute tick.
  if (observedAlertBody === body && alertObserver) return;
  if (alertObserver) alertObserver.disconnect();
  observedAlertBody = body;
  alertObserver = new MutationObserver(() => {
    // Repaint first so the wipe is never visible, THEN reconcile with the
    // database. The repaint is what the dispatcher sees; the refresh is what
    // makes it true.
    restoreExtrasNow();
    scheduleRefresh(150);
  });
  alertObserver.observe(body, { childList:true });
}

/*
 * Shared server-side acknowledgment. Cancel never writes to Supabase.
 *
 * THE WORDING HERE IS THE ATTESTATION, so it is not free to drift.
 *
 * This alert fires only on PA/FA routes (isCallRequiredRoute), and those are
 * the reefer loads -- the call exists so somebody confirms with the driver
 * that the reefer temperature is set. Submitting this form writes the
 * dispatcher's name to loads_trips.dispatch_call_ack_name AND a permanent
 * line in load_change_history, so what the button claims and what the
 * database records have to be the same claim.
 *
 * They are checked against each other by
 * scripts/reefer-temp-call-wording.test.mjs, which reads this file and the
 * migration together. Changing one without the other leaves a dispatcher
 * attesting to one thing on screen and a different thing in the audit trail,
 * which is the half nobody looks at until it matters.
 */
async function showSpecialRouteCallModal(button) {
  const tripId = Number(button.dataset.specialCallTrip);
  const eventId = button.dataset.specialCallEvent;
  const route = button.dataset.specialCallRoute;
  const driver = button.dataset.specialCallDriver;
  const overlay = document.createElement('div');
  overlay.id = 'special-route-call-modal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px';
  overlay.innerHTML = `<form style="background:#fff;color:#172542;border-radius:10px;padding:24px;max-width:430px;width:100%;box-shadow:0 16px 48px #0005">
    <h2 style="margin:0 0 14px;font-size:21px">📞 Call Driver — Reefer Temp</h2>
    <p style="margin:0 0 16px"><strong>${esc(driver)}</strong> — Route ${esc(route)}</p>
    <p>This driver is pulling a reefer. Call them and verify the driver has confirmed the temperature on the reefer.</p>
    <p>Enter your name to clear this alert for every dispatcher.</p>
    <label for="special-route-call-name" style="display:block;font-weight:600;margin:12px 0 5px">Dispatcher name</label>
    <input id="special-route-call-name" maxlength="100" minlength="2" required autocomplete="name" style="width:100%;padding:10px;border:1px solid #8895a7;border-radius:5px;box-sizing:border-box" />
    <div role="alert" class="special-call-error" style="color:#b42318;margin:10px 0;min-height:1em"></div>
    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px">
      <button type="button" data-special-call-cancel style="padding:9px 16px">Cancel</button>
      <button type="submit" style="padding:9px 16px;background:#146dc1;color:white;border:0;border-radius:5px">Confirm Temp Verified</button>
    </div>
  </form>`;
  document.body.appendChild(overlay);
  const form = overlay.querySelector('form');
  overlay.querySelector('[data-special-call-cancel]').addEventListener('click', () => overlay.remove());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const name = clean(overlay.querySelector('#special-route-call-name').value);
    const message = overlay.querySelector('.special-call-error');
    const submit = form.querySelector('[type="submit"]');
    if (name.length < 2) { message.textContent = 'Enter your name before confirming.'; return; }
    submit.disabled = true;
    try {
      const {data,error} = await supabaseClient.rpc('acknowledge_special_route_call',{
        p_trip_id:tripId,p_event_id:eventId,p_dispatcher_name:name,
      });
      if (error) throw error;
      if (!data) {
        message.textContent = 'This dispatch changed or is no longer active. Refreshing its alert.';
        scheduleRefresh(100);
      } else {
        overlay.remove();
        scheduleRefresh(100);
      }
    } catch (error) {
      message.textContent = `Could not confirm the call: ${error.message || error}`;
    } finally { submit.disabled = false; }
  });
  overlay.querySelector('input').focus();
}

document.addEventListener('click', async (event) => {
  try {
  const special = event.target.closest('[data-special-call-trip]');
  if (special) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!document.getElementById('special-route-call-modal')) await showSpecialRouteCallModal(special);
    return;
  }
  const base = event.target.closest('[data-alert-action-key]');
  if (base && /^preshift-\d+$/.test(base.dataset.alertActionKey || '')) {
    event.preventDefault();
    event.stopImmediatePropagation();
    await handleBasePreShiftClick(base);
    return;
  }

  const bol = event.target.closest('[data-delaware-bol-shifts]');
  if (bol) {
    event.preventDefault();
    event.stopImmediatePropagation();
    await handleDelawareBolClick(bol);
    return;
  }

  const hou = event.target.closest('[data-houston-preshift-id]');
  if (hou) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const id = Number(hou.dataset.houstonPreshiftId);
    await logAlertTextClick({source:'loads_houston',loadIds:[id],label:'Pre-shift ETA reminder',message:preShiftMessage(hou.dataset.shiftTime)});
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
    if (CARRIER_DOCS_ALERTS_PAUSED) return;
    const id = Number(docs.dataset.carrierDocsShift);
    await logAlertTextClick({loadIds:[id],label:'Carrier Docs reminder',message:carrierDocsMessage(docs.dataset.pro)});
    openTrackedText(
      [{ name:docs.dataset.driverName, phone:docs.dataset.driverPhone }],
      carrierDocsMessage(docs.dataset.pro),
      () => supabaseClient.from('loads_shifts').update({ carrier_docs_text_sent_at:new Date().toISOString() }).eq('id', id),
    );
  }
  const dispatched = event.target.closest('[data-dispatch-text-trip]');
  if (dispatched) {
    event.preventDefault();event.stopImmediatePropagation();
    const prompt = {tripId:Number(dispatched.dataset.dispatchTextTrip),eventId:dispatched.dataset.dispatchEvent,
      dispatchTime:dispatched.dataset.dispatchTime,driverKey:dispatched.dataset.dispatchDriverKey};
    await logAlertTextClick({loadIds:[Number(dispatched.dataset.dispatchTextShift)],tripId:prompt.tripId,label:`Dispatched-route reminder — ${dispatched.dataset.dispatchRoute || "route"} — ${dispatched.dataset.driverName}`,message:DISPATCH_ROUTE_MESSAGE});
    openSendTextModal([{name:dispatched.dataset.driverName,phone:dispatched.dataset.driverPhone}],DISPATCH_ROUTE_MESSAGE,null,{
      allowDnu:true,
      onSent:()=>{void acknowledgeDispatchRouteText(supabaseClient,prompt).then(()=>scheduleRefresh(100)).catch(error=>{
        setDriverSyncStatus(`Text sent, but its dispatch reminder could not be marked handled (${error.message || error}).`,'error');scheduleRefresh(100);
      });},
    });
  }
  } catch (error) { setDriverSyncStatus(`Could not save alert text history (${error.message || error}). Please try again.`, 'error'); }
}, true);

document.addEventListener('change', (event) => {
  if (event.target.matches?.('[data-field="routeId"],[data-field="tripId"],[data-field="dispatchTime"]')) scheduleRefresh(1100);
});
document.addEventListener('input',event=>{
  if (event.target.matches?.('[data-field="dispatchTime"]')) scheduleRefresh(1100);
});

/*
 * MUST NOT touch supabaseClient synchronously. init() runs while
 * loadboard.js is STILL EVALUATING -- the two modules import each other --
 * so `supabaseClient` is in its temporal dead zone and merely READING it
 * throws "Cannot access 'supabaseClient' before initialization". The
 * `typeof` guard does not save you: the throw happens evaluating the
 * identifier, before typeof ever runs.
 *
 * That throw escapes init(), aborts loadboard.js's evaluation, and
 * supabaseClient is then never initialized at all -- so every later reader
 * throws too (storage-compat.js was the second casualty). The board renders
 * no Dispatch table and the date picker stays blank: the whole site, from
 * one subscription set up two lines too early.
 *
 * A task deferral is enough -- by the time it runs the module graph has
 * finished. scripts/module-init-order.test.mjs pins it.
 */
function subscribeToSpecialRouteCallAcks() {
  if (!supabaseClient || typeof supabaseClient.channel !== 'function') return;
  supabaseClient.channel('special-route-call-acknowledgments')
    .on('postgres_changes', {event:'UPDATE',schema:'public',table:'loads_trips'}, payload => {
      if (payload.new?.dispatch_call_ack_event_id !== payload.old?.dispatch_call_ack_event_id ||
          payload.new?.dispatch_text_event_id !== payload.old?.dispatch_text_event_id) scheduleRefresh(100);
    }).subscribe();
}

function init() {
  installTrackedModalWatcher();
  installAlertObserver();
  scheduleRefresh(700);
  setTimeout(subscribeToSpecialRouteCallAcks, 0);
  setInterval(() => {
    installTrackedModalWatcher();
    installAlertObserver();
    void refreshExtraAlerts();
  }, 60_000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
