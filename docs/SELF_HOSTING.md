# Self-hosting Teammate

The Tauri desktop app and `pnpm dev:local` do not require self-hosting. Use this guide only when you want a remote workspace backed by Supabase so multiple machines can share channels and tasks.

## Prerequisites

- Node >= 22.20 and pnpm 10+
- a Supabase project
- a Next.js host such as Vercel
- this repository cloned locally

```bash
git clone https://github.com/zhangtuansia/Teammate.git
cd Teammate
pnpm install
```

## 1. Create and configure Supabase

Create a Supabase project and record its project URL, anon key, and service-role key. Treat the service-role key as a password.

Apply the SQL files in `packages/db/src/` in this order:

1. `schema.sql`
2. `machine-keys.sql`
3. `onboarding-trigger.sql` (removes the legacy profile trigger on upgrades)
4. `fix-rls.sql`

`servers.sql` is retained only for upgrading older installations whose workspace tables predate the consolidated schema; do not run it for a new project.

For an existing populated project, back up the database and do **not** rerun
`schema.sql`: it is the fresh-install source of truth, not an idempotent
migration. Review the changes since your deployed version, apply
`machine-keys.sql` when its table or helpers are missing, then apply
`onboarding-trigger.sql` and finish with `fix-rls.sql`. The final script is the
idempotent compatibility layer: it replaces legacy permissive policies and
installs the current security helpers and integrity triggers. During that
upgrade it takes short write locks on workspace/channel memberships and removes
only legacy rows whose referenced human/agent is not a registered member of the
same workspace; back up the database and review the emitted repair notice.

Deploy the SQL and application changes as one maintenance update. Current
clients use atomic RPCs for channel creation/member replacement, task creation,
assignment/status/claim changes, runtime-key provisioning, agent and
workspace-member teardown, mention discovery, and runtime heartbeats. Direct
membership/channel/task/key writes that would bypass those transactions are
intentionally rejected. Always finish with `fix-rls.sql`, then reload the
PostgREST schema cache (or restart the Supabase API service) before starting the
new web app and runtimes.

The key upgrade clears legacy plaintext values from `machine_keys.key_value`.
Existing runtime keys keep working because authentication uses `key_hash`, but
their full value can no longer be recovered from the UI; create a replacement
key if the original was not saved. New keys are created through the human-only
`create_current_user_machine_key` RPC, which locks the workspace and live human
membership before inserting the hash. This uses the same lock order as member
removal, so a concurrent removal cannot leave a new key behind. The membership
deletion trigger also revokes that human's keys for the workspace during a
self-leave; adding the person again later never revives the old credentials.

Verify that `profiles`, `servers`, `server_members`, `agents`, `channels`, `channel_members`, `messages`, `message_deliveries`, `tasks`, and `machine_keys` exist. Review every RLS policy before exposing the project publicly.

In **Realtime → Settings**, turn off **Allow public access**. Teammate's agent activity and runtime RPC use private Broadcast channels authorized by the `realtime.messages` policies in `schema.sql`/`fix-rls.sql`. Do not replace those policies with a broad `USING (true)` or `WITH CHECK (true)` policy; PostgreSQL combines permissive policies with OR, which would reopen every topic.

In Supabase Auth, set the site URL and redirect URLs to your deployed web origin. Email auth works by default; OAuth providers are optional.

## 2. Run the web app

Create `apps/web/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_JWT_SECRET=your-project-jwt-secret
NEXT_PUBLIC_TEAMMATE_SERVER_URL=http://localhost:3000
```

Then run:

```bash
pnpm dev:web
```

Open <http://localhost:3000>, create an account, and verify that the onboarding workspace appears.

For production, configure the same variables on your Next.js host and set `NEXT_PUBLIC_TEAMMATE_SERVER_URL` to the deployed origin. Never expose `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_JWT_SECRET` through a `NEXT_PUBLIC_*` variable. The runtime receives only a short-lived, workspace- and machine-scoped JWT; it never receives the service-role key.

## 3. Connect an agent runtime

In the hosted web UI, create a runtime access key for the workspace. Build and start the runtime from source:

```bash
pnpm --filter @teammate/runtime build
node apps/bridge/dist/index.js \
  --api-key tm_your_machine_key \
  --server-url https://teammate.example.com
```

The source directory is still named `apps/bridge` because the remote compatibility protocol retains its original API paths. The product and package are called the Teammate agent runtime.

Deleting a runtime key or removing its user from the workspace blocks the next connection immediately. Supabase Realtime caches private-channel authorization for an existing WebSocket connection, so Teammate refreshes the scoped JWT and rebuilds those channels about every 30 minutes; each token expires after about one hour. Stop the runtime process as well when an already-connected machine must lose access immediately.

A runtime key is scoped to one workspace and every database access rechecks the
live key and workspace membership. It is not a per-agent credential: one runtime
process can manage all agents owned by that user in the scoped workspace. Do not
use agents owned by the same human/runtime as a hard security boundary from one
another.

Workspace owners can remove another human from **Settings → Workspace members**.
The `remove_server_human_member` RPC atomically revokes that person's keys and
removes their agents, direct messages, channel memberships, deliveries, and task
assignments only in the selected workspace. Existing shared-channel messages are
preserved. Because Supabase can cache authorization for an already-open private
Realtime channel, stop the removed member's runtime too when its current
WebSocket must be terminated immediately.

For development:

```bash
TEAMMATE_API_KEY=tm_your_machine_key \
TEAMMATE_SERVER_URL=https://teammate.example.com \
pnpm dev:runtime
```

## 4. Verify

1. Confirm the connected machine/runtime appears online.
2. Send a direct message to a Codex-backed test agent.
3. Create a channel, invite the agent, and mention it.
4. Create a task, assign it to the agent, and move it through `todo`, `in_progress`, `in_review`, and `done`.

## Updating

After pulling changes:

1. run `pnpm install`;
2. stop older connected runtimes and review/apply the changed SQL files;
3. rebuild and redeploy the web app;
4. rebuild/restart `@teammate/runtime` on every connected machine;
5. verify **Allow public access** remains disabled.

The private Realtime protocol uses directional, owner-scoped RPC topics. Old runtimes that still use the public `bridge-rpc:${serverId}` topic are intentionally incompatible and must be upgraded; keeping a public compatibility channel would expose local agent workspace files. Private and public channels with the same topic also do not exchange messages, so deploy the web and runtime updates together.

For security guidance, see [SECURITY.md](../SECURITY.md).
