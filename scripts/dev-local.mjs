#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const root = process.cwd();
const localUrl = process.env.TEAMMATE_LOCAL_SERVER_URL || "http://127.0.0.1:8787";
const controllerCredential = randomBytes(32).toString("base64url");
const children = [];
let shuttingDown = false;

function start(label, args, extraEnv = {}) {
  const child = spawn("pnpm", args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown || signal === "SIGTERM") return;
    console.error(`${label} exited with code ${code ?? "unknown"}`);
    shutdown(code || 1);
  });
  return child;
}

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${localUrl}/health`);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Local service did not become ready at ${localUrl}`);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

try {
  start("local-server", ["--filter", "@teammate/local-server", "dev"], {
    TEAMMATE_LOCAL_SERVER_URL: localUrl,
    TEAMMATE_LOCAL_CONTROLLER_TOKEN: controllerCredential,
  });
  await waitForHealth();

  start("web", ["--filter", "@teammate/web", "dev"], {
    NEXT_PUBLIC_TEAMMATE_LOCAL_MODE: "true",
    NEXT_PUBLIC_TEAMMATE_LOCAL_SERVER_URL: localUrl,
    NEXT_PUBLIC_TEAMMATE_LOCAL_CONTROLLER_TOKEN: controllerCredential,
  });

  start("agent-runtime", ["--filter", "@teammate/runtime", "dev"], {
    TEAMMATE_API_KEY: controllerCredential,
    TEAMMATE_SERVER_URL: localUrl,
    TEAMMATE_LOCAL_SERVER_URL: localUrl,
    TEAMMATE_AGENTS_DIR: join(root, ".teammate", "agents"),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
