import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_DESKTOP_PATH,
  normalizeDesktopPath,
} from "../../desktop/src/next-navigation.ts";

const desktopFile = (path: string) => new URL(`../../desktop/${path}`, import.meta.url);
const webFile = (path: string) => new URL(`../../web/src/${path}`, import.meta.url);

test("desktop navigation admits workspace routes only", () => {
  assert.equal(DEFAULT_DESKTOP_PATH, "/s/local");
  for (const path of ["/", "/login", "/signup", "/register", "/onboarding", "/auth/callback"]) {
    assert.equal(normalizeDesktopPath(path), DEFAULT_DESKTOP_PATH);
  }
  assert.equal(normalizeDesktopPath("/s/local/settings?section=models"), "/s/local/settings?section=models");
  assert.equal(normalizeDesktopPath("/s/another-workspace/tasks"), "/s/another-workspace/tasks");
});

test("desktop canonicalizes its route before mounting the local app", async () => {
  const [main, app, viteConfig] = await Promise.all([
    readFile(desktopFile("src/main.tsx"), "utf8"),
    readFile(desktopFile("src/app.tsx"), "utf8"),
    readFile(desktopFile("vite.config.ts"), "utf8"),
  ]);

  assert.ok(main.indexOf("ensureDesktopLocalRoute();") < main.indexOf("async function bootstrap"));
  assert.match(
    viteConfig,
    /process\.env\.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE":\s*JSON\.stringify\("true"\)/,
  );
  assert.doesNotMatch(app, /(?:\/login|\/signup|\/register|\/onboarding|\/auth\/)/i);
  assert.doesNotMatch(app, /SetupWizard/);
});

test("local sidebar omits rather than hides hosted account controls", async () => {
  const sidebar = await readFile(webFile("components/sidebar.tsx"), "utf8");
  const accountStart = sidebar.indexOf("      {!localMode && (");
  const accountEnd = sidebar.indexOf("      <CreateAgentDialog", accountStart);
  assert.notEqual(accountStart, -1);
  assert.notEqual(accountEnd, -1);
  const accountControls = sidebar.slice(accountStart, accountEnd);

  assert.match(accountControls, /Sign out/);
  assert.doesNotMatch(accountControls, /localMode\s*\?\s*["']hidden/);
  assert.doesNotMatch(sidebar, /className=\{`\$\{localMode\s*\?\s*["']hidden/);
});

test("desktop sidecar uses authenticated readiness and graceful shutdown before kill", async () => {
  const [sidecar, rust, localServer, app] = await Promise.all([
    readFile(desktopFile("sidecar/runtime.ts"), "utf8"),
    readFile(desktopFile("src-tauri/src/lib.rs"), "utf8"),
    readFile(new URL("../../local-server/src/index.ts", import.meta.url), "utf8"),
    readFile(desktopFile("src/app.tsx"), "utf8"),
  ]);

  assert.match(sidecar, /fetch\(`\$\{localUrl\}\/api\/ready`/);
  assert.match(sidecar, /Authorization:\s*`Bearer \$\{controllerCredential\}`/);
  assert.match(sidecar, /teammate:shutdown/);
  assert.match(sidecar, /process\.kill\(process\.pid,\s*"SIGTERM"\)/);
  assert.match(sidecar, /process\.stdin\.once\("end", requestShutdown\)/);
  assert.match(sidecar, /process\.stdin\.once\("close", requestShutdown\)/);
  assert.ok(rust.indexOf("child.write(SIDECAR_SHUTDOWN_COMMAND)") < rust.indexOf("child.kill()"));
  assert.match(rust, /SIDECAR_SHUTDOWN_POLL_ATTEMPTS/);
  assert.match(localServer, /url\.pathname === "\/api\/ready"/);
  assert.match(localServer, /server\.requestTimeout = LOCAL_REQUEST_TIMEOUT_MS/);
  assert.match(localServer, /MAX_JSON_BODY_BYTES = 4 \* 1024 \* 1024/);
  assert.match(app, /fetch\(`\$\{LOCAL_SERVICE_URL\}\/api\/ready`/);
  assert.match(app, /response\.status === 401 \|\| response\.status === 403/);
  assert.match(app, /RuntimeConflictError/);
});

test("desktop restores its macOS window and isolates development state", async () => {
  const [rust, packageJson, beforeDev, productionConfig, developmentConfig] = await Promise.all([
    readFile(desktopFile("src-tauri/src/lib.rs"), "utf8"),
    readFile(desktopFile("package.json"), "utf8"),
    readFile(desktopFile("scripts/before-dev.mjs"), "utf8"),
    readFile(desktopFile("src-tauri/tauri.conf.json"), "utf8"),
    readFile(desktopFile("src-tauri/tauri.dev.conf.json"), "utf8"),
  ]);
  const packageData = JSON.parse(packageJson) as { scripts?: Record<string, string> };
  const production = JSON.parse(productionConfig) as { identifier?: string };
  const development = JSON.parse(developmentConfig) as {
    identifier?: string;
    app?: { security?: { csp?: string } };
  };

  assert.ok(
    rust.indexOf("tauri_plugin_single_instance::init") <
      rust.indexOf("tauri_plugin_shell::init"),
  );
  assert.match(rust, /WindowEvent::CloseRequested/);
  assert.match(rust, /api\.prevent_close\(\)/);
  assert.match(rust, /RunEvent::Reopen/);
  assert.match(rust, /WebviewWindowBuilder::from_config/);
  assert.match(rust, /window\.unminimize\(\)/);
  assert.match(rust, /\#\[cfg\(debug_assertions\)\]\s*const LOCAL_SERVER_PORT: &str = "8788"/);
  assert.match(rust, /\#\[cfg\(not\(debug_assertions\)\)\]\s*const LOCAL_SERVER_PORT: &str = "8787"/);

  assert.match(packageData.scripts?.["desktop:dev"] || "", /tauri\.dev\.conf\.json/);
  assert.notEqual(development.identifier, production.identifier);
  assert.match(development.app?.security?.csp || "", /127\.0\.0\.1:8788/);
  assert.match(beforeDev, /127\.0\.0\.1:8788/);
});
