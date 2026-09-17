import fs from "node:fs";
import assert from "node:assert/strict";

const js = fs.readFileSync("loadboard.js", "utf8");
const html = fs.readFileSync("dalaware.html", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260917195500_delaware_multiple_daily_boards.sql", "utf8");

assert.match(js, /DELAWARE_BOARDS_TABLE = "delaware_daily_boards"/);
assert.match(js, /delaware_board_slot: locationKey === "delaware"/);
assert.match(js, /boards\.length >= 2/);
assert.match(js, /data-add-load-to-board/);
assert.match(html, /Is this a <strong>SCHNEIDER<\/strong> load board\?/);
assert.match(html, /\+ Add Another Load Board/);
assert.match(migration, /2026-09-17'[\s\S]*then 'schneider'/i);
assert.match(migration, /where location = 'delaware'/);

console.log("Delaware multi-board regression checks passed.");
