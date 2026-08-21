import { useMemo, useSyncExternalStore } from "react";

export const DEFAULT_DESKTOP_PATH = "/s/local";

export function normalizeDesktopPath(path: string) {
  const target = path.startsWith("/") ? path : `/${path}`;
  const pathname = target.split("?", 1)[0];
  return /^\/s\/[^/?#]+(?:\/|$)/.test(pathname) ? target : DEFAULT_DESKTOP_PATH;
}

export function ensureDesktopLocalRoute() {
  const current = window.location.hash.slice(1);
  const target = normalizeDesktopPath(current || DEFAULT_DESKTOP_PATH);
  if (current !== target) {
    window.history.replaceState(window.history.state, "", `#${target}`);
  }
}

function subscribe(callback: () => void) {
  const handleHashChange = () => {
    ensureDesktopLocalRoute();
    callback();
  };
  window.addEventListener("hashchange", handleHashChange);
  return () => window.removeEventListener("hashchange", handleHashChange);
}

function getLocation() {
  const heldHref = document.documentElement.dataset.teammateNavigationHold;
  if (heldHref) {
    try {
      const heldHash = new URL(heldHref).hash.slice(1);
      return normalizeDesktopPath(heldHash || DEFAULT_DESKTOP_PATH);
    } catch {
      // Ignore a malformed hold marker and fall back to the actual location.
    }
  }
  return normalizeDesktopPath(window.location.hash.slice(1) || DEFAULT_DESKTOP_PATH);
}

function navigate(path: string, replace = false) {
  const target = normalizeDesktopPath(path);
  if (replace) {
    window.history.replaceState(null, "", `#${target}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = target;
}

export function usePathname() {
  const location = useSyncExternalStore(subscribe, getLocation);
  return location.split("?")[0];
}

export function useParams() {
  const pathname = usePathname();
  return useMemo(() => {
    const segments = pathname.split("/").filter(Boolean);
    const result: Record<string, string> = {};
    if (segments[0] === "s" && segments[1]) result.slug = segments[1];
    if ((segments[2] === "dm" || segments[2] === "channel") && segments[3]) {
      result.channelId = segments[3];
    }
    return result;
  }, [pathname]);
}

export function useSearchParams() {
  const location = useSyncExternalStore(subscribe, getLocation);
  return useMemo(
    () => new URLSearchParams(location.includes("?") ? location.split("?")[1] : ""),
    [location],
  );
}

export function useRouter() {
  return useMemo(
    () => ({
      push: (path: string) => navigate(path),
      replace: (path: string) => navigate(path, true),
      refresh: () => window.dispatchEvent(new HashChangeEvent("hashchange")),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
      prefetch: async () => undefined,
    }),
    [],
  );
}
