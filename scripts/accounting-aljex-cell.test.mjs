import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../accounting.js", import.meta.url), "utf8");

assert.match(source, /class="acct-load-text"[^>]*contenteditable="true"/,
  "ALJEX must be an editable text cell, not a button");
assert.match(source, /data-action="acct-aljex-number"/,
  "ALJEX cell needs a delegated edit target");
assert.match(source, /selectNodeContents\(cell\)/,
  "double-click must select the entire ALJEX value");
/*
 * ALJEX and Trip ID must share the same copy menu.
 *
 * This used to be asserted as the literal line
 *   copyTarget = e.target.closest('.acct-load-text, .trip-chip')
 * which is one implementation of that rule, not the rule. When the Rate
 * Customer / Rate Carrier copy items were added (2026-10-16) the selector was
 * replaced by a data-action lookup, and this went red while the behaviour it
 * guards was intact and better covered than before. Pin the behaviour: the
 * ALJEX cell is a copyable cell, and the Trip ID chip is still a copy target.
 */
const menuSource = fs.readFileSync(new URL('../accounting-trip-id-copy.js', import.meta.url), 'utf8');
assert.match(menuSource, /COPYABLE_CELLS\s*=\s*\{[^}]*'acct-aljex-number'/,
  "the ALJEX cell must still offer Copy from the row menu");
assert.match(menuSource, /closest\('\.trip-chip'\)/,
  "the Trip ID chip must still offer Copy from the same menu");
assert.match(source, /saveAccountingFields\(supabaseClient, rec\.id, \{ aljex_load_number:/,
  "leaving the ALJEX cell must persist the edit");

console.log("accounting ALJEX cell behavior checks passed");
