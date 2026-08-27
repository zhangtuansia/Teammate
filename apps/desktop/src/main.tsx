import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DesktopSettingsProvider } from "./settings";
import { WorkspaceNavigationGuardProvider } from "@/hooks/use-navigation-guard";
import { installExternalLinkHandler } from "./external-links";
import { setLocalControllerCredential } from "@/lib/local-auth";
import { ensureDesktopLocalRoute } from "./next-navigation";
import "./styles.css";

declare global {
  interface Window {
    __TEAMMATE_LOCAL_CONTROLLER_CREDENTIAL__?: string;
  }
}

const LOCAL_CONTROLLER_CREDENTIAL_EVENT = "teammate:local-controller-credential";

function injectedLocalControllerCredential() {
  const credential = window.__TEAMMATE_LOCAL_CONTROLLER_CREDENTIAL__;
  return typeof credential === "string" && credential.length >= 32 ? credential : "";
}

async function resolveLocalControllerCredential() {
  const injected = injectedLocalControllerCredential();
  if (injected) return injected;

  const { invoke } = await import("@tauri-apps/api/core");
  return await new Promise<string>((resolve, reject) => {
    let invokeError: unknown;
    let settled = false;
    const finish = (credential: string) => {
      if (settled || credential.length < 32) return;
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener(LOCAL_CONTROLLER_CREDENTIAL_EVENT, handleInjected);
      resolve(credential);
    };
    const handleInjected = () => finish(injectedLocalControllerCredential());
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener(LOCAL_CONTROLLER_CREDENTIAL_EVENT, handleInjected);
      reject(invokeError || new Error("The local controller credential did not become available"));
    }, 8_000);

    window.addEventListener(LOCAL_CONTROLLER_CREDENTIAL_EVENT, handleInjected);
    finish(injectedLocalControllerCredential());
    void invoke<string>("local_controller_credential").then(finish, (error) => {
      invokeError = error;
    });
  });
}

document.documentElement.dataset.platform = navigator.userAgent.includes("Macintosh")
  ? "macos"
  : navigator.userAgent.includes("Windows")
    ? "windows"
    : "linux";

installExternalLinkHandler();
ensureDesktopLocalRoute();

async function bootstrap() {
  if ("__TAURI_INTERNALS__" in window) {
    setLocalControllerCredential(await resolveLocalControllerCredential());
  } else {
    setLocalControllerCredential(
      process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_CONTROLLER_TOKEN || "",
    );
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <DesktopSettingsProvider>
        <WorkspaceNavigationGuardProvider>
          <App />
        </WorkspaceNavigationGuardProvider>
      </DesktopSettingsProvider>
    </StrictMode>,
  );
}

void bootstrap().catch((error) => {
  console.error("Teammate desktop could not initialize:", error);
  document.getElementById("root")!.textContent =
    "Teammate could not initialize its local controller.";
});
