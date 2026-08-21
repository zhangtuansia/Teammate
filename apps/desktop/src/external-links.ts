import { isTauri } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function externalUrl(link: HTMLAnchorElement) {
  try {
    const url = new URL(link.href);
    return EXTERNAL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function openInSystemBrowser(url: string) {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  void openExternal(url).catch(() => {
    console.error("Teammate could not open the external link.");
  });
}

export function installExternalLinkHandler() {
  const handleActivation = (event: MouseEvent) => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[data-teammate-external-link]");
    if (!link) return;
    const url = externalUrl(link);
    if (!url) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    openInSystemBrowser(url);
  };

  document.addEventListener("click", handleActivation);
  document.addEventListener("auxclick", handleActivation);

  return () => {
    document.removeEventListener("click", handleActivation);
    document.removeEventListener("auxclick", handleActivation);
  };
}
