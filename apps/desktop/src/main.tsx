import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DesktopSettingsProvider } from "./settings";
import { WorkspaceNavigationGuardProvider } from "@/hooks/use-navigation-guard";
import { installExternalLinkHandler } from "./external-links";
import { setLocalControllerCredential } from "@/lib/local-auth";
import { ensureDesktopLocalRoute } from "./next-navigation";
import "./styles.css";

document.documentElement.dataset.platform = navigator.userAgent.includes("Macintosh")
  ? "macos"
  : navigator.userAgent.includes("Windows")
    ? "windows"
    : "linux";

installExternalLinkHandler();
ensureDesktopLocalRoute();

async function bootstrap() {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    setLocalControllerCredential(
      await invoke<string>("local_controller_credential"),
    );
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
