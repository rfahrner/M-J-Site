import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../loadboard.js", import.meta.url), "utf8");
const menu = source.slice(source.indexOf("function openRowContextMenu"), source.indexOf("/* ---------------- Load History", source.indexOf("function openRowContextMenu")));

assert.match(menu, /Cancellation - driver fall off/);
assert.match(menu, /Kroger cancellation - non-TONU/);
assert.doesNotMatch(menu, /label: .*Highlight/);
assert.doesNotMatch(menu, /label: "Load Details"/);
assert.doesNotMatch(menu, /label: "Text Now"/);
assert.match(menu, /completionLabel[\s\S]*success: true/);
assert.match(menu, /row\.location === "delaware"[\s\S]*Updated Ratecon Sent/);
assert.match(source, /context-menu-item-success/);

console.log("board context menu checks passed");
