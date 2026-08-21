# AGENTS.md

Context for AI coding assistants working in this repo. For human contributors, start with the [README](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

Teammate is a local-first workspace where humans and AI teammates share channels, documents, and tasks. Its agent runtime supports Codex, Claude Code, and OpenAI-compatible models. Local mode uses Tauri, Node, and SQLite; an optional Supabase mode supports remote workspaces.

## Repo shape

```
apps/web/        Next.js 16 web UI + auth + runtime bootstrap API
apps/bridge/     Agent runtime source (@teammate/runtime package)
apps/local-server/ Local Node/SQLite message service
apps/desktop/    Tauri 2 + Vite/React desktop shell and Node sidecar packaging
packages/cli/    The `teammate` CLI agents use to chat and manage tasks
packages/db/     SQL schema, RLS, triggers, generated TS types
packages/local-client/ Supabase-compatible local query/event adapter
packages/shared/ Types shared between web/runtime/cli
supabase/        Supabase project config (config.toml only — no migrations)
```

Tooling: pnpm 10 workspaces + Turborepo. Node >= 22.5 for local SQLite mode.

## Where things live

- **Database schema**: `packages/db/src/schema.sql` is the source of truth. Apply via Supabase SQL editor. RLS lives in the same file plus `fix-rls.sql`.
- **Auto-onboarding trigger**: `packages/db/src/onboarding-trigger.sql` — runs on every new profile to create a default agent + channel.
- **Agent runtime entry point**: `apps/bridge/src/index.ts` → `bridge.ts`. Subscribes to channels and starts the selected local agent engine through `agent-manager.ts`.
- **Desktop entry points**: `apps/desktop/src/main.tsx` → `app.tsx`; Tauri lifecycle is in `apps/desktop/src-tauri/src/lib.rs`, and packaged Node entry is `apps/desktop/sidecar/runtime.ts`.
- **Desktop settings**: `apps/desktop/src/settings.tsx` provides the settings center; shared translations/context live in `apps/web/src/hooks/use-app-settings.tsx`, persisted by `GET/PUT /api/settings` in the local service.
- **Agent system prompt**: `apps/bridge/src/system-prompt.ts` — defines how agents behave inside Teammate.
- **CLI commands**: `packages/cli/src/index.ts` — single file, all `teammate message …` and `teammate task …` subcommands.
- **Web routes**: `apps/web/src/app/(chat)` is the chat UI. `apps/web/src/app/api/bridge/connect/route.ts` is the compatibility bootstrap endpoint remote runtimes use on startup.
- **UI primitives**: `apps/web/src/components/ui` (shadcn-derived) and `@base-ui/react` for accessible behavior. Tailwind v4 + Radix UI Colors (sand scale).

## Conventions

- TypeScript everywhere. Avoid `any`; if you must, comment why.
- Use the dedicated tools (Read/Edit/Write) over shelling out to `cat`/`sed`.
- Prefer composition over new abstractions. Three similar lines beats a premature helper.
- No comments that just narrate the code. Only comment the non-obvious why.
- For UI changes, verify in a browser (`pnpm dev:web`) before claiming done.

### UI system

- Treat `apps/web/src/components/ui` as the authoritative component library for both web and Tauri desktop surfaces. It is the project's shadcn `base-nova` system, built on Base UI React.
- Use the existing primitives (`Button`, `Select`, `Switch`, `Tabs`, `Dialog`, `Card`, `Badge`, `Field`, `ScrollArea`, `Empty`, and related components) before creating product-specific controls. Native interactive elements are only appropriate when no matching primitive exists.
- Use Tailwind semantic tokens from `apps/web/src/app/globals.css` (`bg-background`, `bg-card`, `bg-accent`, `text-foreground`, `text-muted-foreground`, `border-border`, and status tokens). Do not introduce page-specific hex colors or a parallel token set.
- Use Lucide for product icons. Do not mix icon families in the same interface. Desktop-only code that cannot resolve `lucide-react` directly should import a shared re-export from `apps/web/src/components/ui`.
- Keep the established geometry: compact 32–40 px controls, `rounded-lg` controls, `rounded-2xl` cards, restrained borders/shadows, and Sand/Sanda neutral surfaces.
- Shared interaction behavior belongs in a reusable component under `apps/web/src/components/ui`; product composition belongs under `apps/web/src/components` or the owning app.
- Fluid Functionalism can be used as an interaction reference for meaningful motion, hover previews, and agent-state feedback. Adapt those ideas through the existing Base UI primitives and Teammate tokens; do not install registry components wholesale or introduce a motion dependency for a single effect.
- Check new UI in both light and dark themes and verify desktop/Tauri and web consumers when the shared component library is touched.

## Don't

- Don't commit `.env` files or anything under `supabase/.temp/`.
- Don't add automated tests as a side effect of unrelated work — the project doesn't have a test suite yet, and adding one is its own decision.
- Don't bypass Supabase RLS by calling it with the service-role key from web app code. The service-role key only belongs in the bridge and in trusted server-side `/api` routes.
- Don't introduce a new dependency without a clear reason (the package list is intentionally small).
- Don't invoke Claude Code during automated self-tests; use the Codex runtime.

## Useful commands

```bash
pnpm install
pnpm dev:local      # local Node/SQLite + web + agent runtime
pnpm desktop:dev    # Tauri 2 desktop app with bundled local runtime
pnpm desktop:build  # native app/installer for the current OS
pnpm dev:web        # Next.js dev server :3000
pnpm dev:runtime    # Agent runtime in watch mode
pnpm build          # Build everything via turbo
pnpm lint           # Lint everything via turbo
pnpm db:push        # Push DB schema (when you're set up with Supabase CLI)
```
