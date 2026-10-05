export function driverRate(value) {
  if (value == null || String(value).trim() === '') return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}
// Profile boxes show "default" when this exact mileage tier has no override.
export function preferredTierRate(driver, tiers) {
  const tier = (tiers || []).find(t => Number(t.min) === 61 && Math.floor(Number(t.max)) === 140);
  return tier ? driverRate(driver.atlantaRateOverrides?.tiers?.[tier.id]) : null;
}
export function rateOptions(drivers, tiers) {
  const rates = drivers.map(d => preferredTierRate(d, tiers));
  const options = [...new Set(rates.filter(r => r !== null))].sort((a, b) => a - b);
  return rates.includes(null) ? ['DEFAULT', ...options] : options;
}
export function rateMembers(drivers, rate, tiers) {
  if (rate === 'DEFAULT') return drivers.filter(d => preferredTierRate(d, tiers) === null);
  const selected = driverRate(rate);
  return selected === null ? [] : drivers.filter(d => preferredTierRate(d, tiers) === selected);
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
