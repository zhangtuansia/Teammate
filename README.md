<div align="center">

# Teammate

**A local-first desktop client where people and AI teammates share conversations, documents, and tasks.**

[English](README.md) · [简体中文](README.zh-CN.md)

[![CI](https://github.com/zhangtuansia/Teammate/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangtuansia/Teammate/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0d9488.svg)](LICENSE)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-111827?logo=apple)](#desktop-quickstart)
[![English & 简体中文](https://img.shields.io/badge/language-English%20%7C%20简体中文-7c3aed)](#language)

<img src="docs/images/screenshots/chat-zh.jpg" alt="Teammate desktop client showing a conversation with a local AI teammate in Simplified Chinese" width="100%" />

</div>

Teammate is an open-source **Tauri desktop client**, not just another hosted chat page. It runs a Node and SQLite core on your computer, starts local AI runtimes for you, and keeps workspace data local by default. An account, a cloud database, and a separate backend are not required for local use.

> Teammate is early and experimental. macOS is the currently validated desktop target; Windows packaging is in progress.

## Why Teammate?

Most AI tools give you a chat box. Teammate gives people and agents a shared place to do the work:

- **Local by default** — conversations, tasks, documents, settings, and agent workspaces stay on your computer.
- **A real desktop client** — one native Tauri app starts the UI, local service, SQLite database, and agent runtime together.
- **Work, not just chat** — turn discussions into assigned tasks, keep active documents beside them, and organize collaboration by channel.
- **Persistent teammates** — each agent has its own workspace and `MEMORY.md`, so useful project context can survive across conversations.
- **Bring your runtime** — Codex is the default; Claude Code and OpenAI-compatible connections are optional.
- **Bilingual UI** — switch between English and Simplified Chinese from Settings.

## Product tour

### Coordinate work with people and agents

Tasks have status, assignee, channel, and parent/subtask relationships. Humans and agents can create, claim, and move work through the same workflow.

<img src="docs/images/screenshots/tasks-zh.jpg" alt="Teammate task board with todo, in progress, in review, and completed columns" width="100%" />

### Keep working documents in the same workspace

Create, edit, pin, group, and import Markdown documents without leaving the client. Generated artifacts remain visible and editable after an agent finishes.

<img src="docs/images/screenshots/documents-zh.jpg" alt="Teammate document workspace with pinned documents and folders" width="100%" />

## Desktop quickstart

### Requirements

- macOS 13 or newer
- Node.js 22.20 or newer
- pnpm 10 or newer
- Rust stable toolchain
- the Bun version pinned in [`.bun-version`](.bun-version), used to package the built-in Pi runtime

### Run the desktop client

```bash
git clone https://github.com/zhangtuansia/Teammate.git
cd Teammate
pnpm install
pnpm desktop:dev
```

The native app opens directly into a local workspace. It starts its own local service and agent runtime, so there is no Teammate sign-up, Supabase account, or separate server command.

Build an installer for the current OS with:

```bash
pnpm desktop:build
```

Artifacts are written to `apps/desktop/src-tauri/target/release/bundle/`. Local and pull-request builds are unsigned test artifacts. Public macOS or Windows releases must be signed, and macOS releases must also be notarized, using the publisher's credentials.

## Browser-based local development

For UI and runtime development without the Tauri shell:

```bash
pnpm install
pnpm dev:local
```

Open <http://localhost:3000/s/local>. This starts:

- the local Node/SQLite service on `127.0.0.1:8787`;
- the Next.js UI on `localhost:3000`;
- the Teammate agent runtime.

Runtime data is stored under `.teammate/` and ignored by Git.

## How it works

```text
Tauri desktop client / Next.js UI
                 │ local queries + events
                 ▼
        Node + SQLite local core
                 │ messages, tasks, documents
                 ▼
          Teammate agent runtime
                 │
                 ├── Codex CLI (default)
                 ├── Claude Code (optional)
                 └── Pi / OpenAI-compatible connections
```

The desktop client treats these pieces as one local product. Existing `/api/bridge/*` endpoints and realtime topics are compatibility protocol details for optional remote workspaces, not separate services a local user needs to manage.

API keys and OAuth tokens are encrypted in a machine-bound credential file with mode `0600`. They are not stored in SQLite or returned to the UI. Each workspace isolates its channels, documents, tasks, and agents; each agent also owns a persistent working directory under `.teammate/agents/`.

For optional Supabase-backed remote workspaces, see [Self-hosting](docs/SELF_HOSTING.md).

## Language

Teammate currently ships with **English** and **Simplified Chinese** UI translations. Change the interface language from **Settings → General → Language**. Contributions that improve either translation—or add another language—are welcome.

## Repository layout

```text
teammate/
├── apps/
│   ├── web/             Shared Next.js UI and hosted-mode routes
│   ├── bridge/          Agent runtime (`@teammate/runtime`)
│   ├── local-server/    Local Node/SQLite message service
│   └── desktop/         Tauri shell and packaged sidecars
├── packages/
│   ├── cli/             CLI used by agents inside Teammate
│   ├── db/              SQL schema, RLS policies, and generated types
│   ├── execution-core/  Provider-neutral agent execution state machine
│   ├── local-client/    Local query and realtime adapter
│   └── shared/          Shared protocol and domain types
└── supabase/            Optional remote-workspace configuration
```

## Useful commands

| Command | Purpose |
| --- | --- |
| `pnpm dev:local` | Run the local service, web UI, and agent runtime |
| `pnpm desktop:dev` | Run the Tauri desktop client in development |
| `pnpm desktop:build` | Build the native app and installer |
| `pnpm dev:web` | Run only the Next.js UI |
| `pnpm dev:runtime` | Run the agent runtime in watch mode |
| `pnpm lint` | Lint all workspaces |
| `pnpm build` | Build all workspaces |

## Project status

Implemented today: local Node/SQLite mode, Tauri packaging, multi-runtime agents, profile and language settings, editable documents, channel agent membership, task assignment, and optional Supabase workspaces.

The project is not yet a stable release. Expect breaking changes while the desktop packaging and cross-platform experience mature.

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture notes, and contribution guidelines.

Please report security vulnerabilities privately using the process in [SECURITY.md](SECURITY.md).

## License

Most Teammate code is available under the [MIT License](LICENSE). The Apache-derived `@teammate/execution-core` package is available under the [Apache License 2.0](packages/execution-core/LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for retained attributions and license details.
