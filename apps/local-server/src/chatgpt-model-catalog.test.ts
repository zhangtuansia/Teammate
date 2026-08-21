import assert from "node:assert/strict";
import test from "node:test";
import { getModels } from "@mariozechner/pi-ai";
import { CHATGPT_MODEL_CATALOG } from "./chatgpt-model-catalog.js";

test("the packaged ChatGPT catalog matches the pinned public SDK catalog", () => {
  const sdkCatalog = getModels("openai-codex").map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    cost: { ...model.cost },
  }));

  assert.deepEqual(CHATGPT_MODEL_CATALOG, sdkCatalog);
});
