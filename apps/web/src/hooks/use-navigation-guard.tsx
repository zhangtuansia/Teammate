"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-app-settings";

interface GuardEntry {
  dirty: boolean;
  discard: () => void;
  discardable: boolean;
}

interface NavigationGuardContextValue {
  register: (id: string, entry: GuardEntry | null) => void;
  navigate: (href: string, options?: { replace?: boolean }) => void;
  run: (action: () => void) => void;
}

const NavigationGuardContext = createContext<NavigationGuardContextValue | null>(null);

const HISTORY_GUARD_KEY = "__teammateNavigationGuard";
const NAVIGATION_HOLD_DATASET_KEY = "teammateNavigationHold";

interface HistoryTransition {
  kind: "remove" | "restore-hash";
  after: (() => void) | null;
}

function hasHistoryGuard(state: unknown, id: string) {
  return Boolean(
    state &&
      typeof state === "object" &&
      (state as Record<string, unknown>)[HISTORY_GUARD_KEY] === id,
  );
}

export function WorkspaceNavigationGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { t } = useAppSettings();
  const historyGuardId = useId();
  const guardsRef = useRef(new Map<string, GuardEntry>());
  const pendingActionRef = useRef<(() => void) | null>(null);
  const dirtyCountRef = useRef(0);
  const lockedCountRef = useRef(0);
  const guardedHrefRef = useRef<string | null>(null);
  const guardedStateRef = useRef<unknown>(null);
  const historyTransitionRef = useRef<HistoryTransition | null>(null);
  const ignoredHashHrefRef = useRef<string | null>(null);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [lockedCount, setLockedCount] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  const releaseNavigationHold = useCallback(() => {
    delete document.documentElement.dataset[NAVIGATION_HOLD_DATASET_KEY];
  }, []);

  const register = useCallback((id: string, entry: GuardEntry | null) => {
    if (entry) guardsRef.current.set(id, entry);
    else guardsRef.current.delete(id);
    const nextDirtyCount = guardsRef.current.size;
    const nextLockedCount = Array.from(guardsRef.current.values()).filter(
      (guard) => !guard.discardable,
    ).length;
    dirtyCountRef.current = nextDirtyCount;
    lockedCountRef.current = nextLockedCount;
    setDirtyCount(nextDirtyCount);
    setLockedCount(nextLockedCount);
    if (nextDirtyCount === 0) {
      releaseNavigationHold();
      pendingActionRef.current = null;
      setDialogOpen(false);
    }
  }, [releaseNavigationHold]);

  const ensureHistoryGuard = useCallback(() => {
    if (!guardedHrefRef.current) {
      guardedHrefRef.current = window.location.href;
      guardedStateRef.current = window.history.state;
    }
    document.documentElement.dataset[NAVIGATION_HOLD_DATASET_KEY] = guardedHrefRef.current;

    if (hasHistoryGuard(window.history.state, historyGuardId)) return;

    const guardedState = guardedStateRef.current;
    const nextState = guardedState && typeof guardedState === "object"
      ? { ...guardedState, [HISTORY_GUARD_KEY]: historyGuardId }
      : { [HISTORY_GUARD_KEY]: historyGuardId };
    window.history.pushState(nextState, "", guardedHrefRef.current);
  }, [historyGuardId]);

  const removeHistoryGuard = useCallback((after: (() => void) | null = null) => {
    const activeTransition = historyTransitionRef.current;
    if (activeTransition) {
      if (after) {
        const previousAfter = activeTransition.after;
        activeTransition.after = () => {
          previousAfter?.();
          after();
        };
      }
      return;
    }

    if (!hasHistoryGuard(window.history.state, historyGuardId)) {
      after?.();
      return;
    }

    historyTransitionRef.current = { kind: "remove", after };
    window.history.back();
  }, [historyGuardId]);

  const run = useCallback((action: () => void) => {
    if (dirtyCountRef.current === 0) {
      removeHistoryGuard(action);
      return;
    }
    pendingActionRef.current = action;
    setDialogOpen(true);
  }, [removeHistoryGuard]);

  const navigate = useCallback((href: string, options?: { replace?: boolean }) => {
    run(() => {
      if (options?.replace) router.replace(href);
      else router.push(href);
    });
  }, [router, run]);

  useLayoutEffect(() => {
    dirtyCountRef.current = dirtyCount;
    if (dirtyCount > 0) {
      ensureHistoryGuard();
      return;
    }

    pendingActionRef.current = null;
    removeHistoryGuard();
    guardedHrefRef.current = null;
    guardedStateRef.current = null;
    releaseNavigationHold();
  }, [dirtyCount, ensureHistoryGuard, releaseNavigationHold, removeHistoryGuard]);

  useLayoutEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const transition = historyTransitionRef.current;
      if (transition) {
        event.stopImmediatePropagation();
        historyTransitionRef.current = null;
        queueMicrotask(() => {
          transition.after?.();
          if (dirtyCountRef.current > 0) ensureHistoryGuard();
        });
        return;
      }

      if (dirtyCountRef.current === 0) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      if (hasHistoryGuard(event.state, historyGuardId)) return;

      const targetHref = window.location.href;
      const guardedHref = guardedHrefRef.current;
      ensureHistoryGuard();
      pendingActionRef.current = targetHref === guardedHref
        ? () => window.history.back()
        : null;
      setDialogOpen(true);
    };

    const handleHashChange = (event: HashChangeEvent) => {
      const ignoredHref = ignoredHashHrefRef.current;
      if (ignoredHref && window.location.href === ignoredHref) {
        ignoredHashHrefRef.current = null;
        const transition = historyTransitionRef.current;
        if (transition?.kind === "restore-hash") {
          historyTransitionRef.current = null;
          queueMicrotask(() => {
            transition.after?.();
            if (dirtyCountRef.current > 0) ensureHistoryGuard();
          });
        }
        event.stopImmediatePropagation();
        return;
      }
      if (dirtyCountRef.current === 0) return;

      const guardedHref = guardedHrefRef.current;
      const targetHref = event.newURL || window.location.href;
      if (!guardedHref || targetHref === guardedHref || window.location.href === guardedHref) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      pendingActionRef.current = () => window.location.assign(targetHref);
      setDialogOpen(true);
      ignoredHashHrefRef.current = guardedHref;
      historyTransitionRef.current = { kind: "restore-hash", after: null };
      window.history.back();
    };

    window.addEventListener("popstate", handlePopState, true);
    window.addEventListener("hashchange", handleHashChange, true);
    return () => {
      window.removeEventListener("popstate", handlePopState, true);
      window.removeEventListener("hashchange", handleHashChange, true);
    };
  }, [ensureHistoryGuard, historyGuardId]);

  useEffect(() => {
    if (dirtyCount === 0) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirtyCount]);

  useEffect(() => releaseNavigationHold, [releaseNavigationHold]);

  const value = useMemo(
    () => ({ register, navigate, run }),
    [navigate, register, run],
  );

  function closeDialog() {
    pendingActionRef.current = null;
    setDialogOpen(false);
    if (dirtyCountRef.current > 0) ensureHistoryGuard();
  }

  function discardAndContinue() {
    if (lockedCountRef.current > 0) return;
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    const dirtyGuards = Array.from(guardsRef.current.values());
    guardsRef.current.clear();
    dirtyCountRef.current = 0;
    lockedCountRef.current = 0;
    releaseNavigationHold();
    setDirtyCount(0);
    setLockedCount(0);
    for (const guard of dirtyGuards) guard.discard();
    setDialogOpen(false);
    removeHistoryGuard(action);
  }

  return (
    <NavigationGuardContext.Provider value={value}>
      {children}
      <AlertDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(lockedCount > 0 ? "navigation.busyTitle" : "navigation.unsavedTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(lockedCount > 0 ? "navigation.busyDescription" : "navigation.unsavedDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("navigation.stay")}
            </Button>
            {lockedCount === 0 && (
              <Button variant="destructive" onClick={discardAndContinue}>
                {t("navigation.discard")}
              </Button>
            )}
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </NavigationGuardContext.Provider>
  );
}

export function useWorkspaceNavigation() {
  const context = useContext(NavigationGuardContext);
  if (!context) throw new Error("useWorkspaceNavigation must be used inside WorkspaceNavigationGuardProvider");
  return { navigate: context.navigate, run: context.run };
}

export function useUnsavedChangesGuard(
  dirty: boolean,
  onDiscard: () => void,
  discardable = true,
) {
  const context = useContext(NavigationGuardContext);
  const id = useId();
  const discardRef = useRef(onDiscard);

  useLayoutEffect(() => {
    discardRef.current = onDiscard;
  }, [onDiscard]);

  useLayoutEffect(() => {
    if (!context) return;
    context.register(
      id,
      dirty
        ? { dirty: true, discard: () => discardRef.current(), discardable }
        : null,
    );
    return () => context.register(id, null);
  }, [context, dirty, discardable, id]);
}
