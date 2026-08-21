# @teammate/runtime

The Teammate agent runtime connects local Codex, Claude Code, and compatible
provider engines to Teammate workspaces. The desktop app embeds this runtime;
remote-workspace operators can run it from the repository.

```bash
pnpm install
pnpm dev:runtime -- --api-key tm_your_key_here
```

This package name is not currently published as a standalone npm registry
release. Its internal workspace dependencies remain private, so use the
repository command above until a package release is announced.

The runtime package is MIT-licensed. Its Apache-derived execution-core
dependency retains its own Apache 2.0 license and notices in the repository.
