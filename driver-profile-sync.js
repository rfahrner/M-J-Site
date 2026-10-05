// The modal submits only fields the person actually changed. A stale open
// modal must not write its untouched values over someone else's saved edits.
function equalValue(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalValue(a[key], b[key]));
}
export function driverProfilePatch(original, draft) {
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) =>
    !['id', 'location', 'profile_key'].includes(key) && !equalValue(original?.[key], value)
  ));
}
export function mergeSavedDriverProfiles(drivers, saved) {
  for (const driver of saved) {
    const index = drivers.findIndex(d => String(d.id) === String(driver.id));
    if (index < 0) drivers.push(driver);
    else drivers[index] = { ...driver, addedAt: drivers[index].addedAt };
  }
}
