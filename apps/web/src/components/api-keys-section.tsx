"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiUrl } from "@/lib/api-url";
import { KeyIcon, CopyIcon, CheckIcon, TrashIcon, PlusIcon } from "lucide-react";

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface ServerError {
  serverId: string;
  message: string;
}

interface RevealedKey {
  serverId: string;
  keyId: string | null;
  value: string;
}

interface PendingDelete {
  serverId: string;
  key: ApiKey;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) return payload.error;
  } catch {
    // The fallback includes the response status when the body is not JSON.
  }
  return `${fallback} (${response.status})`;
}

function isApiKey(value: unknown): value is ApiKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<ApiKey>;
  return (
    typeof key.id === "string" &&
    typeof key.key_prefix === "string" &&
    typeof key.name === "string" &&
    typeof key.created_at === "string" &&
    (typeof key.last_used_at === "string" || key.last_used_at === null)
  );
}

export function ApiKeysSection({ serverId }: { serverId: string }) {
  const [keyList, setKeyList] = useState<{ serverId: string; keys: ApiKey[] }>({ serverId, keys: [] });
  const [loadingServerId, setLoadingServerId] = useState<string | null>(serverId || null);
  const [creatingServerId, setCreatingServerId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ serverId: string; keyId: string } | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<RevealedKey | null>(null);
  const [copiedServerId, setCopiedServerId] = useState<string | null>(null);
  const [showFormServerId, setShowFormServerId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [loadError, setLoadError] = useState<ServerError | null>(null);
  const [actionError, setActionError] = useState<ServerError | null>(null);
  const serverIdRef = useRef(serverId);
  const loadGenerationRef = useRef(0);
  const createGenerationRef = useRef(0);
  const deleteGenerationRef = useRef(0);
  const copyGenerationRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const createAbortRef = useRef<AbortController | null>(null);
  const deleteAbortRef = useRef<AbortController | null>(null);
  const createInFlightRef = useRef(false);
  const deleteInFlightRef = useRef(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const keys = keyList.serverId === serverId ? keyList.keys : [];
  const loading = loadingServerId === serverId || keyList.serverId !== serverId;
  const creating = creatingServerId === serverId;
  const visibleRevealedKey = revealedKey?.serverId === serverId ? revealedKey : null;
  const visibleLoadError = loadError?.serverId === serverId ? loadError.message : "";
  const visibleActionError = actionError?.serverId === serverId ? actionError.message : "";
  const visiblePendingDelete = pendingDelete?.serverId === serverId ? pendingDelete : null;
  const deletingCurrentKey =
    deleting?.serverId === serverId && deleting.keyId === visiblePendingDelete?.key.id;

  const loadKeys = useCallback(async (requestedServerId: string) => {
    if (!requestedServerId || serverIdRef.current !== requestedServerId) return;

    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoadingServerId(requestedServerId);
    setLoadError(null);

    try {
      const response = await fetch(
        apiUrl(`/api/bridge/keys?server_id=${encodeURIComponent(requestedServerId)}`),
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(await responseError(response, "Could not load access keys"));
      const payload = (await response.json()) as { keys?: unknown };
      if (!Array.isArray(payload.keys) || !payload.keys.every(isApiKey)) {
        throw new Error("The access key response was invalid.");
      }
      if (
        controller.signal.aborted ||
        generation !== loadGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;
      setKeyList({ serverId: requestedServerId, keys: payload.keys });
    } catch (error) {
      if (
        controller.signal.aborted ||
        isAbortError(error) ||
        generation !== loadGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;
      const message = error instanceof Error ? error.message : "Could not load access keys.";
      setLoadError({ serverId: requestedServerId, message });
    } finally {
      if (
        generation === loadGenerationRef.current &&
        serverIdRef.current === requestedServerId
      ) {
        setLoadingServerId(null);
        if (loadAbortRef.current === controller) loadAbortRef.current = null;
      }
    }
  }, []);

  useLayoutEffect(() => {
    const requestedServerId = serverId;
    serverIdRef.current = requestedServerId;
    loadGenerationRef.current += 1;
    createGenerationRef.current += 1;
    deleteGenerationRef.current += 1;
    copyGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    createAbortRef.current?.abort();
    deleteAbortRef.current?.abort();
    createInFlightRef.current = false;
    deleteInFlightRef.current = false;
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }

    const frame = window.requestAnimationFrame(() => {
      if (serverIdRef.current !== requestedServerId) return;
      setKeyList({ serverId: requestedServerId, keys: [] });
      setCreatingServerId(null);
      setDeleting(null);
      setNewKeyName("");
      setRevealedKey(null);
      setCopiedServerId(null);
      setShowFormServerId(null);
      setPendingDelete(null);
      setLoadError(null);
      setActionError(null);

      if (!requestedServerId) {
        setLoadingServerId(null);
        setLoadError({ serverId: requestedServerId, message: "No workspace is selected." });
        return;
      }
      void loadKeys(requestedServerId);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      loadGenerationRef.current += 1;
      createGenerationRef.current += 1;
      deleteGenerationRef.current += 1;
      copyGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      createAbortRef.current?.abort();
      deleteAbortRef.current?.abort();
      createInFlightRef.current = false;
      deleteInFlightRef.current = false;
      if (copiedTimerRef.current) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
      if (serverIdRef.current === requestedServerId) serverIdRef.current = "";
    };
  }, [loadKeys, serverId]);

  async function handleCreate() {
    const requestedServerId = serverId;
    if (
      !requestedServerId ||
      serverIdRef.current !== requestedServerId ||
      createInFlightRef.current
    ) return;

    const generation = ++createGenerationRef.current;
    createInFlightRef.current = true;
    createAbortRef.current?.abort();
    const controller = new AbortController();
    createAbortRef.current = controller;
    setCreatingServerId(requestedServerId);
    setActionError(null);

    try {
      const response = await fetch(apiUrl("/api/bridge/keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          server_id: requestedServerId,
          name: newKeyName.trim() || "Default",
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await responseError(response, "Could not create access key"));
      const payload = (await response.json()) as { apiKey?: unknown; key?: { id?: unknown } };
      if (typeof payload.apiKey !== "string" || !payload.apiKey) {
        throw new Error("The created access key response was invalid.");
      }
      if (
        controller.signal.aborted ||
        generation !== createGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;

      setRevealedKey({
        serverId: requestedServerId,
        keyId: typeof payload.key?.id === "string" ? payload.key.id : null,
        value: payload.apiKey,
      });
      setCopiedServerId(null);
      setNewKeyName("");
      setShowFormServerId(null);
      void loadKeys(requestedServerId);
    } catch (error) {
      if (
        controller.signal.aborted ||
        isAbortError(error) ||
        generation !== createGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;
      const message = error instanceof Error ? error.message : "Could not create access key.";
      setActionError({ serverId: requestedServerId, message });
    } finally {
      if (
        generation === createGenerationRef.current &&
        serverIdRef.current === requestedServerId
      ) {
        createInFlightRef.current = false;
        setCreatingServerId(null);
        if (createAbortRef.current === controller) createAbortRef.current = null;
      }
    }
  }

  async function handleDelete(pending: PendingDelete) {
    const requestedServerId = serverId;
    if (
      !requestedServerId ||
      pending.serverId !== requestedServerId ||
      serverIdRef.current !== requestedServerId ||
      deleteInFlightRef.current
    ) return;
    if (
      keyList.serverId !== requestedServerId ||
      !keyList.keys.some((key) => key.id === pending.key.id)
    ) {
      setPendingDelete(null);
      setActionError({
        serverId: requestedServerId,
        message: "This access key is no longer available. Reload the list and try again.",
      });
      return;
    }

    const generation = ++deleteGenerationRef.current;
    deleteInFlightRef.current = true;
    deleteAbortRef.current?.abort();
    const controller = new AbortController();
    deleteAbortRef.current = controller;
    loadGenerationRef.current += 1;
    loadAbortRef.current?.abort();
    setLoadingServerId(null);
    setDeleting({ serverId: requestedServerId, keyId: pending.key.id });
    setActionError(null);

    try {
      const response = await fetch(
        apiUrl(
          `/api/bridge/keys?id=${encodeURIComponent(pending.key.id)}&server_id=${encodeURIComponent(requestedServerId)}`,
        ),
        { method: "DELETE", signal: controller.signal },
      );
      if (!response.ok) throw new Error(await responseError(response, "Could not delete access key"));
      if (
        controller.signal.aborted ||
        generation !== deleteGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;

      setKeyList((current) => current.serverId === requestedServerId
        ? { ...current, keys: current.keys.filter((key) => key.id !== pending.key.id) }
        : current);
      setRevealedKey((current) =>
        current?.serverId === requestedServerId && current.keyId === pending.key.id ? null : current,
      );
      setPendingDelete(null);
      void loadKeys(requestedServerId);
    } catch (error) {
      if (
        controller.signal.aborted ||
        isAbortError(error) ||
        generation !== deleteGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;
      const message = error instanceof Error ? error.message : "Could not delete access key.";
      setActionError({ serverId: requestedServerId, message });
    } finally {
      if (
        generation === deleteGenerationRef.current &&
        serverIdRef.current === requestedServerId
      ) {
        deleteInFlightRef.current = false;
        setDeleting(null);
        if (deleteAbortRef.current === controller) deleteAbortRef.current = null;
      }
    }
  }

  async function handleCopy(key: RevealedKey) {
    const requestedServerId = serverId;
    const generation = ++copyGenerationRef.current;
    if (
      !requestedServerId ||
      key.serverId !== requestedServerId ||
      serverIdRef.current !== requestedServerId
    ) return;

    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    setCopiedServerId(null);
    setActionError(null);

    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(key.value);
      if (
        generation !== copyGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;
      setCopiedServerId(requestedServerId);
      copiedTimerRef.current = setTimeout(() => {
        if (
          generation === copyGenerationRef.current &&
          serverIdRef.current === requestedServerId
        ) setCopiedServerId(null);
        copiedTimerRef.current = null;
      }, 2000);
    } catch (error) {
      if (
        generation !== copyGenerationRef.current ||
        serverIdRef.current !== requestedServerId
      ) return;
      const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
      setActionError({
        serverId: requestedServerId,
        message: `Could not copy the access key.${detail}`,
      });
    }
  }

  return (
    <div className="w-full max-w-lg">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <KeyIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">Runtime access keys</h3>
        </div>
        {showFormServerId !== serverId && (
          <Button
            variant="outline"
            size="sm"
            disabled={!serverId}
            onClick={() => {
              if (!serverId || serverIdRef.current !== serverId) return;
              setActionError(null);
              setShowFormServerId(serverId);
            }}
          >
            <PlusIcon aria-hidden="true" className="size-3.5 mr-1.5" />
            New Key
          </Button>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        Generate an access key to connect an agent runtime to this workspace.
      </p>

      {visibleLoadError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/20 p-3" role="alert">
          <p className="text-xs text-destructive">{visibleLoadError}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={!serverId || loading}
            onClick={() => void loadKeys(serverId)}
          >
            Retry
          </Button>
        </div>
      )}

      {visibleActionError && !visiblePendingDelete && (
        <p className="mb-4 rounded-lg border border-destructive/20 p-3 text-xs text-destructive" role="alert">
          {visibleActionError}
        </p>
      )}

      {visibleRevealedKey && (
        <div className="mb-4 rounded-lg border border-primary/20 bg-primary/5 p-3">
          <p className="text-xs font-medium text-foreground mb-2">
            Copy this key now — it won&apos;t be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-background rounded px-2 py-1.5 border font-mono break-all select-all">
              {visibleRevealedKey.value}
            </code>
            <Button
              variant="outline"
              size="sm"
              aria-label={copiedServerId === serverId ? "Access key copied" : "Copy access key"}
              title={copiedServerId === serverId ? "Copied" : "Copy access key"}
              onClick={() => void handleCopy(visibleRevealedKey)}
            >
              {copiedServerId === serverId ? (
                <CheckIcon aria-hidden="true" className="size-3.5" />
              ) : (
                <CopyIcon aria-hidden="true" className="size-3.5" />
              )}
            </Button>
          </div>
          <span className="sr-only" aria-live="polite">
            {copiedServerId === serverId ? "Access key copied." : ""}
          </span>
          <div className="mt-3 rounded-md bg-background border p-2">
            <p className="text-xs text-muted-foreground mb-1">Quick start:</p>
            <code className="text-xs font-mono break-all select-all text-foreground">
              npx @teammate/runtime --api-key {visibleRevealedKey.value}
            </code>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 text-xs"
            onClick={() => {
              copyGenerationRef.current += 1;
              if (copiedTimerRef.current) {
                clearTimeout(copiedTimerRef.current);
                copiedTimerRef.current = null;
              }
              setCopiedServerId(null);
              setRevealedKey(null);
              setActionError(null);
            }}
          >
            Dismiss
          </Button>
        </div>
      )}

      {showFormServerId === serverId && (
        <div className="mb-4 flex items-center gap-2">
          <Input
            aria-label="Access key name"
            placeholder="Key name (optional)"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating || !serverId}>
            {creating ? "Creating..." : "Create"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={creating}
            onClick={() => {
              setShowFormServerId(null);
              setNewKeyName("");
              setActionError(null);
            }}
          >
            Cancel
          </Button>
        </div>
      )}

      {loading && keys.length === 0 ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">Loading keys...</p>
      ) : keys.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No access keys yet. Create one to connect an agent runtime.
        </p>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground">
                  {k.name}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  {k.key_prefix}...
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="text-xs text-muted-foreground">
                  {k.last_used_at
                    ? `Used ${new Date(k.last_used_at).toLocaleDateString()}`
                    : "Never used"}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete access key ${k.name}`}
                  title={`Delete ${k.name}`}
                  disabled={deleting?.serverId === serverId}
                  onClick={() => {
                    if (!serverId || serverIdRef.current !== serverId) return;
                    setActionError(null);
                    setPendingDelete({ serverId, key: k });
                  }}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <TrashIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <AlertDialog
        open={visiblePendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deletingCurrentKey) {
            setPendingDelete(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete access key?</AlertDialogTitle>
            <AlertDialogDescription>
              {visiblePendingDelete
                ? `“${visiblePendingDelete.key.name}” will be revoked immediately. Any runtime using it will lose access.`
                : "This access key will be revoked immediately."}
            </AlertDialogDescription>
            {visibleActionError && (
              <p className="rounded-lg border border-destructive/20 p-3 text-xs text-destructive" role="alert">
                {visibleActionError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="ghost"
              disabled={deletingCurrentKey}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={deletingCurrentKey}
              disabled={!visiblePendingDelete || deletingCurrentKey}
              onClick={() => {
                if (visiblePendingDelete) void handleDelete(visiblePendingDelete);
              }}
            >
              Delete key
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
