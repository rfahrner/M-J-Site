# AI Handoff Log

Use this file to transfer project state between ChatGPT/OpenAI tools, Claude/Claude Code, and human contributors.

Keep the current task near the top. Summarize completed work rather than pasting entire chat transcripts.

## Current project state

- Repository: `rfahrner/M-J-Site`
- Default branch: `main`
- Production: GitHub Pages
- Front end: static HTML/CSS/JavaScript with Vite build validation
- Backend/data: Supabase Auth, Postgres, Storage, and application data
- Node requirement: 22.12+
- Baseline when this collaboration file was created: `77ba387e63ae20074ff8b8595a723cce29880e31`
- Latest baseline change: preserve driver links during realtime row updates

## Current task

**Task:** Establish a shared ChatGPT + Claude development workflow for M-J Site.

**Agent/tool:** ChatGPT

**Branch:** `ai-collab-bootstrap`

**Files added:**

- `AGENTS.md`
- `CLAUDE.md`
- `docs/AI_HANDOFF.md`

**What changed:**

- Established GitHub as the shared source of truth between assistants.
- Added common workflow, validation, security, Supabase, and data-integrity rules.
- Added Claude-specific startup instructions that point back to the shared rules.
- Added this handoff log for durable context between assistants.

**Validation:** Documentation-only bootstrap; no application behavior changed.

**Known risks / unresolved questions:**

- Claude must still be granted access to `rfahrner/M-J-Site` through Claude's GitHub integration or Claude Code.
- No application feature task has been selected in this handoff yet.

**Recommended next step:**

1. Connect/sync `rfahrner/M-J-Site` in Claude.
2. Merge the collaboration bootstrap after review.
3. Add the first concrete app task here or as a GitHub issue, then let ChatGPT plan/review and Claude implement on a task branch.

---

## Handoff template

### Task

### Agent/tool

### Branch / PR

### Files changed

### What changed

### Validation performed

### Known risks / unresolved questions

### Recommended next step
