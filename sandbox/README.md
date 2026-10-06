# Browser sandbox

Runs the real pages in real Chromium against a fake Supabase, so a patch can be
exercised before it goes near production.

```bash
node sandbox/serve.mjs . 8787 &     # serves the repo exactly as Pages does
node sandbox/board-scroll.spec.mjs  # board holds its scroll position
node sandbox/text-group.spec.mjs    # Text a Group modal opens and behaves
```

## Why this exists alongside scripts/

Every test in `scripts/` runs in **jsdom, which has no layout engine**. Scroll
positions are always 0, every bounding box is zero, and nothing has a height.
A whole class of bug — the page jumping, a modal resizing as you click, a
column flickering, a picker covering the text you are typing — is invisible
there by construction. Those are also the bugs dispatchers notice first.

This does not replace `scripts/`. Those are fast, run in CI, and pin logic.
These are slower and pin what the screen does.

## How the fake works

`fake-supabase.js` is served **in place of** `supabase.min.js` via Playwright
route interception. `addInitScript` is not enough on its own: the real bundle
loads afterwards and overwrites `window.supabase`, and the real GoTrue client
then redirects to `login.html` because the sandbox has no session.

It answers `from()` out of `window.__SANDBOX_ROWS` (see `fixtures.mjs`),
reports a signed-in dispatcher, and **records realtime handlers** so a test can
replay another dispatcher's edit arriving mid-keystroke:

```js
await page.evaluate(() => window.__sandboxEmit('loads_shifts',
  { eventType: 'UPDATE', new: { id: 1005, pro_number: 'PRO9005' }, old: { id: 1005 } }));
```

That condition — a remote change landing while someone is typing — is behind
several of the bugs in CLAUDE.md and cannot be staged any other way.

## The board scrolls in `.grid-scroll`, not the window

`window.scrollY` barely moves on the board; the rows live in a `.grid-scroll`
container with its own `scrollTop`. Assert against that, or a jump of several
rows will read as zero drift.

## scroll-tracer.js

For bugs that only happen on live data. Paste it into the console on the real
board, use the board until it jumps, then run `__whyDidItMove()`. It records
every `scrollIntoView`, `scrollTop` write, `focus()` without `preventScroll`,
and `window.scrollTo/By`, with the stack that asked for it. Observe-only;
reload to remove.
