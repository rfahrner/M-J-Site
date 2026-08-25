# M-J Site

D&L Transport's internal dispatch web application for load boards, accounting, driver/location analytics, alerts, and verified local archival.

Production site: https://rfahrner.github.io/M-J-Site/

## Stack

- Static HTML, CSS, and JavaScript
- Supabase for Auth, Postgres, Storage, and application data
- Vite for local development and build validation
- GitHub Pages for hosting

## Local development

Use Node.js 22.12 or newer.

```bash
npm ci
npm run dev
```

Vite serves the site on `http://127.0.0.1:5173` by default.

## Build

```bash
npm run build
```

The Vite config automatically includes every top-level `.html` page, so new pages do not need to be manually added to the build configuration. Build output is written to `dist/`.

GitHub Actions runs `npm ci` and `npm run build` on pull requests and pushes to `main`. The CI workflow validates the site; it does not replace the repository's existing GitHub Pages publishing configuration.

## Supabase and secrets

The browser application must use only Supabase publishable/public client credentials. Never place a Supabase `service_role` or other secret key in browser code or commit it to this repository.

Legacy command-line archive scripts under `scripts/` require local environment variables when used. Copy `.env.example` to a local `.env` only if you need those scripts; `.env*` files are ignored by Git except for the example file.

## Archive and historical imports

The supported archive workflow is the browser Archive page, including local export, verification, and exact-record purge controls.

Before loading historical data, read [`docs/HISTORICAL_IMPORT_CONTRACT.md`](docs/HISTORICAL_IMPORT_CONTRACT.md).

## Repository hygiene

Generated dependencies and build output are intentionally not tracked:

- `node_modules/`
- `dist/`
- `.vite/`
- local `.env*` files

Install dependencies from `package-lock.json` with `npm ci` instead of committing generated dependency folders.
