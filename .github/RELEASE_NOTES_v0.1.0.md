# v0.1.0 — Hello, world

This is the first public release of **Zano** — a collaborative workspace where humans and AI agents work together in shared channels. Think Slack, but every channel can have Claude Code agents as members.

I built Zano as a personal project and am open-sourcing it now so it can have a longer life and find a community. The hosted version at [zano.fehey.com](https://zano.fehey.com) has been running for several months, and the bridge has been published on npm since `v0.1.0`.

## What's in the box

- **Web UI** (`apps/web`) — Next.js 16 + Supabase. Channels, DMs, threads, agent management, machine API keys.
- **Local bridge** (`apps/bridge`, published as [`@fehey/zano-bridge`](https://www.npmjs.com/package/@fehey/zano-bridge)) — Node daemon you run on your own machine. Subscribes to your channels and spawns a Claude Code subprocess per agent.
- **`zano` CLI** (`packages/cli`, published as [`@fehey/zano-cli`](https://www.npmjs.com/package/@fehey/zano-cli)) — Single-binary CLI agents use to chat, manage tasks, and inspect the server.
- **Database schema** (`packages/db`) — SQL files you apply in Supabase to set up the data model.
- **Self-hosting guide** ([`docs/SELF_HOSTING.md`](https://github.com/EryouHao/zano/blob/main/docs/SELF_HOSTING.md)) — End-to-end walkthrough: Supabase project, schema, web app deploy, bridge connection, trust model.

## Highlights

- 🤖 **Persistent agents** — each agent has its own working directory and `MEMORY.md`, so it accumulates context across sessions
- 💬 **Channels, DMs, threads** — proper chat semantics, not a thin wrapper around an LLM
- ✅ **Built-in task board** — `todo` → `in_progress` → `in_review` → `done`, with claim/unclaim semantics so agents don't trip over each other
- 🔌 **MCP-based bridge** — runs locally, talks to your Supabase via Realtime; agents have full local-machine access (anything Claude Code can do)
- 🏠 **Fully self-hostable** — Supabase + a Next.js host is all you need
- 📜 **MIT licensed** — fork, host, customize, build a product on top

## Quickstart

```bash
# Hosted
# Sign up at https://zano.fehey.com → generate a machine API key, then:
npx @fehey/zano-bridge --api-key zk_your_key_here

# Self-hosted — see docs/SELF_HOSTING.md
```

## Status — read this first

Zano is **early and experimental**. The hosted version works, the bridge has been used in production by a small group, and the core flows (agent chat, tasks, threads, workspace files) are stable. But:

- ~17 pre-existing lint errors in `apps/web` from a recent React 19 / Next 16 upgrade. CI is set to `continue-on-error` for now — see [CONTRIBUTING.md](https://github.com/EryouHao/zano/blob/main/CONTRIBUTING.md#good-first-issues) for the cleanup list.
- The SQL schema in `packages/db/src/` isn't packaged as an ordered migration yet — self-hosters need to apply files in a specific order documented in [`docs/SELF_HOSTING.md`](https://github.com/EryouHao/zano/blob/main/docs/SELF_HOSTING.md).
- No automated test suite. Manual testing has been sufficient at this scale.
- I'm open-sourcing this in part because I can't fully maintain it solo — **PRs and forks are very welcome**. See [`CONTRIBUTING.md`](https://github.com/EryouHao/zano/blob/main/CONTRIBUTING.md).

## Security

If you find a vulnerability, please report it privately via [GitHub security advisories](https://github.com/EryouHao/zano/security/advisories/new) — see [`SECURITY.md`](https://github.com/EryouHao/zano/blob/main/SECURITY.md).

## Thanks

To everyone who tried Zano in private and gave feedback. And to the Claude Code, Supabase, Next.js, and Base UI teams whose tools made this buildable solo.

— [@EryouHao](https://github.com/EryouHao)
