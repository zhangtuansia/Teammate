# Teammate v0.1.0

Teammate is a local-first workspace where people and AI teammates collaborate in shared channels, documents, and tasks.

## Included

- A Next.js chat workspace with channels, DMs, threads, and agent management.
- A Tauri desktop app backed by a local Node service and SQLite database.
- Agent runtime source for optional remote workspaces.
- The `teammate` CLI used by agents for messages, tasks, and workspace context.
- A Supabase schema and self-hosting guide.

## Highlights

- Persistent agents with isolated workspaces and memory.
- Shared channels that can include multiple AI teammates.
- Linear-style tasks with status, assignee, and subtask relationships.
- Workspace-scoped documents with reading and editing modes.
- Codex as the default runtime, with other engines available by explicit choice.

## Quick start

```bash
pnpm install
pnpm dev:local
```

For an optional remote runtime:

```bash
pnpm dev:runtime -- --api-key tm_your_key_here
```

The runtime and CLI are workspace packages and are not yet published as
standalone npm registry releases. Use them from this repository until a package
release is announced.

Teammate remains experimental. Review [SECURITY.md](../SECURITY.md) before connecting an agent runtime to a workspace with sensitive files.
