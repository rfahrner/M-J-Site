/*
 * Regression test for archive-image-urls.js.
 *
 * This module decides whether a route image that storage could not sign is
 * recoverable from the archive. Two of its rules are easy to get backwards and
 * both fail quietly:
 *
 *   - A path with no archived copy must be remembered as a miss, or every board
 *     redraw asks the server about it again, forever.
 *   - A FAILED lookup must NOT be remembered, or one blip hides a picture that
 *     is really there until the tab is reloaded.
 *
 * Run: npm i --no-save jsdom && node scripts/archive-image-urls.test.mjs
 */

import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;

let failures = 0;
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); failures++; }
}

const client = { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } };

let calls = 0;
let nextResponse = null;
global.fetch = async () => {
  calls += 1;
  if (nextResponse instanceof Error) throw nextResponse;
  return { ok: true, json: async () => nextResponse };
};

// The site ships as plain .js files while package.json says commonjs, so the
// module cannot be imported by its own path from here. Copy it to a .mjs and
// load that -- it is the same source, byte for byte.
const moduleSource = readFileSync(new URL('../archive-image-urls.js', import.meta.url), 'utf8');
const scratch = join(mkdtempSync(join(tmpdir(), 'archive-url-test-')), 'archive-image-urls.mjs');
writeFileSync(scratch, moduleSource);

const { resolveArchivedImageUrls, forgetArchivedImageUrls } =
  await import(pathToFileURL(scratch).href);

// ---------------------------------------------------------------------------
console.log('\n1. a hit is returned and then served from cache');
nextResponse = { urls: [{ bucket: 'trip-sheets', path: 'a.jpg', url: 'https://example/a' }] };
let found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'a.jpg' }]);
check('the archived url comes back', found.get('trip-sheets\na.jpg'), 'https://example/a');
check('one request was made', calls, 1);

found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'a.jpg' }]);
check('the second ask is served from cache', calls, 1);
check('and still returns the url', found.get('trip-sheets\na.jpg'), 'https://example/a');

// ---------------------------------------------------------------------------
console.log('\n2. a genuine miss is remembered, so the board stops asking');
nextResponse = { urls: [{ bucket: 'trip-sheets', path: 'gone.jpg', url: null }] };
found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'gone.jpg' }]);
check('a miss returns nothing', found.has('trip-sheets\ngone.jpg'), false);
check('a request was made', calls, 2);
await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'gone.jpg' }]);
check('the miss is not asked about again', calls, 2);

// ---------------------------------------------------------------------------
console.log('\n3. a FAILED lookup is not remembered as a miss');
nextResponse = new Error('network down');
found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'flaky.jpg' }]);
check('the failure yields nothing this time', found.size, 0);
check('a request was attempted', calls, 3);

nextResponse = { urls: [{ bucket: 'trip-sheets', path: 'flaky.jpg', url: 'https://example/flaky' }] };
found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'flaky.jpg' }]);
check('it is retried rather than written off', calls, 4);
check('and the image is found on the retry', found.get('trip-sheets\nflaky.jpg'), 'https://example/flaky');

// ---------------------------------------------------------------------------
console.log('\n4. signed out asks nothing');
const anon = { auth: { getSession: async () => ({ data: { session: null } }) } };
const before = calls;
found = await resolveArchivedImageUrls(anon, [{ bucket: 'trip-sheets', path: 'z.jpg' }]);
check('no request without a session', calls, before);
check('and nothing is returned', found.size, 0);

// A signed-out miss must not poison the cache for when they sign back in.
nextResponse = { urls: [{ bucket: 'trip-sheets', path: 'z.jpg', url: 'https://example/z' }] };
found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'z.jpg' }]);
check('the same path works once signed in', found.get('trip-sheets\nz.jpg'), 'https://example/z');

// ---------------------------------------------------------------------------
console.log('\n5. a finished backup run clears the cache');
forgetArchivedImageUrls();
const afterClear = calls;
nextResponse = { urls: [{ bucket: 'trip-sheets', path: 'a.jpg', url: 'https://example/a2' }] };
found = await resolveArchivedImageUrls(client, [{ bucket: 'trip-sheets', path: 'a.jpg' }]);
check('a previously cached path is looked up again', calls, afterClear + 1);
check('and picks up its new url', found.get('trip-sheets\na.jpg'), 'https://example/a2');

// ---------------------------------------------------------------------------
console.log('\n6. rubbish input is ignored rather than sent');
const beforeJunk = calls;
found = await resolveArchivedImageUrls(client, [{ bucket: '', path: '' }, null, undefined]);
check('nothing is requested for empty items', calls, beforeJunk);
check('and nothing comes back', found.size, 0);
check('no client at all is handled', (await resolveArchivedImageUrls(null, [{ bucket: 'b', path: 'p' }])).size, 0);

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
