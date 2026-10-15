import { clockMinutes, shiftRelativeNow, tripTimeline } from './overnight-times.js';
export const DISPATCH_ROUTE_MESSAGE = 'This is D&L be sure to keep up with your arrival and departure times per stop. when you are finished at your last stop be sure to call in and give us the times and your ETA back to the DC.';
export function dispatchDriverKey(shift) {
  return shift.driver_id != null ? `driver:${shift.driver_id}`
    : `name:${shift.driver_name_text || ''}|phone:${shift.driver_cell_snapshot || ''}`;
}
export function isCallRequiredRoute(trip) {
  return /^(PA|FA)/i.test(String(trip?.route_id || trip?.trip_id || '').trim());
}
export function excludesRoutineDispatchText(trip) {
  return /^(PA|FA|GA)/i.test(String(trip?.route_id || trip?.trip_id || '').trim()) || !!trip?.backhaul || !!trip?.salvage;
}
export function dispatchRoutePrompt(shift, trip, now, rowTrips = [trip]) {
  if (shift.shift_complete || shift.tonu || shift.called_off || shift.load_cancelled || trip.complete || trip.minimized || excludesRoutineDispatchText(trip)) return null;
  if (!String(trip.route_id || trip.trip_id || '').trim() || clockMinutes(trip.dispatch_time) == null || !trip.dispatch_text_event_id) return null;
  const minutes = shiftRelativeNow(shift.shift_date, now);
  const timeline = tripTimeline(shift.shift_start, rowTrips).get(trip);
  if (minutes == null || timeline?.dispatch == null || minutes < timeline.dispatch || minutes - timeline.dispatch > 12 * 60) return null;
  const driverKey = dispatchDriverKey(shift);
  if (trip.dispatch_text_sent_at && trip.dispatch_text_sent_event_id === trip.dispatch_text_event_id
      && trip.dispatch_text_sent_driver_key === driverKey) return null;
  return {tripId:trip.id,eventId:trip.dispatch_text_event_id,dispatchTime:trip.dispatch_time,driverKey,
    waitingForMessage:false};
}
export async function acknowledgeDispatchRouteText(client, prompt) {
  const {data,error} = await client.from('loads_trips').update({
    dispatch_text_sent_at:new Date().toISOString(),dispatch_text_sent_event_id:prompt.eventId,
    dispatch_text_sent_driver_key:prompt.driverKey,
  }).eq('id',prompt.tripId).eq('dispatch_text_event_id',prompt.eventId)
    .eq('dispatch_time',prompt.dispatchTime).select('id');
  if (error) throw error;
  return !!data?.length; // Zero rows: a newer dispatch must remain unhandled.
}
