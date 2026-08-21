import assert from "node:assert/strict";
import test from "node:test";
import { getModels } from "@mariozechner/pi-ai";
import { SUBSCRIPTION_MODEL_CATALOG } from "./subscription-model-catalog.js";

test("the packaged subscription catalogs match the pinned public SDK catalogs", () => {
  for (const provider of ["anthropic", "github-copilot"] as const) {
    const sdkCatalog = getModels(provider).map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: [...model.input],
      cost: { ...model.cost },
    }));

    assert.deepEqual(SUBSCRIPTION_MODEL_CATALOG[provider], sdkCatalog, provider);
  }
});
