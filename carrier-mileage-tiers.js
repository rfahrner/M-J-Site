const minimum = tier => Number(tier.min ?? tier.min_miles);
const maximum = tier => Number(tier.max ?? tier.max_miles);
const ordered = tiers => [...(tiers || [])].sort((a, b) => maximum(a) - maximum(b));

// Atlanta's published bands have whole-mile lower bounds. Use successive
// inclusive upper limits so fractional mileage cannot fall into per-mile pay.
// Return the original object: tier IDs still own driver/daily/load overrides.
export function atlantaMileageTier(tiers, miles) {
  if (miles == null || miles === '') return null;
  const bands = ordered(tiers);
  const distance = Number(miles);
  if (!bands.length || !Number.isFinite(distance) || distance < minimum(bands[0])) return null;
  return bands.find(tier => distance <= maximum(tier)) || null;
}

export function atlantaTierLabel(tiers, tier) {
  const bands = ordered(tiers);
  const index = bands.findIndex(band => band === tier || String(band.id) === String(tier.id));
  return index > 0
    ? `Over ${maximum(bands[index - 1])}–${maximum(tier)} MI`
    : `${minimum(tier)}–${maximum(tier)} MI`;
}
