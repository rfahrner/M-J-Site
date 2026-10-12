/*
 * Regression test: nothing the browser ships may hardcode the host.
 *
 * Found while planning the move off GitHub Pages (2026-10-12). Two places
 * had the production origin written into them, and one of them is worse than
 * a broken page:
 *
 *   preshift-pro-text.js
 *     CARRIER_DOCS_URL = 'https://rfahrner.github.io/M-J-Site/driver/'
 *
 * That string is TEXTED TO A DRIVER -- "submit your paperwork to <url>".
 * Move host, or take the repository private so Pages stops serving, and
 * every driver texted gets a dead link and stops submitting paperwork.
 * Nothing on our side reports it; it reads as drivers being slow.
 *
 * The fix is to derive it from where the page is actually served, which is
 * a no-op on the current host. This test keeps the next one from being
 * written down instead.
 *
 * Run: node scripts/no-hardcoded-host.test.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';

const root = new URL('../', import.meta.url);
let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// Everything served to a browser. Not scripts/, sandbox/ or supabase/: the
// edge functions legitimately keep an origin ALLOWLIST, which is the whole
// point of them, and the tests talk about the hosts on purpose.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'scripts', 'sandbox', 'supabase', 'docs', 'deploy', 'public', 'Claude outputs', 'back-ups', 'imports']);
function shipped(dir = '.', out = []) {
  for (const name of readdirSync(new URL(dir, root))) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const rel = dir === '.' ? name : `${dir}/${name}`;
    if (statSync(new URL(rel, root)).isDirectory()) shipped(rel, out);
    else if (/\.(js|html|css|webmanifest)$/.test(name) && !name.endsWith('.min.js')) out.push(rel);
  }
  return out;
}

const files = shipped();
check('found the shipped files to scan', files.length > 50, `${files.length} files`);

// A deployed origin baked into shipped code. Allows relative paths, and
// allows other people's domains (CDNs, Supabase) -- only OUR host is the
// problem, because only ours moves.
const OUR_HOSTS = /https?:\/\/(?:[a-z0-9-]+\.)*(?:github\.io|pages\.dev|vercel\.app)/gi;

const offenders = [];
for (const rel of files) {
  const src = readFileSync(new URL(rel, root), 'utf8');
  src.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|<!--)/.test(line)) return; // a comment may name the old host
    const hit = line.match(OUR_HOSTS);
    if (hit) offenders.push(`${rel}:${i + 1} ${hit[0]}`);
  });
}
check('no shipped file hardcodes our own host', offenders.length === 0, offenders.join(' | '));

// The specific one that reaches a driver, pinned by name: a link in an
// outgoing text must be derived, never written down.
const preshift = readFileSync(new URL('preshift-pro-text.js', root), 'utf8');
check('the Carrier Docs link is derived from the serving page',
  /new URL\('\.\/driver\/', document\.baseURI\)/.test(preshift), true);
check('and is still what goes in the message',
  /Carrier Docs app: \$\{CARRIER_DOCS_URL\}/.test(preshift), true);

/*
 * The other half is server-side and cannot be derived: the edge function has
 * to know which origins to accept. It is checked here so the cutover list
 * and the code cannot drift -- a new domain that loads the PWA but has its
 * uploads refused is a silent failure for the driver, not for us.
 */
const fn = readFileSync(new URL('supabase/functions/paperwork-pwa-submit/index.ts', root), 'utf8');
const allowed = [...fn.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
check('the paperwork function still allowlists the current host',
  allowed.some((o) => o.includes('github.io')), true, allowed.join(', '));
console.log(`\n  note: ALLOWED_ORIGINS is ${allowed.join(', ')}`);
console.log('  a new domain must be added there by hand -- see docs/HOSTING_CUTOVER.md');

console.log(failures ? `\n  ${failures} check(s) FAILED\n` : '\n  All checks passed.\n');
process.exit(failures ? 1 : 0);
