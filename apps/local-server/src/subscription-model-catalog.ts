// Snapshot of the subscription-provider catalogs exposed by the pinned
// @mariozechner/pi-ai dependency, mirroring chatgpt-model-catalog.ts: keeping
// this data-only module out of the packaged Node sidecar avoids the SDK's lazy
// dynamic-import registry, while subscription-model-catalog.test.ts keeps it
// honest against the SDK.
import type { ChatGptCatalogModel } from "./chatgpt-model-catalog.js";

export const SUBSCRIPTION_MODEL_CATALOG: Record<
  "anthropic" | "github-copilot",
  readonly ChatGptCatalogModel[]
> = {
  "anthropic": [
    {
      "id": "claude-3-5-haiku-20241022",
      "name": "Claude Haiku 3.5",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 8192,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.8,
        "output": 4,
        "cacheRead": 0.08,
        "cacheWrite": 1
      }
    },
    {
      "id": "claude-3-5-haiku-latest",
      "name": "Claude Haiku 3.5 (latest)",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 8192,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.8,
        "output": 4,
        "cacheRead": 0.08,
        "cacheWrite": 1
      }
    },
    {
      "id": "claude-3-5-sonnet-20240620",
      "name": "Claude Sonnet 3.5",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 8192,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-3-5-sonnet-20241022",
      "name": "Claude Sonnet 3.5 v2",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 8192,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-3-7-sonnet-20250219",
      "name": "Claude Sonnet 3.7",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-3-haiku-20240307",
      "name": "Claude Haiku 3",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 4096,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0.25,
        "output": 1.25,
        "cacheRead": 0.03,
        "cacheWrite": 0.3
      }
    },
    {
      "id": "claude-3-opus-20240229",
      "name": "Claude Opus 3",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 4096,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      }
    },
    {
      "id": "claude-3-sonnet-20240229",
      "name": "Claude Sonnet 3",
      "reasoning": false,
      "contextWindow": 200000,
      "maxTokens": 4096,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 0.3
      }
    },
    {
      "id": "claude-haiku-4-5",
      "name": "Claude Haiku 4.5 (latest)",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1,
        "output": 5,
        "cacheRead": 0.1,
        "cacheWrite": 1.25
      }
    },
    {
      "id": "claude-haiku-4-5-20251001",
      "name": "Claude Haiku 4.5",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 1,
        "output": 5,
        "cacheRead": 0.1,
        "cacheWrite": 1.25
      }
    },
    {
      "id": "claude-opus-4-0",
      "name": "Claude Opus 4 (latest)",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      }
    },
    {
      "id": "claude-opus-4-1",
      "name": "Claude Opus 4.1 (latest)",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      }
    },
    {
      "id": "claude-opus-4-1-20250805",
      "name": "Claude Opus 4.1",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      }
    },
    {
      "id": "claude-opus-4-20250514",
      "name": "Claude Opus 4",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 15,
        "output": 75,
        "cacheRead": 1.5,
        "cacheWrite": 18.75
      }
    },
    {
      "id": "claude-opus-4-5",
      "name": "Claude Opus 4.5 (latest)",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      }
    },
    {
      "id": "claude-opus-4-5-20251101",
      "name": "Claude Opus 4.5",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      }
    },
    {
      "id": "claude-opus-4-6",
      "name": "Claude Opus 4.6",
      "reasoning": true,
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 5,
        "output": 25,
        "cacheRead": 0.5,
        "cacheWrite": 6.25
      }
    },
    {
      "id": "claude-sonnet-4-0",
      "name": "Claude Sonnet 4 (latest)",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-sonnet-4-20250514",
      "name": "Claude Sonnet 4",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5 (latest)",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-sonnet-4-5-20250929",
      "name": "Claude Sonnet 4.5",
      "reasoning": true,
      "contextWindow": 200000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    },
    {
      "id": "claude-sonnet-4-6",
      "name": "Claude Sonnet 4.6",
      "reasoning": true,
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 3,
        "output": 15,
        "cacheRead": 0.3,
        "cacheWrite": 3.75
      }
    }
  ],
  "github-copilot": [
    {
      "id": "claude-haiku-4.5",
      "name": "Claude Haiku 4.5",
      "reasoning": true,
      "contextWindow": 144000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "claude-opus-4.5",
      "name": "Claude Opus 4.5",
      "reasoning": true,
      "contextWindow": 160000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "claude-opus-4.6",
      "name": "Claude Opus 4.6",
      "reasoning": true,
      "contextWindow": 1000000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "claude-sonnet-4",
      "name": "Claude Sonnet 4",
      "reasoning": true,
      "contextWindow": 216000,
      "maxTokens": 16000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "claude-sonnet-4.5",
      "name": "Claude Sonnet 4.5",
      "reasoning": true,
      "contextWindow": 144000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "claude-sonnet-4.6",
      "name": "Claude Sonnet 4.6",
      "reasoning": true,
      "contextWindow": 1000000,
      "maxTokens": 32000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gemini-2.5-pro",
      "name": "Gemini 2.5 Pro",
      "reasoning": false,
      "contextWindow": 128000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gemini-3-flash-preview",
      "name": "Gemini 3 Flash",
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gemini-3-pro-preview",
      "name": "Gemini 3 Pro Preview",
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gemini-3.1-pro-preview",
      "name": "Gemini 3.1 Pro Preview",
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-4.1",
      "name": "GPT-4.1",
      "reasoning": false,
      "contextWindow": 128000,
      "maxTokens": 16384,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-4o",
      "name": "GPT-4o",
      "reasoning": false,
      "contextWindow": 128000,
      "maxTokens": 4096,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5",
      "name": "GPT-5",
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5-mini",
      "name": "GPT-5-mini",
      "reasoning": true,
      "contextWindow": 264000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.1",
      "name": "GPT-5.1",
      "reasoning": true,
      "contextWindow": 264000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.1-codex",
      "name": "GPT-5.1-Codex",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.1-codex-max",
      "name": "GPT-5.1-Codex-max",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.1-codex-mini",
      "name": "GPT-5.1-Codex-mini",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.2",
      "name": "GPT-5.2",
      "reasoning": true,
      "contextWindow": 264000,
      "maxTokens": 64000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.2-codex",
      "name": "GPT-5.2-Codex",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.3-codex",
      "name": "GPT-5.3-Codex",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.4",
      "name": "GPT-5.4",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "gpt-5.4-mini",
      "name": "GPT-5.4 Mini",
      "reasoning": true,
      "contextWindow": 400000,
      "maxTokens": 128000,
      "input": [
        "text",
        "image"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    },
    {
      "id": "grok-code-fast-1",
      "name": "Grok Code Fast 1",
      "reasoning": true,
      "contextWindow": 128000,
      "maxTokens": 64000,
      "input": [
        "text"
      ],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      }
    }
  ]
};
