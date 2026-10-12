/*
 * The site's URLs must keep their ".html".
 *
 * Seventeen served modules decide which board they are on by reading the
 * filename straight out of the URL:
 *
 *     location.pathname.split('/').pop()   ->  "houston.html"
 *
 * and comparing it against literals ending in ".html". Cloudflare's DEFAULT
 * static-asset routing ("auto-trailing-slash") serves houston.html at
 * /houston. Every one of those comparisons would then match nothing and
 * quietly do nothing: the pre-shift texting, the nav highlight, the Houston
 * load details, the Mondelez row layout, the Delaware rate tiers, the
 * accounting route images. No error anywhere -- a board that has forgotten
 * where it is.
 *
 * So wrangler.jsonc pins html_handling:"none". This test fails if that is
 * ever relaxed while any file still reads the filename, and prints the
 * files at stake so the next person can see the cost before changing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const STRIPS_EXTENSION = new Set([
  'auto-trailing-slash',
  'force-trailing-slash',
  'drop-trailing-slash',
]);

function config() {
  const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

function filesReadingTheFilename() {
  const root = new URL('../', import.meta.url);
  const skip = new Set(['node_modules', 'dist', 'sandbox', 'scripts', '_site', '.git', 'public', 'Claude outputs']);
  const hits = [];
  for (const name of readdirSync(root)) {
    if (skip.has(name) || !name.endsWith('.js')) continue;
    const src = readFileSync(new URL(name, root), 'utf8');
    if (/location\.pathname\.split\(/.test(src) && /\.html['"]/.test(src)) hits.push(name);
  }
  return hits.sort();
}

test('wrangler keeps ".html" in the URL', () => {
  const assets = config().assets;
  assert.ok(assets, 'wrangler.jsonc must declare assets');
  const at_risk = filesReadingTheFilename();
  assert.ok(
    !STRIPS_EXTENSION.has(assets.html_handling),
    `html_handling is "${assets.html_handling}", which strips ".html" from the URL.\n` +
    `${at_risk.length} served file(s) read the filename out of location.pathname and\n` +
    `compare it against ".html" literals; every one would silently stop matching:\n` +
    at_risk.map((f) => `  - ${f}`).join('\n'),
  );
  assert.equal(assets.html_handling, 'none');
});

test('the directory-index shim exists, because /driver/ is texted to drivers', () => {
  const cfg = config();
  assert.equal(cfg.main, 'deploy/worker.js', 'html_handling:"none" also disables directory indexes');
  const worker = readFileSync(new URL('../deploy/worker.js', import.meta.url), 'utf8');
  assert.match(worker, /index\.html/, 'the shim must map a directory path to its index.html');
  assert.match(worker, /ASSETS/, 'it must serve through the assets binding, not refetch over HTTP');
});

test('the staged site never publishes the wrangler config or the worker', () => {
  const stage = readFileSync(new URL('../deploy/stage-site.sh', import.meta.url), 'utf8');
  for (const must of ['./wrangler.jsonc', './deploy', './.wrangler', './.gitignore']) {
    assert.ok(stage.includes(`--exclude='${must}'`), `stage-site.sh must exclude ${must}`);
  }
});

test('the filename readers are still there -- if this ever hits zero, revisit the rule', () => {
  const found = filesReadingTheFilename();
  assert.ok(found.length >= 10, `expected the filename-reading pattern to be widespread, found ${found.length}`);
});
