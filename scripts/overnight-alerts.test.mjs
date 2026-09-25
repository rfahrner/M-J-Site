import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const helper = readFileSync('overnight-times.js', 'utf8');
const time = await import('data:text/javascript;base64,' + Buffer.from(helper).toString('base64'));
const source = readFileSync('alerts.js', 'utf8');
const scan = source.slice(source.indexOf('  export async function scanForBoardAlerts()'), source.indexOf('\n    return alerts;', source.indexOf('  export async function scanForBoardAlerts()')) + '\n    return alerts;'.length) + '\n  }';
async function alertsAt(iso, tripOverrides = {}, shiftOverrides = {}) {
  const shift = { id: 1, shift_date: '2026-09-25', shift_start: '23:00', location: 'atlanta', pro_number: '1996085', ...shiftOverrides };
  const trip = { id: 2, shift_id: 1, trip_number: 1, trip_id: '1299119', dispatch_time: '23:00', last_stop_depart: '01:00', trailer_out: 'A', backhaul_trailer_number: 'B', ...tripOverrides };
  const requests = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [iso])); } }
  const ctx = vm.createContext({ ...time, Date: Clock, state: { activeLocation: 'atlanta' }, ALL_ALERT_LOCATIONS: ['atlanta'], SHIFTS_TABLE: 'shifts', TRIPS_TABLE: 'trips',
    supabaseClient: { from(table) { return { select() { return this; }, in(field, values) { requests.push({ table, field, values }); return this; }, then(resolve) { resolve({ data: table === 'shifts' ? [shift] : table === 'trips' ? [trip] : [] }); } }; } },
    parseHHMM: time.clockMinutes, minsToClock: min => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`,
    driverNameForShift: () => 'Rodney', driverPhoneForShift: () => '', PRE_SHIFT_ESCALATION_MIN: 15, PRE_SHIFT_CALL_FOLLOWUP_MIN: 30, PRE_SHIFT_TEXT_LEAD_MIN: 60, IDLE_THRESHOLD_MIN: 45, PAPERWORK_FOLLOWUP_MIN: 30, LAST_STOP_RETURN_FOLLOWUP_MIN: 30, AT_DC_FOLLOWUP_MIN: 45
  });
  vm.runInContext(scan.replace('export ', ''), ctx);
  return { alerts: await vm.runInContext('scanForBoardAlerts()', ctx), requests };
}
test('23:00 dispatch / 01:00 last stop waits until the next calendar day', async () => {
  for (const now of ['2026-09-25T14:00:00Z', '2026-09-26T03:30:00Z', '2026-09-26T04:59:00Z']) {
    assert.equal((await alertsAt(now)).alerts.some(a => a.type === 'last_stop'), false, now);
  }
  const result = await alertsAt('2026-09-26T05:00:00Z');
  assert.ok(result.alerts.some(a => a.type === 'last_stop'));
  assert.ok(result.requests.find(r => r.field === 'shift_date').values.includes('2026-09-25'));
});
test('overnight return ETA replaces last-stop alert and becomes overdue at its own time', async () => {
  assert.equal((await alertsAt('2026-09-26T05:30:00Z', { return_eta_to_dc: '02:00' })).alerts.length, 0);
  assert.ok((await alertsAt('2026-09-26T06:00:00Z', { return_eta_to_dc: '02:00' })).alerts.some(a => a.type === 'overdue_return'));
});
test('daytime timings are unchanged and cancellation remains excluded', async () => {
  assert.ok((await alertsAt('2026-09-25T17:00:00Z', { dispatch_time: '10:00', last_stop_depart: '12:00' }, { shift_start: '09:00' })).alerts.some(a => a.type === 'last_stop'));
  assert.equal((await alertsAt('2026-09-26T06:00:00Z', {}, { tonu: true })).alerts.length, 0);
});
test('multiple dispatches and completed timestamps preserve the day offset', () => {
  const trips = [{ dispatchTime: '23:00', lastStopDepart: '01:00', returnEtaToDc: '02:00' }, { dispatchTime: '03:00', lastStopDepart: '05:00' }];
  const timeline = time.tripTimeline('22:00', trips);
  assert.equal(timeline.get(trips[0]).returnEta, 1560);
  assert.equal(timeline.get(trips[1]).lastStop, 1740);
  assert.equal(time.shiftRelativeNow('2026-09-25', '2026-09-26T06:15:00Z'), 1575);
  const early = { dispatchTime: '22:45', lastStopDepart: '01:00' };
  assert.equal(time.tripTimeline('23:00', [early]).get(early).dispatch, 1365);
});
