import assert from "node:assert/strict";
import test from "node:test";
import { runtimeProcessEnvironment } from "../src/runtime-env.js";

test("model runtimes inherit only explicit OS paths and packaged runtime helpers", () => {
  const environment = runtimeProcessEnvironment({
    PATH: "/usr/bin",
    HOME: "/tmp/agent-home",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    CODEX_HOME: "/tmp/agent-home/.codex",
    TEAMMATE_PI_PATH: "/opt/teammate/pi",
    TEAMMATE_PI_WORKER: "/tmp/teammate/worker.mjs",
    TEAMMATE_API_KEY: "tm_machine-secret",
    TEAMMATE_AUTH_TOKEN: "controller-jwt",
    TEAMMATE_AGENT_ID: "stale-agent",
    TEAMMATE_SUPABASE_URL: "https://stale.example",
    TEAMMATE_SUPABASE_KEY: "stale-key",
    TEAMMATE_LOCAL_SERVER_URL: "http://stale.local",
    TEAMMATE_LOCAL_DB: "/tmp/teammate/local.db",
    TEAMMATE_EMBEDDED_SIDECAR: "1",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    SUPABASE_JWT_SECRET: "jwt-secret",
    OPENAI_API_KEY: "provider-key",
    ANTHROPIC_API_KEY: "provider-key",
    AWS_SECRET_ACCESS_KEY: "cloud-secret",
    GITHUB_TOKEN: "source-control-secret",
    NPM_TOKEN: "registry-secret",
    DATABASE_URL: "postgres://secret@example.test/db",
    SSH_AUTH_SOCK: "/tmp/private-agent.sock",
    UNRECOGNIZED_VENDOR_SECRET: "must-not-leak",
  });

  assert.deepEqual(environment, {
    PATH: "/usr/bin",
    HOME: "/tmp/agent-home",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    CODEX_HOME: "/tmp/agent-home/.codex",
    TEAMMATE_PI_PATH: "/opt/teammate/pi",
    TEAMMATE_PI_WORKER: "/tmp/teammate/worker.mjs",
  });
});
