// Await the PostgREST thenable: it is not a native Promise with .catch().
// Returning exactly one row also catches writes blocked by row permissions.
export async function saveAccountingFields(client, id, patch) {
  const fields = Object.keys(patch);
  const { data, error } = await client.from('loads_accounting')
    .update(patch).eq('id', id).select(['id', ...fields].join(',')).single();
  if (error) throw error;
  if (!data || String(data.id) !== String(id)) throw new Error('No accounting row was saved. Refresh and check your access.');
  if (fields.some(field => field.endsWith('_at')
    ? Date.parse(data[field]) !== Date.parse(patch[field])
    : data[field] !== patch[field])) throw new Error('The saved value did not match your change. Refresh and try again.');
  return data;
}
