# M-J Site AI Collaboration Guide

This repository is the shared source of truth for work performed with ChatGPT/OpenAI tools, Claude/Claude Code, and human contributors.

## Project

M-J Site is D&L Transport's internal dispatch web application for load boards, accounting, driver/location analytics, alerts, and verified local archival.

### Stack

- Static HTML, CSS, and JavaScript
- Supabase for Auth, Postgres, Storage, and application data
- Vite for local development and build validation
- GitHub Pages for hosting
- Node.js 22.12+

## Read before changing code

1. Read this file.
2. Read `README.md`.
3. Read `docs/AI_HANDOFF.md` for the latest task state and prior-agent notes.
4. Read any task-specific documentation, especially `docs/HISTORICAL_IMPORT_CONTRACT.md` before historical-data work.
5. Inspect the relevant implementation before proposing or making changes. Do not infer database schema, business rules, or existing behavior from filenames alone.

## Shared workflow

GitHub is the coordination layer between AI assistants.

1. Start from the latest repository state.
2. Work on a task branch rather than directly on `main`.
3. Keep changes scoped to the requested task unless a broader change is necessary to make the task correct.
4. Before editing, identify the affected files and behavior.
5. After editing, run the available validation. At minimum for application changes:
   - `npm ci` when dependencies are not already installed
   - `npm run build`
6. Update `docs/AI_HANDOFF.md` with what changed, what was validated, and anything the next agent needs to know.
7. Prefer a pull request for review before merging to `main`.

## Safety and data rules

- Never place a Supabase `service_role` key, private API key, password, token, or other secret in browser code or commit it to the repository.
- Browser code may use only Supabase publishable/public client credentials.
- Do not perform destructive Supabase operations, bulk deletes, archival purges, irreversible migrations, or schema changes unless the task explicitly calls for them and the impact has been checked first.
- Do not invent table names, columns, policies, RPCs, storage buckets, or relationships. Verify them from the code/schema/context available for the task.
- Preserve existing production behavior unless the requested change intentionally modifies it.
- Treat historical/archive workflows as data-integrity-sensitive.
- Avoid broad rewrites when a smaller targeted change solves the problem.

## Division of labor

These are defaults, not hard boundaries:

- **ChatGPT/OpenAI**: requirements clarification, architecture, debugging strategy, data-model reasoning, reviewing diffs/PRs, and translating user intent into implementation plans.
- **Claude/Claude Code**: implementation runs, multi-file edits, refactors, and executing well-defined tasks against the repository.

Either assistant may do either role. The important rule is that decisions and completed work are recorded in GitHub rather than left only inside an AI chat.

## Handoff format

When finishing meaningful work, append or update the current task in `docs/AI_HANDOFF.md` with:

- Task
- Agent/tool
- Branch or PR
- Files changed
- What changed
- Validation performed
- Known risks / unresolved questions
- Recommended next step

If another agent is expected to continue the task, make the handoff specific enough that it does not need access to the previous chat transcript.
