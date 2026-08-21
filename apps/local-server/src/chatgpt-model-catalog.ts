// Snapshot of the openai-codex catalog exposed by the pinned
// @mariozechner/pi-ai dependency. Keeping this data-only module out of the
// packaged Node sidecar avoids the SDK's lazy dynamic-import registry; the Bun
// worker still uses the SDK's public streamSimple dispatcher at runtime.
interface ChatGptCatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: ReadonlyArray<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export const CHATGPT_MODEL_CATALOG: readonly ChatGptCatalogModel[] = [
  {
    id: "gpt-5.1",
    name: "GPT-5.1",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  {
    id: "gpt-5.1-codex-max",
    name: "GPT-5.1 Codex Max",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  },
  {
    id: "gpt-5.1-codex-mini",
    name: "GPT-5.1 Codex Mini",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
  },
  {
    id: "gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  },
  {
    id: "gpt-5.2-codex",
    name: "GPT-5.2 Codex",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  },
  {
    id: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  },
  {
    id: "gpt-5.3-codex-spark",
    name: "GPT-5.3 Codex Spark",
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 128_000,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    reasoning: true,
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  },
];
