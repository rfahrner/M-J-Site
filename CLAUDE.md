# Claude Instructions for M-J Site

Before doing any work in this repository:

1. Read `AGENTS.md` and follow it as the shared project operating guide.
2. Read `docs/AI_HANDOFF.md` for the latest task context, decisions, and pending work.
3. Read `README.md` and any task-specific documentation relevant to the files you will touch.
4. Treat GitHub as the shared source of truth. Do not rely on information that exists only in a previous Claude conversation.

## Claude-specific workflow

- When using Claude's GitHub integration in a Project or chat, sync the repository before starting significant work.
- When using Claude Code, run it from the repository/branch for the task and inspect the existing implementation before editing.
- Keep edits focused and run `npm run build` after application changes.
- Record meaningful implementation details and unfinished work in `docs/AI_HANDOFF.md` before handing the task back to ChatGPT or the user.

Do not bypass the security, Supabase, data-integrity, branching, or validation rules in `AGENTS.md`.
