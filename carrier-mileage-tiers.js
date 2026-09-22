const minimum = tier => Number(tier.min ?? tier.min_miles);
const maximum = tier => Number(tier.max ?? tier.max_miles);

// Both Atlanta and Delaware select carrier tiers using whole miles rounded
// down. Keep actual mileage for display and any over-tier per-mile charge.
// Return the original object so driver/daily/load overrides retain tier IDs.
export function carrierMileageTier(tiers, miles) {
  if (miles == null || miles === '') return null;
  const distance = Number(miles);
  if (!Number.isFinite(distance) || distance < 0) return null;
  const wholeMiles = Math.floor(distance);
  return (tiers || []).find(tier => wholeMiles >= minimum(tier) && wholeMiles <= maximum(tier)) || null;
}

export function carrierTierLabel(tiers, tier) {
  return `${minimum(tier)}–${Math.floor(maximum(tier))}.9 MI`;
}
