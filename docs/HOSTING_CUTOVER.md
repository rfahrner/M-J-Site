# Moving the site off GitHub Pages → Cloudflare Pages

## Why Cloudflare and not Vercel

Vercel's Hobby plan is **non-commercial only**, in their own words: *"All
commercial usage of the platform requires either a Pro or Enterprise plan,"*
where commercial means any deployment serving *"the financial gain of anyone
involved in any part of the production of the project, including a paid
employee… writing the code."* An internal dispatch board for a freight company
is squarely inside that, whichever way it is deployed. Vercel Pro is $20/mo.

Cloudflare Pages' free plan has no such restriction, supports private
repositories, and gives unlimited preview deployments — the sandbox this move
is for. 500 builds/month, which for a copy step is effectively unlimited.

Note also: **GitHub Pages on a private repository requires GitHub Pro.** On the
free plan, making the repo private stops the Pages site serving. That is fine
once Cloudflare is live, but it means Pages cannot be kept as a fallback
sandbox after the repo goes private.

## The rule: copy, never build

`index.html` loads `loadboard.js` directly. **The site ships source** — Pages
serves the repository root verbatim and `vite build` has never produced a
deploy artifact. Any host that bundles this repo emits
`assets/loadboard-<hash>.js`, which breaks every `<script src>` across nine
pages AND makes `site-version-watch.js` HEAD a path that 404s — silently
switching off the protection that ended the 9,443-row rate-churn incident.

`deploy/stage-site.sh` is therefore a **copy**: every path stays exactly where
it is. It works by deleting internals from a full tree rather than listing
what to keep, because getting an allowlist wrong takes a page off a live
dispatch board while getting the exclusions wrong just publishes a file nobody
reads. It then asserts both halves — the entry points survived, the internals
did not — and fails the build rather than deploying a broken site.

## Cloudflare setup

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git →
   `rfahrner/M-J-Site`.
2. **Build command:** `bash deploy/stage-site.sh _site`
3. **Build output directory:** `_site`
4. **Framework preset:** None.
5. Deploy. It takes seconds — nothing is compiled.

## The two origin changes that are not optional

Both fail *silently, on the driver's side*, which is why they are listed first.

### 1. The Carrier Docs link texted to drivers

`preshift-pro-text.js` sends drivers to the paperwork PWA by URL, inside an
actual text message. It used to be the literal Pages URL; it now derives from
whatever host serves the board, so it follows the move on its own and needs no
edit. `scripts/no-hardcoded-host.test.mjs` keeps the next one from being
written down.

### 2. `paperwork-pwa-submit` ALLOWED_ORIGINS — **you must edit this**

`supabase/functions/paperwork-pwa-submit/index.ts` holds a server-side origin
allowlist. It cannot be derived. Today:

    https://rfahrner.github.io
    https://app.carrierdocs.com
    http://127.0.0.1:5173
    http://localhost:5173

**Add the new domain and redeploy the function**, or the PWA loads for the
driver and their upload is refused by CORS — which looks, from here, like a
driver who did not submit. (`app.carrierdocs.com` is already allowed; if that
is the intended home for the driver app, point the texts there.)

### 3. Supabase Auth → URL Configuration

Add the production domain to **Site URL** and **Redirect URLs**, or login and
password reset break. For previews to be usable signed in, add a wildcard:
`https://*.m-j-site.pages.dev/**`.

## Verify before moving DNS

Run both hosts in parallel. On the Cloudflare URL:

- [ ] `curl -I https://<url>/loadboard.js` → **200** with an **ETag**. This is
      the stale-tab protection; the console now says so if it cannot read one.
- [ ] Sign in. Reset a password.
- [ ] Open a board, type in a driver cell, confirm it saves.
- [ ] Send a text from an alert.
- [ ] `https://<url>/CLAUDE.md` → **404**, and `/supabase/` → 404.
- [ ] `https://<url>/driver/` loads the PWA, and a paperwork submission from it
      actually succeeds (this is the CORS one).
- [ ] Open a PR; open its preview URL; sign in on it.

## Order of operations

1. Cloudflare Pages up and verified, repo still public, Pages still live.
2. Edge function origins updated; Supabase auth URLs updated.
3. DNS moved.
4. Watch a full dispatch day.
5. **Then** take the repo private — this is also when GitHub Pages stops.

## What is already public

Pages serves the repo root, so `CLAUDE.md`, every migration and the whole test
suite are readable on the live site today — confirmed 2026-10-12 against
`rfahrner.github.io/M-J-Site/CLAUDE.md`. No secrets are in any of them; none
are committed. `deploy/stage-site.sh` stops publishing them on the new host,
and taking the repo private closes the rest.
