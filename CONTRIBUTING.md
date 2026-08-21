# Contributing to Teammate

Thanks for your interest in Teammate. It is a local-first workspace where humans and AI teammates collaborate through chat, documents, and tasks.

- **Issues and discussion are welcome any time.** Bug reports, feature ideas, "is this how I'm supposed to use it?" — all useful.
- **Small focused PRs are the easiest to land.** Bug fixes, doc improvements, dependency bumps, small UX polish — go for it.
- **For larger changes, open an issue first.** This protects your time more than mine — I want to make sure the direction makes sense before you write a lot of code.
- **Response time will vary.** I may not get to things immediately. That's not a reflection of how much I appreciate the contribution.

## Setup

```bash
pnpm install
pnpm dev:local
```

Requirements: Node >= 22.5 and pnpm 10. Codex is the default local agent runtime. Supabase is optional.

## Project layout

See the [README](README.md#repository-layout) for the monorepo overview. The most useful files when getting oriented:

- `apps/local-server/src/index.ts` — local Node/SQLite message service and seed data.
- `packages/local-client/src/index.ts` — compatibility client used by web, runtime, and CLI in local mode.
- `packages/db/src/schema.sql` — Supabase database schema retained for hosted mode.
- `apps/bridge/src/bridge.ts` — main agent runtime loop. Subscribes to messages, starts agents, and routes messages.
- `apps/bridge/src/system-prompt.ts` — the prompt that defines how agents behave inside Teammate.
- `apps/web/src/app` — Next.js App Router routes, including the chat UI under `(chat)`.
- `packages/cli/src/index.ts` — the `teammate` CLI agents use to talk to the platform.

## Coding conventions

- TypeScript everywhere. No `any` unless you have a comment explaining why.
- Tailwind for styling. We use Radix UI Colors (sand scale) — check `apps/web/src/app/globals.css` for the palette.
- For UI components, prefer composition over new primitives. We use Base UI (`@base-ui/react`) and a few shadcn-derived components in `apps/web/src/components/ui`.
- Keep PRs focused. Don't bundle "cleanup the surrounding area" with feature changes.

## Testing

There are no automated tests yet. If you're adding non-trivial logic, especially in the agent runtime or CLI, consider adding focused tests; Vitest is a reasonable default.

For UI changes, please test in a browser before submitting and call out anything that needs visual verification in the PR description.

## Good first issues

A few low-risk things that would be genuinely helpful and don't require deep context:

- **Clean up pre-existing lint errors in `apps/web`.** A recent React 19 / Next 16 upgrade surfaced ~17 errors and ~18 warnings (mostly `react-hooks/purity` and `react-hooks/exhaustive-deps`). CI currently runs lint with `continue-on-error: true` — once these are cleaned up, we can flip it back to blocking.
- **Consolidate the SQL files in `packages/db/src/` into a single ordered migration** so self-hosters don't have to apply files in a specific order (see [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md)).
- **Wire up Supabase CLI migrations** so schema changes are version-controlled rather than manually applied.
- **Add a small Vitest setup** with one or two example tests in `packages/cli` to make the testing path easier for future contributors.

## Commits and PRs

- Conventional-commit-ish style (`feat:`, `fix:`, `chore:`, `docs:`) is appreciated but not enforced.
- A short PR description with **what** and **why** is more important than ceremony.
- Link to the related issue if there is one.

## Questions

If something is unclear, open a [discussion](https://github.com/zhangtuansia/Teammate/discussions) or file an issue with the `question` label.

Thanks for being here.
