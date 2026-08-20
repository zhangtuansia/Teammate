#!/usr/bin/env node

import { spawn } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const localUrl = process.env.ZANO_LOCAL_SERVER_URL || "http://127.0.0.1:8787";
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
  start("local-server", ["--filter", "@zano/local-server", "dev"], {
    ZANO_LOCAL_SERVER_URL: localUrl,
  });
  await waitForHealth();

  start("web", ["--filter", "@zano/web", "dev"], {
    NEXT_PUBLIC_ZANO_LOCAL_MODE: "true",
    NEXT_PUBLIC_ZANO_LOCAL_SERVER_URL: localUrl,
  });

  start("bridge", ["--filter", "@fehey/zano-bridge", "dev"], {
    ZANO_API_KEY: "zk_local",
    ZANO_SERVER_URL: localUrl,
    ZANO_LOCAL_SERVER_URL: localUrl,
    ZANO_AGENTS_DIR: join(root, ".zano", "agents"),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
