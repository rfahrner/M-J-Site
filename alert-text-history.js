// Every accepted Alert -> Text action is its own event, including reopening
// the same draft. A click is never represented as a successful delivery.
export async function writeAlertTextClick(client, {source = 'loads_shifts', loadIds = [], tripId = null, label = 'Driver reminder', message = ''}) {
  const ids = [...new Set(loadIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!client || !ids.length) throw new Error('The alert could not be linked to a saved load.');
  const {data, error} = await client.rpc('log_alert_text_click', {
    p_source:source, p_load_ids:ids, p_trip_id:tripId,
    p_alert_label:String(label), p_message:String(message),
  });
  if (error) throw error;
  if (!Array.isArray(data) || data.length !== ids.length) throw new Error('The alert history entry was not confirmed.');
  return data;
}
export function boardAlertTextDetails(alert) {
  return {source:'loads_shifts', loadIds:alert.textShiftIds || alert.markShiftIdsOnSent || [alert.shiftDbId],
    tripId:alert.tripDbId || null, label:alert.message || alert.type || 'Driver reminder', message:alert.actionMessage || ''};
}
