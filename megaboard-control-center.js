const SUPABASE_URL = 'https://ygsapysqzwrpcimgvaqx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_8b8bSIiYm5TzLTw0WG1pAw_5ZWW5ZPL';
const AUTH_STORAGE_KEY = 'dl-dispatch-auth';
const ACTIVE_TAB_KEY = 'dl-megaboard-control-tab-v1';
const HISTORY_WINDOW_HOURS = 36;
const MAX_UPCOMING = 24;
const MAX_ACTIVITY = 30;

const STANDARD_LOCATIONS = {
  atlanta: { label: 'Atlanta', source: 'Kroger', href: 'index.html', timeZone: 'America/New_York' },
  delaware: { label: 'Delaware', source: 'Kroger', href: 'dalaware.html', timeZone: 'America/New_York' },
  buildingc: { label: 'Building C', source: 'Kroger', href: 'buildingc.html', timeZone: 'America/New_York' },
};
const HOUSTON = { label: 'Houston', source: 'Kroger', href: 'houston.html', timeZone: 'America/Chicago' };
const MONDELEZ_LOCATIONS = {
  westchester: { label: 'West Chester', timeZone: 'America/New_York' },
  morris: { label: 'Morris', timeZone: 'America/Chicago' },
  addison: { label: 'Addison', timeZone: 'America/Chicago' },
  indianapolis: { label: 'Indianapolis', timeZone: 'America/Indiana/Indianapolis' },
  louisville: { label: 'Louisville', timeZone: 'America/Kentucky/Louisville' },
  spokane: { label: 'Spokane', timeZone: 'America/Los_Angeles' },
  lasvegas: { label: 'Las Vegas', timeZone: 'America/Los_Angeles' },
  boise: { label: 'Boise', timeZone: 'America/Boise' },
  kent: { label: 'Kent', timeZone: 'America/Los_Angeles' },
  saltlakecity: { label: 'Salt Lake City', timeZone: 'America/Denver' },
  newberlin: { label: 'New Berlin', timeZone: 'America/Chicago' },
};

const IGNORED_HISTORY_FIELDS = new Set([
  'updated_at', 'aljex_last_sync_at', 'aljex_sync_state', 'rate_overrides',
  'customer_rate', 'carrier_rate', 'rate_manual', 'eta_disp_decimal', 'hos_decimal',
]);

let client = null;
let activeTab = readActiveTab();
let refreshTimer = null;
let minuteTimer = null;
let realtimeChannel = null;
let refreshSerial = 0;
let lastModel = { upcoming: [], activity: [] };

function $(id) { return document.getElementById(id); }
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
function boolish(value) {
  if (value === true || value === 1) return true;
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'received';
}
function readActiveTab() {
  try {
    const value = localStorage.getItem(ACTIVE_TAB_KEY);
    return value === 'activity' ? 'activity' : 'upcoming';
  } catch (_) { return 'upcoming'; }
}
function saveActiveTab() {
  try { localStorage.setItem(ACTIVE_TAB_KEY, activeTab); } catch (_) { /* ignore */ }
}
function selectedDates() {
  return [...document.querySelectorAll('#mega-date-chips [data-mega-date].is-selected')]
    .map((button) => button.dataset.megaDate)
    .filter(Boolean)
    .sort();
}
function parseClock(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const ampm = /\b(am|pm)\b/i.exec(raw)?.[1]?.toLowerCase() || null;
  const digits = raw.replace(/[^0-9]/g, '');
  let hour;
  let minute;
  if (raw.includes(':')) {
    const match = raw.match(/(\d{1,2})\s*:\s*(\d{2})/);
    if (!match) return null;
    hour = Number(match[1]);
    minute = Number(match[2]);
  } else if (digits.length === 3 || digits.length === 4) {
    hour = Number(digits.slice(0, -2));
    minute = Number(digits.slice(-2));
  } else if (digits.length <= 2) {
    hour = Number(digits);
    minute = 0;
  } else {
    return null;
  }
  if (ampm) {
    hour %= 12;
    if (ampm === 'pm') hour += 12;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}
function timeZoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const pick = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const hour = pick('hour') % 24;
  const asUtc = Date.UTC(pick('year'), pick('month') - 1, pick('day'), hour, pick('minute'), pick('second'));
  return asUtc - date.getTime();
}
function zonedDateTime(dateKey, clockValue, timeZone) {
  const clock = parseClock(clockValue);
  if (!clock || !/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const [year, month, day] = dateKey.split('-').map(Number);
  const wallUtc = Date.UTC(year, month - 1, day, clock.hour, clock.minute, 0);
  let guess = new Date(wallUtc);
  let offset = timeZoneOffsetMs(guess, timeZone);
  guess = new Date(wallUtc - offset);
  const secondOffset = timeZoneOffsetMs(guess, timeZone);
  if (secondOffset !== offset) guess = new Date(wallUtc - secondOffset);
  return guess;
}
function sameOrNextDay(dateKey, clockValue, timeZone, referenceDate) {
  let eventDate = zonedDateTime(dateKey, clockValue, timeZone);
  if (!eventDate) return null;
  if (referenceDate && eventDate.getTime() < referenceDate.getTime() - 6 * 60 * 60 * 1000) {
    const base = new Date(`${dateKey}T12:00:00Z`);
    base.setUTCDate(base.getUTCDate() + 1);
    const nextKey = base.toISOString().slice(0, 10);
    eventDate = zonedDateTime(nextKey, clockValue, timeZone) || eventDate;
  }
  return eventDate;
}
function localDateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function displayTime(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '—';
  const now = new Date();
  const sameDay = localDateKey(date, timeZone) === localDateKey(now, timeZone);
  const time = date.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  const day = date.toLocaleDateString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} · ${time}`;
}
function relativeDue(date) {
  const mins = Math.round((date.getTime() - Date.now()) / 60000);
  if (mins < -60) return `${Math.floor(Math.abs(mins) / 60)}h ${Math.abs(mins) % 60}m overdue`;
  if (mins < 0) return `${Math.abs(mins)}m overdue`;
  if (mins === 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 24 * 60) return `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `in ${Math.floor(mins / 1440)}d`;
}
function meaningfulTrip(trip) {
  return !!String(trip?.route_id || trip?.trip_id || '').trim();
}
function nativeHrefForStandard(location) {
  return STANDARD_LOCATIONS[location]?.href || 'index.html';
}
function mondelezMeta(location) {
  const info = MONDELEZ_LOCATIONS[location] || { label: location || 'Mondelez', timeZone: 'America/New_York' };
  return { ...info, source: 'Mondelez', href: `mondelez.html?loc=${encodeURIComponent(location || 'combined')}` };
}
function pushEvent(list, event) {
  if (!event?.due || Number.isNaN(event.due.getTime())) return;
  list.push({
    severity: 'scheduled',
    source: '', location: '', driver: '', load: '', route: '', detail: '', href: '#',
    ...event,
  });
}
function isTodayFor(event) {
  return event.dateKey === localDateKey(new Date(), event.timeZone);
}
function keepOperationalEvent(event) {
  const delta = event.due.getTime() - Date.now();
  if (delta >= 0) return true;
  if (!event.actionable) return false;
  if (!isTodayFor(event)) return false;
  return delta >= -12 * 60 * 60 * 1000;
}

function buildStandardUpcoming(shifts, tripsByShift) {
  const events = [];
  const now = new Date();
  for (const shift of shifts) {
    const meta = STANDARD_LOCATIONS[shift.location];
    if (!meta) continue;
    const inactive = !!(shift.shift_complete || shift.tonu || shift.called_off || shift.load_cancelled);
    if (inactive) continue;
    const start = zonedDateTime(shift.shift_date, shift.shift_start, meta.timeZone);
    const trips = (tripsByShift.get(shift.id) || []).filter(meaningfulTrip);
    const hasRealTrip = trips.length > 0;
    const driver = shift.driver_name_text || 'Unassigned driver';
    const load = shift.pro_number || shift.aljex_load_number || 'Load';
    const base = {
      source: meta.source, location: meta.label, driver, load, href: meta.href,
      dateKey: shift.shift_date, timeZone: meta.timeZone,
    };

    if (start && start.getTime() >= now.getTime()) {
      pushEvent(events, { ...base, due: start, title: 'Shift starts', detail: `${driver} · ${load}`, severity: 'scheduled' });
    }

    if (start && !hasRealTrip) {
      const preSent = !!shift.pre_shift_text_sent_at || boolish(shift.pre_shift_text_sent);
      const hasEta = !!String(shift.eta_shift_report || shift.eta_for_shift_report || '').trim();
      if (!preSent) {
        const due = new Date(start.getTime() - 60 * 60000);
        const overdue = due.getTime() <= now.getTime();
        const closeToStart = now.getTime() >= start.getTime() - 15 * 60000;
        pushEvent(events, {
          ...base, due, actionable: true,
          severity: overdue ? (closeToStart ? 'critical' : 'warning') : 'upcoming',
          title: overdue ? (closeToStart ? 'Driver unconfirmed — pre-shift text missed' : 'Pre-shift text missed') : 'Pre-shift text due',
          detail: `${driver} · ${load} · ${overdue ? relativeDue(due) : `shift ${relativeDue(start)}`}`,
        });
      } else if (!hasEta) {
        const due = new Date(start.getTime() - 30 * 60000);
        const overdue = due.getTime() <= now.getTime();
        pushEvent(events, {
          ...base, due, actionable: true,
          severity: overdue ? (now.getTime() >= start.getTime() - 15 * 60000 ? 'critical' : 'warning') : 'upcoming',
          title: overdue ? 'Call follow-up due — still no ETA' : 'Call follow-up',
          detail: `${driver} · ${load} · pre-shift text sent, ETA still blank`,
        });
      }
    }

    if (shift.next_call_time) {
      const due = sameOrNextDay(shift.shift_date, shift.next_call_time, meta.timeZone, start);
      if (due) {
        const overdue = due.getTime() <= now.getTime();
        if (!overdue || (isTodayFor({ dateKey: shift.shift_date, timeZone: meta.timeZone }) && now.getTime() - due.getTime() <= 3 * 60 * 60 * 1000)) {
          pushEvent(events, {
            ...base, due, actionable: true,
            severity: overdue ? 'warning' : 'upcoming',
            title: overdue ? 'Next call time passed' : 'Next call',
            detail: `${driver} · ${load}`,
          });
        }
      }
    }

    for (const trip of trips) {
      if (trip.complete || trip.minimized) continue;
      const route = trip.trip_id || trip.route_id || `Route ${trip.trip_number || ''}`.trim();
      const dispatch = sameOrNextDay(shift.shift_date, trip.dispatch_time, meta.timeZone, start);
      const routeBase = { ...base, route, driver: driver || shift.driver_name_text || 'Driver' };

      if (!trip.dispatch_time && start && start.getTime() <= now.getTime() && isTodayFor(routeBase)) {
        pushEvent(events, {
          ...routeBase, due: start, actionable: true, severity: 'warning',
          title: 'Route missing dispatch time', detail: `${route} · ${driver} · ${load}`,
        });
      }

      const returnEta = sameOrNextDay(shift.shift_date, trip.return_eta_to_dc, meta.timeZone, dispatch || start);
      if (returnEta) {
        const overdue = returnEta.getTime() <= now.getTime();
        pushEvent(events, {
          ...routeBase, due: returnEta, actionable: true,
          severity: overdue ? 'critical' : 'upcoming',
          title: overdue ? 'Return ETA passed — follow up' : 'Return to DC expected',
          detail: overdue
            ? `${route} · ${driver} · check paperwork and drop spot`
            : `${route} · ${driver} · ${load}`,
        });
      } else if (trip.last_stop_depart) {
        const lastStop = sameOrNextDay(shift.shift_date, trip.last_stop_depart, meta.timeZone, dispatch || start);
        if (lastStop) {
          const overdue = lastStop.getTime() <= now.getTime();
          pushEvent(events, {
            ...routeBase, due: lastStop, actionable: true,
            severity: overdue ? 'warning' : 'upcoming',
            title: overdue ? 'Last-stop time reached — get return ETA' : 'Last stop expected',
            detail: `${route} · ${driver} · ${load}`,
          });
        }
      }
    }
  }
  return events.filter(keepOperationalEvent);
}

function buildHoustonUpcoming(rows) {
  const events = [];
  const now = new Date();
  for (const row of rows) {
    if (row.shift_complete || row.tonu) continue;
    const start = zonedDateTime(row.shift_date, row.time, HOUSTON.timeZone);
    if (!start) continue;
    const driver = row.driver_name || 'Unassigned driver';
    const load = row.aljex_number || 'Houston load';
    const base = { source: HOUSTON.source, location: HOUSTON.label, driver, load, href: HOUSTON.href, dateKey: row.shift_date, timeZone: HOUSTON.timeZone };
    if (start.getTime() >= now.getTime()) {
      pushEvent(events, { ...base, due: start, title: 'Shift starts', detail: `${driver} · ${load}`, severity: 'scheduled' });
    }
    if (!row.pre_shift_text_sent_at) {
      const due = new Date(start.getTime() - 60 * 60000);
      const overdue = due.getTime() <= now.getTime();
      pushEvent(events, {
        ...base, due, actionable: true,
        severity: overdue ? (now.getTime() >= start.getTime() - 15 * 60000 ? 'critical' : 'warning') : 'upcoming',
        title: overdue ? 'Pre-shift text missed' : 'Pre-shift text due',
        detail: `${driver} · ${load}`,
      });
    }
  }
  return events.filter(keepOperationalEvent);
}

function buildMondelezUpcoming(rows) {
  const events = [];
  const now = new Date();
  for (const row of rows) {
    if (row.shift_complete || row.tonu) continue;
    const meta = mondelezMeta(row.location);
    const start = zonedDateTime(row.shift_date, row.start_time, meta.timeZone);
    if (!start || start.getTime() < now.getTime()) continue;
    pushEvent(events, {
      due: start, severity: 'scheduled', source: meta.source, location: meta.label,
      driver: row.driver_name || 'Unassigned driver', load: row.aljex_number || row.delivery_group || 'Mondelez load',
      href: meta.href, dateKey: row.shift_date, timeZone: meta.timeZone,
      title: 'Load starts', detail: `${row.driver_name || 'Unassigned'} · ${row.aljex_number || row.delivery_group || 'load'}`,
    });
  }
  return events;
}

function fieldLabel(field) {
  const labels = {
    driver_id: 'Driver assignment', driver_name_text: 'Driver', route_id: 'Route ID', trip_id: 'Trip ID',
    dispatch_time: 'Dispatch time', complete: 'Route complete', shift_complete: 'Load complete',
    ppwk_received: 'Paperwork received', checked_in: 'Load checked in', route_image_path: 'Route image',
    timesheet_received: 'Time sheet received', timesheet_start_time: 'Time sheet start', timesheet_end_time: 'Time sheet finish',
    eta_shift_report: 'Shift ETA', eta_for_shift_report: 'Shift ETA', next_call_time: 'Next call time',
    return_eta_to_dc: 'Return ETA to DC', return_drop_location: 'Trailer drop location', last_stop_depart: 'Last stop depart',
    trailer_out: 'Trailer', route_miles: 'Miles', stop_count: 'Stops', notes: 'Notes', comments: 'Comments',
    called_off: 'Called off', load_cancelled: 'Load cancelled', tonu: 'TONU', pre_shift_text_sent: 'Pre-shift text',
    pre_shift_text_sent_at: 'Pre-shift text sent', shift_start: 'Shift start', pro_number: 'PRO #', aljex_load_number: 'Aljex load #',
    driver_name: 'Driver', aljex_number: 'Aljex #', start_time: 'Start time', delivery_group: 'Delivery group',
    trailer_number: 'Trailer', return_trailer_number: 'Return trailer', shift_complete_at: 'Load completion time',
  };
  if (labels[field]) return labels[field];
  return String(field || 'Change').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function shortValue(value) {
  if (value == null || String(value).trim() === '') return 'blank';
  const raw = String(value).trim();
  if (raw.toLowerCase() === 'true') return 'Yes';
  if (raw.toLowerCase() === 'false') return 'No';
  return raw.length > 70 ? `${raw.slice(0, 67)}…` : raw;
}
function describeHistoryChange(row) {
  const field = row.field_name || '';
  const oldValue = row.old_value;
  const newValue = row.new_value;
  if (field === 'dispatch_time' && !oldValue && newValue) return { title: 'Route dispatched', detail: `Dispatch time ${shortValue(newValue)}` };
  if (field === 'complete') return { title: boolish(newValue) ? 'Route marked complete' : 'Route reopened', detail: '' };
  if (field === 'shift_complete') return { title: boolish(newValue) ? 'Load marked complete' : 'Load reopened', detail: '' };
  if (field === 'ppwk_received' && boolish(newValue)) return { title: 'Paperwork received', detail: '' };
  if (field === 'checked_in' && boolish(newValue)) return { title: 'Load checked in', detail: '' };
  if (field === 'route_image_path') return { title: 'Route image updated', detail: '' };
  if (field === 'timesheet_received' && boolish(newValue)) return { title: 'Time sheet received', detail: '' };
  if (field === 'route_id' && !oldValue && newValue) return { title: 'Route added', detail: `Route ${shortValue(newValue)}` };
  if (field === 'trip_id' && !oldValue && newValue) return { title: 'Trip ID added', detail: shortValue(newValue) };
  const detail = oldValue == null || String(oldValue).trim() === ''
    ? `Set to ${shortValue(newValue)}`
    : `${shortValue(oldValue)} → ${shortValue(newValue)}`;
  return { title: `${fieldLabel(field)} changed`, detail };
}
function activityItemKey(item) {
  return `${item.source}|${item.location}|${item.load}|${item.route || ''}|${item.title}|${Math.floor(item.at.getTime() / 60000)}`;
}
function pushActivity(list, seen, item) {
  if (!item?.at || Number.isNaN(item.at.getTime())) return;
  const key = activityItemKey(item);
  if (seen.has(key)) return;
  seen.add(key);
  list.push(item);
}

async function buildActivity(data) {
  const activity = [];
  const seen = new Set();
  const sinceIso = new Date(Date.now() - HISTORY_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const shiftMap = new Map(data.standardShifts.map((row) => [Number(row.id), row]));
  const tripMap = new Map(data.trips.map((row) => [Number(row.id), row]));
  const mondelezMap = new Map(data.mondelezRows.map((row) => [Number(row.id), row]));
  const selectedShiftIds = new Set(shiftMap.keys());
  const selectedTripIds = new Set(tripMap.keys());
  const selectedMondelezIds = new Set(mondelezMap.keys());

  const [standardHistoryResult, mondelezHistoryResult] = await Promise.all([
    client.from('load_change_history').select('*').gte('changed_at', sinceIso).order('changed_at', { ascending: false }).limit(220),
    client.from('mondelez_change_history').select('*').gte('changed_at', sinceIso).order('changed_at', { ascending: false }).limit(140),
  ]);

  if (!standardHistoryResult.error) {
    for (const history of standardHistoryResult.data || []) {
      if (IGNORED_HISTORY_FIELDS.has(history.field_name)) continue;
      let shift = history.shift_id != null ? shiftMap.get(Number(history.shift_id)) : null;
      const trip = history.trip_id != null ? tripMap.get(Number(history.trip_id)) : null;
      if (!shift && trip) shift = shiftMap.get(Number(trip.shift_id));
      if (!shift) continue;
      if (!selectedShiftIds.has(Number(shift.id)) && !(trip && selectedTripIds.has(Number(trip.id)))) continue;
      const meta = STANDARD_LOCATIONS[shift.location];
      if (!meta) continue;
      const desc = describeHistoryChange(history);
      pushActivity(activity, seen, {
        at: new Date(history.changed_at), timeZone: meta.timeZone, source: meta.source, location: meta.label,
        load: shift.pro_number || shift.aljex_load_number || history.load_label || 'Load',
        route: trip ? (trip.trip_id || trip.route_id || '') : '', href: meta.href,
        title: desc.title, detail: history.note || desc.detail,
        who: history.changed_by || '',
      });
    }
  }

  if (!mondelezHistoryResult.error) {
    for (const history of mondelezHistoryResult.data || []) {
      if (IGNORED_HISTORY_FIELDS.has(history.field_name)) continue;
      const row = mondelezMap.get(Number(history.mondelez_load_id));
      if (!row || !selectedMondelezIds.has(Number(row.id))) continue;
      const meta = mondelezMeta(row.location);
      const desc = describeHistoryChange(history);
      pushActivity(activity, seen, {
        at: new Date(history.changed_at), timeZone: meta.timeZone, source: meta.source, location: meta.label,
        load: row.aljex_number || row.delivery_group || 'Mondelez load', route: '', href: meta.href,
        title: desc.title, detail: history.note || desc.detail, who: history.changed_by || '',
      });
    }
  }

  for (const shift of data.standardShifts) {
    const meta = STANDARD_LOCATIONS[shift.location];
    if (!meta) continue;
    if (shift.shift_complete_at) {
      pushActivity(activity, seen, {
        at: new Date(shift.shift_complete_at), timeZone: meta.timeZone, source: meta.source, location: meta.label,
        load: shift.pro_number || shift.aljex_load_number || 'Load', route: '', href: meta.href,
        title: 'Load completed', detail: shift.driver_name_text || '', who: '',
      });
    }
  }
  for (const trip of data.trips) {
    if (!trip.completed_at) continue;
    const shift = shiftMap.get(Number(trip.shift_id));
    const meta = shift && STANDARD_LOCATIONS[shift.location];
    if (!shift || !meta) continue;
    pushActivity(activity, seen, {
      at: new Date(trip.completed_at), timeZone: meta.timeZone, source: meta.source, location: meta.label,
      load: shift.pro_number || shift.aljex_load_number || 'Load', route: trip.trip_id || trip.route_id || '', href: meta.href,
      title: 'Route completed', detail: shift.driver_name_text || '', who: '',
    });
  }
  for (const row of data.houstonRows) {
    const created = row.created_at ? new Date(row.created_at) : null;
    const updated = row.updated_at ? new Date(row.updated_at) : null;
    if (created && Date.now() - created.getTime() <= HISTORY_WINDOW_HOURS * 60 * 60 * 1000) {
      pushActivity(activity, seen, {
        at: created, timeZone: HOUSTON.timeZone, source: HOUSTON.source, location: HOUSTON.label,
        load: row.aljex_number || 'Houston load', route: '', href: HOUSTON.href,
        title: 'Load added', detail: row.driver_name || '', who: '',
      });
    }
    if (updated && (!created || updated.getTime() - created.getTime() > 60000) && Date.now() - updated.getTime() <= HISTORY_WINDOW_HOURS * 60 * 60 * 1000) {
      pushActivity(activity, seen, {
        at: updated, timeZone: HOUSTON.timeZone, source: HOUSTON.source, location: HOUSTON.label,
        load: row.aljex_number || 'Houston load', route: '', href: HOUSTON.href,
        title: row.shift_complete ? 'Load completed / updated' : 'Load updated', detail: row.driver_name || '', who: '',
      });
    }
  }

  return activity.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, MAX_ACTIVITY);
}

async function fetchControlData(dates) {
  const [shiftResult, houstonResult, mondelezResult] = await Promise.all([
    client.from('loads_shifts').select('*').in('shift_date', dates).limit(5000),
    client.from('loads_houston').select('*').in('shift_date', dates).limit(5000),
    client.from('mondelez_loads').select('*').in('shift_date', dates).limit(5000),
  ]);
  const firstError = shiftResult.error || houstonResult.error || mondelezResult.error;
  if (firstError) throw firstError;
  const standardShifts = (shiftResult.data || []).filter((row) => STANDARD_LOCATIONS[row.location]);
  const shiftIds = standardShifts.map((row) => row.id);
  const tripResult = shiftIds.length
    ? await client.from('loads_trips').select('*').in('shift_id', shiftIds).limit(10000)
    : { data: [], error: null };
  if (tripResult.error) throw tripResult.error;
  const trips = tripResult.data || [];
  const tripsByShift = new Map();
  for (const trip of trips) {
    if (!tripsByShift.has(trip.shift_id)) tripsByShift.set(trip.shift_id, []);
    tripsByShift.get(trip.shift_id).push(trip);
  }
  tripsByShift.forEach((list) => list.sort((a, b) => Number(a.trip_number || 0) - Number(b.trip_number || 0)));
  return {
    dates, standardShifts, trips, tripsByShift,
    houstonRows: houstonResult.data || [],
    mondelezRows: mondelezResult.data || [],
  };
}

function severityRank(value) {
  return value === 'critical' ? 0 : value === 'warning' ? 1 : value === 'upcoming' ? 2 : 3;
}
function renderUpcoming(events) {
  const body = $('mega-control-body');
  if (!body) return;
  const overdue = events.filter((event) => event.due.getTime() <= Date.now() && event.actionable);
  const future = events.filter((event) => event.due.getTime() > Date.now());
  const ordered = [
    ...overdue.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.due - b.due),
    ...future.sort((a, b) => a.due - b.due),
  ].slice(0, MAX_UPCOMING);

  if (!ordered.length) {
    body.innerHTML = '<div class="mega-cc-empty"><strong>Nothing pressing in the selected day(s).</strong><span>No missed operational alerts or upcoming timed events are showing right now.</span></div>';
    return;
  }
  const overdueCount = overdue.length;
  const summary = `<div class="mega-cc-summary">${overdueCount ? `<strong class="is-overdue">${overdueCount} overdue</strong>` : '<strong>No overdue items</strong>'}<span>${future.length} upcoming</span></div>`;
  body.innerHTML = summary + `<div class="mega-cc-list">${ordered.map((event) => {
    const overdueNow = event.due.getTime() <= Date.now() && event.actionable;
    const meta = [event.source, event.location, event.driver, event.load, event.route].filter(Boolean).join(' · ');
    return `<div class="mega-cc-row severity-${esc(event.severity)}">
      <div class="mega-cc-time ${overdueNow ? 'is-overdue' : ''}">
        <strong>${overdueNow ? 'OVERDUE' : esc(displayTime(event.due, event.timeZone))}</strong>
        <span>${esc(relativeDue(event.due))}</span>
      </div>
      <div class="mega-cc-message">
        <div class="mega-cc-title">${esc(event.title)}</div>
        <div class="mega-cc-meta">${esc(meta)}</div>
        ${event.detail ? `<div class="mega-cc-detail">${esc(event.detail)}</div>` : ''}
      </div>
      <a class="mega-cc-open" href="${esc(event.href)}">Board ↗</a>
    </div>`;
  }).join('')}</div>`;
}

function renderActivity(activity) {
  const body = $('mega-control-body');
  if (!body) return;
  if (!activity.length) {
    body.innerHTML = '<div class="mega-cc-empty"><strong>No recent activity for the selected day(s).</strong><span>This view is already filtering out sync noise and rate-calculation churn.</span></div>';
    return;
  }
  body.innerHTML = `<div class="mega-cc-summary"><strong>Recent operational activity</strong><span>Last ${HISTORY_WINDOW_HOURS} hours · newest first</span></div>
    <div class="mega-cc-list">${activity.map((item) => {
      const meta = [item.source, item.location, item.load, item.route].filter(Boolean).join(' · ');
      const who = item.who ? ` · ${item.who}` : '';
      return `<div class="mega-cc-row severity-activity">
        <div class="mega-cc-time"><strong>${esc(displayTime(item.at, item.timeZone))}</strong><span>${esc(item.at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span></div>
        <div class="mega-cc-message">
          <div class="mega-cc-title">${esc(item.title)}</div>
          <div class="mega-cc-meta">${esc(meta)}${esc(who)}</div>
          ${item.detail ? `<div class="mega-cc-detail">${esc(item.detail)}</div>` : ''}
        </div>
        <a class="mega-cc-open" href="${esc(item.href)}">Board ↗</a>
      </div>`;
    }).join('')}</div>`;
}

function renderTabs() {
  document.querySelectorAll('[data-mega-cc-tab]').forEach((button) => {
    const selected = button.dataset.megaCcTab === activeTab;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  const upcomingCount = $('mega-cc-upcoming-count');
  const activityCount = $('mega-cc-activity-count');
  if (upcomingCount) {
    const overdue = lastModel.upcoming.filter((event) => event.actionable && event.due.getTime() <= Date.now()).length;
    upcomingCount.textContent = overdue ? `${overdue} overdue` : String(lastModel.upcoming.length);
    upcomingCount.classList.toggle('has-overdue', overdue > 0);
  }
  if (activityCount) activityCount.textContent = String(lastModel.activity.length);
  if (activeTab === 'activity') renderActivity(lastModel.activity);
  else renderUpcoming(lastModel.upcoming);
}

async function refreshControlCenter() {
  if (!client) return;
  const dates = selectedDates();
  if (!dates.length) return;
  const serial = ++refreshSerial;
  const body = $('mega-control-body');
  if (body) body.innerHTML = '<div class="mega-cc-loading">Refreshing control center…</div>';
  try {
    const data = await fetchControlData(dates);
    if (serial !== refreshSerial) return;
    const upcoming = [
      ...buildStandardUpcoming(data.standardShifts, data.tripsByShift),
      ...buildHoustonUpcoming(data.houstonRows),
      ...buildMondelezUpcoming(data.mondelezRows),
    ].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.due.getTime() - b.due.getTime());
    const activity = await buildActivity(data);
    if (serial !== refreshSerial) return;
    lastModel = { upcoming, activity };
    renderTabs();
  } catch (error) {
    console.error('Megaboard control center refresh failed:', error);
    if (serial === refreshSerial && body) body.innerHTML = `<div class="mega-cc-empty is-error"><strong>Control Center could not refresh.</strong><span>${esc(error.message || error)}</span></div>`;
  }
}

function scheduleRefresh(delay = 120) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshControlCenter, delay);
}
function wireUi() {
  document.querySelectorAll('[data-mega-cc-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      activeTab = button.dataset.megaCcTab === 'activity' ? 'activity' : 'upcoming';
      saveActiveTab();
      renderTabs();
    });
  });
  const dateWrap = $('mega-date-chips');
  if (dateWrap) dateWrap.addEventListener('click', () => scheduleRefresh(40));
  ['mega-today-only', 'mega-today-tomorrow', 'mega-all-days', 'mega-refresh'].forEach((id) => {
    $(id)?.addEventListener('click', () => scheduleRefresh(80));
  });
}
function startRealtime() {
  if (!client || realtimeChannel) return;
  realtimeChannel = client.channel('megaboard-control-center-v1')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_shifts' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_trips' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'loads_houston' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mondelez_loads' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'load_change_history' }, () => scheduleRefresh(250))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'mondelez_change_history' }, () => scheduleRefresh(250))
    .subscribe();
}
async function waitForDateChips() {
  for (let i = 0; i < 80; i += 1) {
    if (document.querySelector('#mega-date-chips [data-mega-date]')) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
async function init() {
  try {
    if (!window.supabase) throw new Error('Supabase library did not load.');
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY },
    });
    const { data } = await client.auth.getSession();
    if (!data.session) return;
    await waitForDateChips();
    wireUi();
    renderTabs();
    await refreshControlCenter();
    startRealtime();
    minuteTimer = setInterval(() => {
      renderTabs();
      scheduleRefresh(20);
    }, 60000);
  } catch (error) {
    console.error('Megaboard control center initialization failed:', error);
    const body = $('mega-control-body');
    if (body) body.innerHTML = `<div class="mega-cc-empty is-error"><strong>Control Center could not start.</strong><span>${esc(error.message || error)}</span></div>`;
  }
}

window.addEventListener('beforeunload', () => {
  if (minuteTimer) clearInterval(minuteTimer);
  if (client && realtimeChannel) client.removeChannel(realtimeChannel);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
