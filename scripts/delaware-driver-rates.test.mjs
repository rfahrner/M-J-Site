import fs from "node:fs";
import assert from "node:assert/strict";

const board = fs.readFileSync("loadboard.js", "utf8");
const rates = fs.readFileSync("boardrates.js", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260917203000_add_delaware_driver_rate_overrides.sql", "utf8");

assert.match(board, /"delaware_rate_overrides": d\.delawareRateOverrides/);
assert.match(board, /id="ad-delaware-rate-section"/);
assert.match(board, /data-ddr-tier-id/);
assert.match(board, /locationKey === "delaware" \? drv\.delawareRateOverrides/);
assert.match(board, /data-rate-setting-key="over_tier_per_mile"/);
assert.doesNotMatch(board, /data-rate-setting-key="flat_minimum"/);
assert.match(board, /t\.dataset\.field === "rate"\) markFieldDirty\(dirtyShiftFields, rowId, "rateManual"\)/);
assert.match(board, /markFieldDirty\(dirtyShiftFields, row\.id, "rateManual"\)/);
assert.match(board, /markFieldDirty\(dirtyShiftFields, row\.id, "rateOverrides"\)/);
assert.match(rates, /location === "delaware"\) return drv\?\.delawareRateOverrides/);
assert.match(rates, /locationKey !== "atlanta" && locationKey !== "delaware"/);
assert.match(migration, /add column if not exists delaware_rate_overrides jsonb/i);

console.log("Delaware driver-rate and manual-rate regression checks passed.");
