# Third-party notices

## Craft Agents

Copyright 2026 Craft Docs Ltd.

This product includes software developed by Craft Docs Ltd.
https://craft.do

Portions of Teammate's provider connection and model-catalog refresh architecture, plus the queue, mid-stream delivery, cancellation, and terminal-completion semantics in `@teammate/execution-core`, are adapted from Craft Agents OSS under the Apache License, Version 2.0, and modified for Teammate's local SQLite service, provider-neutral runtime contract, generation/turn fencing, and Base UI interface.

The Apache License, Version 2.0 is distributed at `LICENSES/Apache-2.0.txt` in the repository and beside this notice as `Apache-2.0.txt` in the desktop app. The execution-core package also retains its package-local `LICENSE` and `NOTICE` files.

Sources: <https://craft.do>, <https://github.com/lukilabs/craft-agents-oss>

## pi-ai

Copyright (c) 2025 Mario Zechner

Teammate uses `@mariozechner/pi-ai` for provider dispatch and keeps a data-only snapshot of its pinned OpenAI Codex model catalog so the packaged Node sidecar does not depend on the SDK's lazy dynamic-import registry.

`@mariozechner/pi-ai` is part of pi-mono and is distributed under the MIT License. A copy is provided at `LICENSES/pi-mono-MIT.txt` in the repository and beside this notice as `pi-mono-MIT.txt` in the desktop app.

Source: <https://github.com/badlogic/pi-mono/tree/main/packages/ai>
