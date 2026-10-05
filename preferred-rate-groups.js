export function driverRate(value) {
  if (value == null || String(value).trim() === '') return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}
export function rateOptions(drivers) {
  return [...new Set(drivers.map(d => driverRate(d.normalRate)).filter(r => r !== null))].sort((a, b) => a - b);
}
export function rateMembers(drivers, rate) {
  const selected = driverRate(rate);
  return selected === null ? [] : drivers.filter(d => driverRate(d.normalRate) === selected);
}
export function ratingGroups(drivers, classify) {
  const counts = new Map();
  for (const d of drivers) {
    const rating = classify(d) || 'Unrated';
    if (rating === 'DNU') continue;
    counts.set(rating, (counts.get(rating) || 0) + 1);
  }
  const order = ['A', 'B', 'C', 'D', 'R', 'Unrated'];
  return [...counts].sort(([a], [b]) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)) || a.localeCompare(b));
}
export function selectedRateMembers(drivers, selectedRatings, classify) {
  return drivers.filter(d => selectedRatings.has(classify(d) || 'Unrated') && classify(d) !== 'DNU');
}
export async function savePreferredRate(client, id, value) {
  const rate = String(value).trim() === '' ? null : driverRate(value);
  if (rate === null && String(value).trim() !== '') throw Error('Enter a valid rate of zero or more.');
  if (!client) throw Error('The database is unavailable. Refresh and try again.');
  const { data, error } = await client.from('atlanta_drivers').update({ normal_rate: rate }).eq('id', id).select('id,normal_rate').single();
  if (error) throw error;
  if (!data || String(data.id) !== String(id) || data.normal_rate !== rate) throw Error('Rate was not saved. Refresh and check your access.');
  return data;
}
