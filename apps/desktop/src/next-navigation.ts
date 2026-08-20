import { useMemo, useSyncExternalStore } from "react";

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

function getLocation() {
  return window.location.hash.slice(1) || "/";
}

function navigate(path: string, replace = false) {
  const target = path.startsWith("/") ? path : `/${path}`;
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
