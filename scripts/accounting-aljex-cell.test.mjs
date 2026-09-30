import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../accounting.js", import.meta.url), "utf8");

assert.match(source, /class="acct-load-text"[^>]*contenteditable="true"/,
  "ALJEX must be an editable text cell, not a button");
assert.match(source, /data-action="acct-aljex-number"/,
  "ALJEX cell needs a delegated edit target");
assert.match(source, /selectNodeContents\(cell\)/,
  "double-click must select the entire ALJEX value");
assert.match(source, /copyTarget = e\.target\.closest\('\.acct-load-text, \.trip-chip'\)/,
  "ALJEX and Trip ID must share the same copy menu");
assert.match(source, /saveAccountingFields\(supabaseClient, rec\.id, \{ aljex_load_number:/,
  "leaving the ALJEX cell must persist the edit");

console.log("accounting ALJEX cell behavior checks passed");
