import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../loadboard.css", import.meta.url), "utf8");
const accountingStyles = css.slice(css.indexOf("#accounting-table-body tr.acct-highlighted"));

assert.match(accountingStyles, /#accounting-table \.acct-load-text[\s\S]*border: 1px solid transparent/);
assert.match(accountingStyles, /#accounting-table \.cell-input:hover,[\s\S]*#accounting-table \.acct-load-text:hover/);
assert.match(accountingStyles, /#accounting-table \.cell-input:focus,[\s\S]*#accounting-table \.acct-load-text:focus/);
assert.match(accountingStyles, /box-shadow: 0 0 0 2px rgba\(47,111,237,0\.15\)/);

console.log("Accounting editable-cell styling checks passed");
