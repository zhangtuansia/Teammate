<div align="center">

# Teammate

**A local-first workspace where people and AI teammates share conversations, documents, and tasks.**

<img src="docs/images/cover.jpeg" alt="Teammate — people and AI teammates working together" width="100%" />

[![License: MIT](https://img.shields.io/badge/license-MIT-0d9488.svg)](LICENSE)

</div>

Teammate is a Tauri desktop app with a local Node/SQLite core. It works without an account or cloud database: conversations, agent workspaces, documents, and tasks stay on the computer by default.

The product is intentionally small:

- shared channels and direct conversations with AI teammates;
- editable workspace documents for generated and active artifacts;
- a Linear-style task list with status, assignee, and parent/subtask relationships;
- persistent agent workspaces with `MEMORY.md`;
- Codex as the default runtime, with Claude Code and custom API connections available as optional engines.

## Desktop quickstart

Requirements: macOS 13+, Node >= 22.20, pnpm 10+, the Rust stable toolchain,
and the Bun version pinned in `.bun-version` (used to package the built-in Pi runtime).

```bash
pnpm install
pnpm desktop:dev
```

This opens the native Tauri window directly in `/s/local`. The desktop app starts its own local service and agent runtime; there is no Teammate login or registration step, and no Supabase account or separate server command is required.

The development app is isolated from an installed Teammate release: it uses the `com.teammate.desktop.dev` identifier, port `8788`, and a separate application-data directory. This prevents `tauri dev` from migrating or writing the installed app's SQLite database.

Build a native installer with:

```bash
pnpm desktop:build
```

Artifacts are written below `apps/desktop/src-tauri/target/release/bundle/`.
Local and pull-request builds are unsigned test artifacts. Public macOS or Windows
releases must be signed (and macOS releases notarized) with the publisher's own
credentials.

## Browser-based local development

```bash
pnpm install
pnpm dev:local
```

Open <http://localhost:3000/s/local>. Local mode seeds a `Local Workspace`, `Local User`, and Codex-backed `Local Assistant`. Runtime data is stored under `.teammate/` and ignored by Git.

`pnpm dev:local` starts:

- the local Node/SQLite service on `127.0.0.1:8787`;
- the Next.js UI on `localhost:3000`;
- the Teammate agent runtime that starts and manages local agents.

## Architecture

```text
Tauri / React UI
       │ local queries + events
       ▼
Node + SQLite local core
       │ messages, tasks, activity
       ▼
Teammate agent runtime
       │
       ├── Codex CLI
       ├── Claude Code (optional)
       └── Pi / custom API connections
```

The desktop product treats this as one local core. The runtime is not a separate user-facing “bridge.” The existing `/api/bridge/*` endpoints and realtime topic names remain compatibility protocol details for optional remote workspaces.

## Settings and data

Settings include profile, language, appearance, models and connections, runtimes, chat feedback, and diagnostics. API keys and OAuth tokens are encrypted in a machine-bound credential file with mode `0600`; they are not stored in SQLite or returned to the UI.

Each workspace isolates its channels, documents, tasks, and agents. Each agent also owns a persistent working directory under `.teammate/agents/`.

## Repository layout

```text
teammate/
├── apps/
│   ├── web/           Shared Next.js web UI and hosted-mode routes
│   ├── bridge/        Agent runtime source (`@teammate/runtime`)
│   ├── local-server/  Local Node/SQLite core
│   └── desktop/       Tauri shell and packaged sidecars
├── packages/
│   ├── cli/           `teammate` CLI used by agents
│   ├── db/            SQL schema, RLS policies, and triggers
│   ├── execution-core/ Provider-neutral agent execution state machine
│   ├── local-client/  Local query and realtime adapter
│   └── shared/        Shared protocol and domain types
└── supabase/          Optional hosted-workspace configuration
```

## Useful commands

```bash
pnpm dev:local
pnpm desktop:dev
pnpm desktop:build
pnpm dev:web
pnpm dev:runtime
pnpm build
pnpm lint
```

For optional Supabase hosting, see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Status

Teammate is early and experimental. Local Node/SQLite mode, Tauri packaging, multi-runtime agents, profile settings, editable documents, channel agent membership, and task assignment are implemented. macOS is the currently validated desktop target.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## License

Most Teammate code is distributed under the [MIT License](LICENSE). The
Apache-derived `@teammate/execution-core` package is distributed under the
[Apache License 2.0](packages/execution-core/LICENSE). See
[Third-party notices](THIRD_PARTY_NOTICES.md) for retained attributions and
license details.
