# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security vulnerability. Use [GitHub private vulnerability reporting](https://github.com/zhangtuansia/Teammate/security/advisories/new) so maintainers can triage and patch the issue before public disclosure.

Include:

- a clear description and expected impact;
- reproduction steps or a minimal proof of concept;
- the affected component and commit/version;
- a suggested mitigation, if you have one.

## Scope

In scope:

- the Tauri desktop app and packaged sidecars;
- the local Node/SQLite service;
- the Teammate web application;
- the `@teammate/runtime` and `@teammate/cli` packages;
- database schema, RLS policies, and authentication routes.

Third-party dependency vulnerabilities should normally be reported upstream, but please notify this project when a Teammate update or mitigation is also required.

## Local trust model

AI runtimes can read and modify files that the operating-system user can access. Treat every enabled agent and connected model provider as code running with the same trust level as your local account.

- Keep agent workspaces scoped to the intended files.
- Review custom model endpoints and skills before enabling them.
- Keep API keys and OAuth tokens out of logs, screenshots, and SQLite.
- Rotate a Supabase service-role key or runtime access key immediately if it is exposed.
- Review RLS policies after any hosted schema change.
- Pin runtime package versions in production remote deployments.

Hosted runtime JWTs are live-key- and workspace-scoped, but currently not
per-agent. A runtime process can act as any agent owned by the same human in its
claimed workspace. Use separate workspace owners/runtime keys when agents need
mutual isolation, and never treat two agents under one runtime owner as separate
security principals.

Hosted workspace owners can remove another human through **Settings → Workspace
members**. The owner-only, human-session `remove_server_human_member` RPC revokes
that person's runtime keys and atomically removes their agents, direct messages,
workspace/channel memberships, deliveries, and task assignments in the selected
workspace. Direct owner deletes on `server_members` are intentionally rejected;
shared-channel message history is preserved, and other workspaces are not
touched. Supabase can cache authorization for an already-open private Realtime
channel, so also stop the removed member's runtime when its existing WebSocket
must be terminated immediately.

Hosted runtime keys can only be provisioned by a human session through
`create_current_user_machine_key`; direct table inserts and Bridge-session key
minting are rejected. Workspace/member validation and the hash insert share the
same transaction and lock order as member removal, so eviction cannot race with
key creation and leave usable credentials behind. The full secret remains in
the HTTPS response only and is never persisted in `machine_keys`. Removing a
human membership also deletes that person's keys for the workspace in the same
transaction, including self-leave, so later rejoining cannot reactivate an old
credential.

Teammate encrypts stored model credentials in a machine-bound credential file, but encryption does not protect a machine that is already unlocked and compromised.
