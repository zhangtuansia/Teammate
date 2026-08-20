import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DesktopSettingsProvider } from "./settings";
import "./styles.css";

document.documentElement.dataset.platform = navigator.userAgent.includes("Macintosh")
  ? "macos"
  : navigator.userAgent.includes("Windows")
    ? "windows"
    : "linux";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopSettingsProvider>
      <App />
    </DesktopSettingsProvider>
  </StrictMode>,
);
