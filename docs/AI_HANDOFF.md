# AI Handoff Log

Use this file to transfer project state between ChatGPT/OpenAI tools, Claude/Claude Code, and human contributors.

## Current project state

- Repository: `rfahrner/M-J-Site`
- Related mobile repo: `rfahrner/M-J-App`
- Mobile paperwork epic: issue #23
- Active implementation PR: #24 (`paperwork-backend-phase1`)

## Driver paperwork architecture

- M-J-App is a standalone Expo/React Native app; drivers do not use M-J-Site.
- First enrollment uses SMS phone verification; no usernames/passwords.
- Sender identity is the verified phone number only. Do not add sender-name/profile resolution.
- Original sender phone and entered Pro number are immutable audit facts.
- Pro/Aljex numbers are not unique; ambiguous matches must never be guessed.
- Unmatched/ambiguous submissions are accepted and shown as Needs Review.
- Durable originals are stored in the private `paperwork-submissions` bucket, separate from legacy `trip-sheets` because archive purge intentionally cleans up the latter.

## Production Supabase state — deployed 2026-09-08

Project: `ygsapysqzwrpcimgvaqx`

Live migrations:
- `20260908205455_create_paperwork_submissions`
- `20260908205507_allow_internal_paperwork_events`
- `20260908205522_paperwork_staff_actions`
- `20260908205851_paperwork_staff_actions_invoker`
- `20260908205923_paperwork_foreign_key_indexes`

Live objects:
- `paperwork_submissions`
- `paperwork_images`
- `paperwork_notes`
- `paperwork_submission_events`
- private Storage bucket `paperwork-submissions`
- authenticated Edge Function `paperwork-submit` (JWT verification enabled)

Security state:
- RLS enabled on all paperwork tables.
- Phone-authenticated mobile users have no direct paperwork table/storage policies and no M-J operational-table permissions.
- Internal site roles (`dispatcher`, `accounting`, `admin`, `it`) can manage the inbox through role-based RLS.
- Staff assign/delete RPCs are `SECURITY INVOKER`; post-deploy security advisor has no paperwork-specific definer warning.
- Paperwork foreign keys have covering indexes.

## PR #24 site changes

- Adds `Paperwork` to the normal M-J-Site nav.
- Removes the stray top-level `Archive` nav button while leaving `archive.html` and archive functionality intact.
- Adds `paperwork.html` / `paperwork.js` office inbox.
- Inbox supports view, image notes, office notes, exact-load reattach, and soft delete with audit events.
- Adds `paperwork-load-integration.js`, which shows durable mobile-app originals inside the existing Load Details → Trip Sheet Images view without changing the legacy upload flow.
- Duplicate Pro/date matches are not guessed; staff is directed to the Paperwork Inbox.

## Remaining validation

- Merge/deploy PR #24 after final CI.
- Supabase phone login requires phone auth enabled plus an SMS provider; current ChatGPT Supabase tooling cannot inspect hosted Auth provider settings, so confirm in Supabase Auth Providers or with a real phone OTP test.
- Run real-device tests for unique Pro, duplicate Pro, unmatched Pro, reattach, notes, and soft delete.
- Later: retry/offline queue and app-store distribution.
