#!/usr/bin/env node

import { hostname, platform, arch } from "os";
import { Bridge } from "./bridge.js";
import { enforcePrivateFileCreationMask } from "./private-filesystem.js";

enforcePrivateFileCreationMask();

// Default server URL (can be overridden)
const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";

interface ConnectResponse {
  protocolVersion?: number;
  supabaseUrl: string;
  supabaseAnonKey: string;
  token: string;
  agentTokens?: Record<string, string>;
  userId: string;
  serverId: string;
  serverName: string;
  localMode?: boolean;
  localServerUrl?: string;
  agents: Array<{
    id: string;
    name: string;
    display_name: string;
    description: string | null;
    runtime?: string;
    model: string;
    status: string;
  }>;
}

function parseArgs(): { serverUrl: string; apiKey: string; agentsDir: string } {
  const args = process.argv.slice(2);
  let serverUrl = DEFAULT_SERVER_URL;
  let apiKey = "";
  let agentsDir = "";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server-url":
        serverUrl = args[++i] || "";
        break;
      case "--api-key":
        apiKey = args[++i] || "";
        break;
      case "--agents-dir":
        agentsDir = args[++i] || "";
        break;
      case "--help":
      case "-h":
        console.log(`
  Usage: teammate-runtime [options]

  Options:
    --api-key <key>        Machine API key (required, generate at ${DEFAULT_SERVER_URL})
    --server-url <url>     Server URL (default: ${DEFAULT_SERVER_URL})
    --agents-dir <path>    Agent workspaces directory (default: ~/.teammate/agents)
    -h, --help             Show this help message
`);
        process.exit(0);
    }
  }

  // Also support env vars as fallback (for local dev)
  if (!apiKey) apiKey = process.env.TEAMMATE_API_KEY || "";
  if (!serverUrl || serverUrl === DEFAULT_SERVER_URL) {
    serverUrl = process.env.TEAMMATE_SERVER_URL || serverUrl;
  }

  if (!agentsDir) {
    agentsDir = (process.env.TEAMMATE_AGENTS_DIR || "~/.teammate/agents").replace(
      "~",
      process.env.HOME || ""
    );
  }

  if (!apiKey) {
    console.error("  Error: --api-key is required.");
    console.error("");
    console.error("  Generate one at your workspace settings page,");
    console.error("  then run:");
    console.error("");
    console.error("    npx @teammate/runtime --api-key tm_your_key_here");
    console.error("");
    process.exit(1);
  }

  return { serverUrl: serverUrl.replace(/\/+$/, ""), apiKey, agentsDir };
}

function redactBootstrapSecret() {
  for (let index = 2; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === "--api-key") {
      process.argv[index + 1] = "[redacted]";
    }
  }
  delete process.env.TEAMMATE_API_KEY;
  process.title = "teammate-runtime";
}

async function authenticate(
  serverUrl: string,
  apiKey: string
): Promise<ConnectResponse> {
  const res = await fetch(`${serverUrl}/api/bridge/connect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      apiKey,
      hostname: hostname(),
      platform: platform(),
      arch: arch(),
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

async function main() {
  const { serverUrl, apiKey, agentsDir } = parseArgs();
  redactBootstrapSecret();

  console.log(`
  ╔══════════════════════════════════════╗
  ║        Teammate Agent Runtime        ║
  ╚══════════════════════════════════════╝
`);
  console.log(`  Server: ${serverUrl}`);
  console.log(`  Connecting...`);

  let creds: ConnectResponse;
  try {
    creds = await authenticate(serverUrl, apiKey);
  } catch (err) {
    console.error(
      `  Authentication failed: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  console.log(`  Authenticated as user ${creds.userId.substring(0, 8)}...`);
  console.log(`  Workspace: ${creds.serverName}`);
  console.log(`  Agents: ${creds.agents.map((a) => a.display_name).join(", ") || "none"}`);
  console.log(`  Agents dir: ${agentsDir}`);
  console.log("");

  if (creds.protocolVersion !== 2 || !creds.agentTokens) {
    throw new Error(
      "The server does not support per-agent runtime credentials. Upgrade the Teammate server before connecting.",
    );
  }

  const runtime = new Bridge({
    supabaseUrl: creds.supabaseUrl,
    supabaseKey: creds.supabaseAnonKey,
    authToken: creds.token,
    agentAuthTokens: creds.agentTokens ?? {},
    userId: creds.userId,
    serverId: creds.serverId,
    agentsDir,
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    localMode: creds.localMode,
    localServerUrl: creds.localServerUrl,
    apiKey,
    refreshAgentAuthTokens: async () => {
      const fresh = await authenticate(serverUrl, apiKey);
      if (fresh.protocolVersion !== 2 || !fresh.agentTokens) {
        throw new Error("Server refresh did not return per-agent credentials");
      }
      return fresh.agentTokens ?? {};
    },
  });

  try {
    await runtime.start();
  } catch (error) {
    await runtime.stop().catch(() => undefined);
    throw error;
  }

  let shuttingDown = false;

  // Refresh the one-hour runtime token before it approaches expiry.
  const refreshInterval = setInterval(async () => {
    if (shuttingDown) return;
    try {
      const fresh = await authenticate(serverUrl, apiKey);
      if (shuttingDown) return;
      if (fresh.protocolVersion !== 2 || !fresh.agentTokens) {
        throw new Error("Server refresh did not return per-agent credentials");
      }
      await runtime.updateAuthToken(fresh.token, fresh.agentTokens ?? {});
      console.log("  Auth token refreshed.");
    } catch (err) {
      console.error(
        `  Token refresh failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }, 30 * 60 * 1000);

  const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) {
      console.error(`\n  Received ${signal} again; forcing shutdown.`);
      process.exit(1);
    }
    shuttingDown = true;
    console.log(`\n  Shutting down agent runtime (${signal})...`);
    clearInterval(refreshInterval);

    let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      shutdownTimeout = setTimeout(
        () => reject(new Error("Agent runtime shutdown timed out")),
        10_000,
      );
    });

    try {
      await Promise.race([runtime.stop(), timeout]);
      if (shutdownTimeout) clearTimeout(shutdownTimeout);
      process.exit(0);
    } catch (error) {
      if (shutdownTimeout) clearTimeout(shutdownTimeout);
      console.error(
        "  Agent runtime shutdown failed:",
        error instanceof Error ? error.message : error,
      );
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error) => {
  console.error(
    "  Agent runtime failed:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
