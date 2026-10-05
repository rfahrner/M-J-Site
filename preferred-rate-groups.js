export function driverRate(value) {
  if (value == null || String(value).trim() === '') return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}
function hasRateCard(driver) {
  const card = driver?.atlantaRateOverrides;
  return Object.keys(card?.tiers || {}).length > 0 || Object.keys(card?.settings || {}).length > 0;
}
export function resolveAtlantaRateProfile(driver, drivers = []) {
  if (!driver || driver.location !== 'preferred' || hasRateCard(driver)) return driver;
  const name = String(driver.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const mc = String(driver.mc || '').trim();
  if (!name || !mc) return driver;
  const matches = drivers.filter(d =>
    ['atlanta', 'buildingc'].includes(d.location) &&
    String(d.name || '').trim().toLowerCase().replace(/\s+/g, ' ') === name &&
    String(d.mc || '').trim() === mc
  );
  return matches.length === 1 && hasRateCard(matches[0]) ? matches[0] : driver;
}
// Profile boxes show "default" when this exact mileage tier has no override.
export function preferredTierRate(driver, tiers, drivers = []) {
  const tier = (tiers || []).find(t => Number(t.min) === 61 && Math.floor(Number(t.max)) === 140);
  return tier ? driverRate(resolveAtlantaRateProfile(driver, drivers)?.atlantaRateOverrides?.tiers?.[tier.id]) : null;
}
export function rateOptions(drivers, tiers, profiles = drivers) {
  const rates = drivers.map(d => preferredTierRate(d, tiers, profiles));
  const options = [...new Set(rates.filter(r => r !== null))].sort((a, b) => a - b);
  return rates.includes(null) ? ['DEFAULT', ...options] : options;
}
export function rateMembers(drivers, rate, tiers, profiles = drivers) {
  if (rate === 'DEFAULT') return drivers.filter(d => preferredTierRate(d, tiers, profiles) === null);
  const selected = driverRate(rate);
  return selected === null ? [] : drivers.filter(d => preferredTierRate(d, tiers, profiles) === selected);
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
