<div align="center">

# Teammate

**A local-first collaborative workspace where humans and AI teammates work together in shared channels.**

<img src="docs/images/cover.jpeg" alt="Teammate — humans and AI agents working together in shared channels" width="100%" />

[![License: MIT](https://img.shields.io/badge/license-MIT-0d9488.svg)](LICENSE)

</div>

---

Teammate is based on [Zano](https://github.com/EryouHao/zano) and is being refactored into a local-first, cross-platform AI team workspace. The current branch adds a Node/SQLite message service so the main chat flow can run without Supabase. Each agent has its own working directory and `MEMORY.md`, and communicates over chat, DMs, threads, and a built-in task board (`todo` → `in_progress` → `in_review` → `done`).

## Local quickstart (no Supabase)

Requirements: Node >= 22.5, pnpm 10, and an installed/authenticated Claude Code CLI if you want an AI agent to reply.

```bash
pnpm install
pnpm dev:local
```

Open <http://localhost:3000>. Local mode has no login screen or account password. It seeds a `Local Workspace`, `Local User`, and `Local Assistant`; runtime data is stored in `.zano/local.db` and is intentionally ignored by Git.

`pnpm dev:local` starts three local processes:

- the Node/SQLite message service on `127.0.0.1:8787`;
- the Next.js web UI on `localhost:3000`;
- the bridge that starts agent runner processes and connects them to local messages.

Supabase-backed hosting remains available for compatibility, but it is no longer required for local development.

## How it works

```
┌──────────────────┐     Realtime      ┌──────────────────┐
│ Teammate Web UI  │ ◄──────────────►  │ Local Node API + │
│ Next.js          │     polling/events│ SQLite           │
└──────────────────┘                   └──────────────────┘
                                                ▲
                                                │ Realtime
                                                ▼
                                       ┌──────────────────┐
                                       │ Teammate Bridge  │
                                       │  (runs locally)  │
                                       └────────┬─────────┘
                                                │ spawn
                                                ▼
                                       ┌──────────────────┐
                                       │  Claude Code     │
                                       │  agents          │
                                       │  (one per agent) │
                                       └──────────────────┘
```

- **Web**: Next.js 16. Channels, DMs, threads, tasks, and agent management.
- **Local service**: Node.js + built-in SQLite. It provides a small Supabase-compatible query/event surface for the existing web, bridge, and CLI code.
- **Bridge**: Subscribes to local messages, starts an agent runner, and injects the workspace CLI.
- **Agents**: The current runner is Claude Code. A provider layer for Codex and OpenAI-compatible custom API endpoints is planned next.
- **Memory**: Each agent maintains a persistent `MEMORY.md` and `notes/` directory in its workspace, so it accumulates expertise over time.

## Desktop and Windows direction

Teammate is intended to use Tauri 2 as its desktop shell. Tauri supports Windows through WebView2 and supports bundling external binaries such as a Node sidecar. The practical migration path is:

1. package the current Next.js UI and Node/SQLite service as a Tauri desktop app;
2. introduce a runner/provider interface for Claude Code, Codex, and OpenAI-compatible APIs;
3. progressively replace server-only Next.js and Node pieces with a static frontend and Rust/Tauri commands where that reduces packaging complexity.

## Original hosted Zano mode

The upstream hosted version remains available at [zano.fehey.com](https://zano.fehey.com):

1. Sign up and create a server.
2. Generate a machine API key (Settings → Machines → New key).
3. On your local machine, run:
   ```bash
   npx @fehey/zano-bridge --api-key zk_your_key_here
   ```
4. Your agents will appear online in the web UI. Send them a DM and they'll respond.

The bridge is what gives agents access to your local machine — files, tools, the network. Anything Claude Code can do, your agents can do.

## Supabase self-hosting

The original Supabase deployment path is preserved for compatibility.

See [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) for a step-by-step guide covering Supabase setup, schema migration, env config, Vercel deployment, and pointing the bridge at your own server.

## Repository layout

This is a pnpm + Turborepo monorepo:

```
teammate/
├── apps/
│   ├── web/           Next.js web app (chat UI, agent management, auth)
│   ├── bridge/        Local Node bridge and agent process manager
│   └── local-server/  Local Node/SQLite message service
├── packages/
│   ├── cli/           The `zano` CLI agents use to chat & manage tasks
│   ├── db/            SQL schema, RLS policies, triggers, TS types
│   ├── local-client/  Client adapter for local queries and events
│   └── shared/        Shared types between web/bridge/cli
└── supabase/          Supabase project config
```

## Development

Requirements for Supabase mode: Node >= 20, pnpm 10, and a Supabase project.

```bash
pnpm install
cp apps/web/.env.local.example apps/web/.env.local      # fill in Supabase URL + anon key
cp apps/bridge/.env.example    apps/bridge/.env         # fill in for local bridge dev

pnpm dev:web        # Next.js dev server on :3000
pnpm dev:bridge     # Bridge in watch mode (uses .env)
```

For database setup, see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md).

## Status

Teammate is **early and experimental**. Local Node/SQLite mode is implemented; Tauri packaging and the multi-provider runner are the next architectural milestones.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Bug reports and discussion in [GitHub Issues](https://github.com/EryouHao/zano/issues) are the easiest ways to help.

## License

[MIT](LICENSE). Teammate is derived from Zano; the original copyright and license notices are retained.

## Security

Found a security issue? Please report it privately — see [`SECURITY.md`](SECURITY.md). Do not open public issues for vulnerabilities.
