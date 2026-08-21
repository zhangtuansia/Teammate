import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card, CardPanel } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertCircle, Bot, Check, Ellipsis, Plus, RefreshCw } from "@/components/ui/settings-icons";
import { apiUrl } from "@/lib/api-url";
import type { ModelConnection } from "@/lib/model-connections";
import { BUILTIN_MODEL_PROVIDERS } from "@/lib/model-provider-registry";
import type { TranslationKey } from "@/hooks/use-app-settings";
import type { AgentRuntimeId } from "@/lib/agent-runtime";
import { useUnsavedChangesGuard } from "@/hooks/use-navigation-guard";

interface ConnectionsSectionProps {
  t: (key: TranslationKey) => string;
  connections: ModelConnection[];
  runtimes: Array<{ id: AgentRuntimeId; name: string; installed: boolean }>;
  defaultRuntime: AgentRuntimeId;
  defaultConnectionId: string | null;
  onSetRuntimeDefault: (runtime: AgentRuntimeId) => void;
  onSetDefault: (connection: ModelConnection) => void;
  onDefaultSelectionSynced: (selection: {
    runtime: AgentRuntimeId;
    model: string;
    connectionId: string | null;
  }) => void;
  onConnectionsChanged: (connections: ModelConnection[]) => void;
}

const PROVIDER_ITEMS = BUILTIN_MODEL_PROVIDERS
  .filter((provider) => provider.authTypes.includes("api-key"))
  .map((provider) => ({ value: provider.id, label: provider.name })) as Array<{
    value: "openai-compatible" | "anthropic-compatible";
    label: string;
  }>;

type JsonObject = Record<string, unknown>;

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isModelConnection(value: unknown): value is ModelConnection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const connection = value as Record<string, unknown>;
  return (
    typeof connection.id === "string" &&
    typeof connection.name === "string" &&
    ["openai-codex", "openai-compatible", "anthropic-compatible"].includes(
      String(connection.provider),
    ) &&
    ["oauth", "api-key"].includes(String(connection.auth_type)) &&
    (connection.base_url === null || typeof connection.base_url === "string") &&
    ["openai-codex-responses", "openai-completions", "anthropic-messages"].includes(
      String(connection.api_format),
    ) &&
    typeof connection.default_model === "string" &&
    Array.isArray(connection.models) &&
    connection.models.every((model) =>
      Boolean(model) &&
      typeof model === "object" &&
      typeof (model as Record<string, unknown>).id === "string" &&
      typeof (model as Record<string, unknown>).name === "string"
    ) &&
    ["automatically-synced", "user-defined"].includes(String(connection.model_selection_mode)) &&
    (connection.models_refreshed_at === null || typeof connection.models_refreshed_at === "string") &&
    ["connected", "needs-auth", "error"].includes(String(connection.status)) &&
    (connection.auth_error === null || typeof connection.auth_error === "string") &&
    typeof connection.hasCredential === "boolean"
  );
}

function isDefaultSelection(value: unknown): value is {
  defaultRuntime: AgentRuntimeId;
  defaultModel: string;
  defaultConnectionId: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const settings = value as Record<string, unknown>;
  return (
    ["claude-code", "codex", "pi"].includes(String(settings.defaultRuntime)) &&
    typeof settings.defaultModel === "string" &&
    (settings.defaultConnectionId === null || typeof settings.defaultConnectionId === "string")
  );
}

export function ConnectionsSection({
  t,
  connections,
  runtimes,
  defaultRuntime,
  defaultConnectionId,
  onSetRuntimeDefault,
  onSetDefault,
  onDefaultSelectionSynced,
  onConnectionsChanged,
}: ConnectionsSectionProps) {
  const [oauthState, setOauthState] = useState<
    "idle" | "starting" | "waiting" | "error"
  >("idle");
  const [oauthRefreshing, setOauthRefreshing] = useState(false);
  const [oauthError, setOauthError] = useState("");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<"openai-compatible" | "anthropic-compatible">(
    "openai-compatible",
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [connectionToRemove, setConnectionToRemove] = useState<ModelConnection | null>(null);
  const [removingConnection, setRemovingConnection] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [refreshingConnectionId, setRefreshingConnectionId] = useState<string | null>(null);
  const [modelRefreshError, setModelRefreshError] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [checkingConnectionId, setCheckingConnectionId] = useState<string | null>(null);
  const [configurationNotice, setConfigurationNotice] = useState("");
  const savingRef = useRef(false);
  const removingRef = useRef(false);
  const oauthFlowRef = useRef(false);
  const mutationLockRef = useRef<
    "oauth-start" | "oauth-refresh" | "models-refresh" | "configuration-check" | "save" | "remove" | null
  >(null);
  const mountedRef = useRef(true);
  const requestControllersRef = useRef(new Set<AbortController>());
  const connectionsRef = useRef(connections);
  const onConnectionsChangedRef = useRef(onConnectionsChanged);
  const onDefaultSelectionSyncedRef = useRef(onDefaultSelectionSynced);
  const tRef = useRef(t);
  const chatGptConnected = connections.some(
    (connection) => connection.provider === "openai-codex" && connection.hasCredential,
  );
  const selectedProvider = PROVIDER_ITEMS.find((item) => item.value === provider) || PROVIDER_ITEMS[0];
  const connectionDraftDirty =
    name.length > 0 ||
    provider !== "openai-compatible" ||
    baseUrl.length > 0 ||
    apiKey.length > 0 ||
    model.length > 0;
  const mutationInProgress =
    oauthState === "starting" || oauthRefreshing || saving || removingConnection ||
    refreshingConnectionId !== null || checkingConnectionId !== null;

  useLayoutEffect(() => {
    connectionsRef.current = connections;
    onConnectionsChangedRef.current = onConnectionsChanged;
    onDefaultSelectionSyncedRef.current = onDefaultSelectionSynced;
    tRef.current = t;
  }, [connections, onConnectionsChanged, onDefaultSelectionSynced, t]);

  useUnsavedChangesGuard(
    (addDialogOpen && connectionDraftDirty) || mutationInProgress,
    () => {
      setName("");
      setProvider("openai-compatible");
      setBaseUrl("");
      setApiKey("");
      setModel("");
      setError("");
    },
    !mutationInProgress,
  );

  const requestJson = useCallback(
    async (
      input: string,
      init?: RequestInit,
      timeoutMs = 15_000,
      requestController?: AbortController,
    ): Promise<{ response: Response; result: JsonObject }> => {
      const controller = requestController || new AbortController();
      requestControllersRef.current.add(controller);
      const timeout = window.setTimeout(
        () => controller.abort(),
        Math.max(1, timeoutMs),
      );
      try {
        const response = await fetch(input, { ...init, signal: controller.signal });
        const responseText = await response.text();
        const parsed: unknown = responseText ? JSON.parse(responseText) : {};
        return {
          response,
          result:
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as JsonObject)
              : {},
        };
      } finally {
        window.clearTimeout(timeout);
        requestControllersRef.current.delete(controller);
      }
    },
    [],
  );

  const reload = useCallback(
    async (timeoutMs = 15_000, controller?: AbortController) => {
      const { response, result } = await requestJson(
        apiUrl("/api/connections"),
        undefined,
        timeoutMs,
        controller,
      );
      if (!response.ok || !Array.isArray(result.connections)) {
        throw new Error(tRef.current("settings.connectionRefreshFailed"));
      }
      const nextConnections = result.connections.filter(isModelConnection);
      if (nextConnections.length !== result.connections.length) {
        throw new Error(tRef.current("settings.connectionRefreshFailed"));
      }
      if (mountedRef.current) onConnectionsChangedRef.current(nextConnections);
    },
    [requestJson],
  );

  useEffect(() => {
    mountedRef.current = true;
    const requestControllers = requestControllersRef.current;
    return () => {
      mountedRef.current = false;
      for (const controller of requestControllers) controller.abort();
      requestControllers.clear();
      savingRef.current = false;
      removingRef.current = false;
      oauthFlowRef.current = false;
      mutationLockRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (oauthState !== "waiting") return;
    let cancelled = false;
    let pollTimer: number | null = null;
    let pollController: AbortController | null = null;
    const deadline = Date.now() + 120_000;

    const fail = (message: string) => {
      if (cancelled || !mountedRef.current) return;
      oauthFlowRef.current = false;
      setOauthState("error");
      setOauthError(message);
    };

    const poll = async () => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        fail(tRef.current("settings.requestTimedOut"));
        return;
      }

      pollController = new AbortController();
      try {
        const { response, result } = await requestJson(
          apiUrl("/api/oauth/chatgpt/status"),
          undefined,
          Math.min(5_000, remainingMs),
          pollController,
        );
        pollController = null;
        if (cancelled || !mountedRef.current) return;
        if (!response.ok) throw new Error("status request failed");
        if (
          result.status === "complete" &&
          mutationLockRef.current === null
        ) {
          const refreshRemainingMs = deadline - Date.now();
          if (refreshRemainingMs <= 0) {
            fail(tRef.current("settings.requestTimedOut"));
            return;
          }
          mutationLockRef.current = "oauth-refresh";
          setOauthRefreshing(true);
          pollController = new AbortController();
          try {
            await reload(
              Math.min(15_000, refreshRemainingMs),
              pollController,
            );
            pollController = null;
          } catch (refreshError) {
            pollController = null;
            if (cancelled || !mountedRef.current) return;
            fail(
              isAbortError(refreshError) && Date.now() >= deadline
                ? tRef.current("settings.requestTimedOut")
                : tRef.current("settings.connectionRefreshFailed"),
            );
            return;
          } finally {
            pollController = null;
            if (mutationLockRef.current === "oauth-refresh") {
              mutationLockRef.current = null;
            }
            if (mountedRef.current) setOauthRefreshing(false);
          }
          if (cancelled || !mountedRef.current) return;
          oauthFlowRef.current = false;
          setOauthError("");
          setOauthState("idle");
          setAddDialogOpen(false);
          return;
        } else if (result.status === "error") {
          fail(tRef.current("settings.oauthFailed"));
          return;
        }
      } catch (pollError) {
        pollController = null;
        if (cancelled || !mountedRef.current) return;
        if (!isAbortError(pollError) && Date.now() >= deadline) {
          fail(tRef.current("settings.oauthFailed"));
          return;
        }
      }
      const nextDelay = Math.min(1_000, deadline - Date.now());
      if (nextDelay <= 0) {
        fail(tRef.current("settings.requestTimedOut"));
        return;
      }
      pollTimer = window.setTimeout(() => void poll(), nextDelay);
    };

    void poll();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollController?.abort();
    };
  }, [oauthState, reload, requestJson]);

  async function connectChatGpt() {
    if (
      oauthFlowRef.current ||
      mutationLockRef.current !== null ||
      oauthState === "starting" ||
      oauthState === "waiting"
    ) {
      return;
    }
    oauthFlowRef.current = true;
    mutationLockRef.current = "oauth-start";
    setOauthState("starting");
    setOauthError("");
    let waitingForCallback = false;
    try {
      const { response, result } = await requestJson(
        apiUrl("/api/oauth/chatgpt/start"),
        { method: "POST" },
      );
      if (!response.ok || typeof result.authUrl !== "string") {
        throw new Error("OAuth start failed");
      }
      if (!mountedRef.current) return;
      await openExternal(result.authUrl);
      if (mountedRef.current) {
        waitingForCallback = true;
        setOauthState("waiting");
      }
    } catch (connectError) {
      if (mountedRef.current) {
        setOauthState("error");
        setOauthError(
          isAbortError(connectError)
            ? tRef.current("settings.requestTimedOut")
            : tRef.current("settings.oauthFailed"),
        );
      }
    } finally {
      if (!waitingForCallback) oauthFlowRef.current = false;
      if (mutationLockRef.current === "oauth-start") {
        mutationLockRef.current = null;
      }
    }
  }

  async function addConnection() {
    if (savingRef.current || mutationLockRef.current !== null) return;
    savingRef.current = true;
    mutationLockRef.current = "save";
    setSaving(true);
    setError("");
    try {
      const { response, result } = await requestJson(
        apiUrl("/api/connections"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, provider, baseUrl, apiKey, model }),
        },
      );
      if (!response.ok || !isModelConnection(result.connection)) {
        throw new Error("Connection save failed");
      }
      const savedConnection = result.connection;
      if (mountedRef.current) {
        onConnectionsChangedRef.current([
          ...connectionsRef.current.filter(
            (connection) => connection.id !== savedConnection.id,
          ),
          savedConnection,
        ]);
        setName("");
        setProvider("openai-compatible");
        setBaseUrl("");
        setApiKey("");
        setModel("");
        setAddDialogOpen(false);
      }
    } catch (saveError) {
      if (mountedRef.current) {
        setError(
          isAbortError(saveError)
            ? tRef.current("settings.requestTimedOut")
            : tRef.current("settings.connectionSaveFailed"),
        );
      }
    } finally {
      savingRef.current = false;
      if (mutationLockRef.current === "save") mutationLockRef.current = null;
      if (mountedRef.current) setSaving(false);
    }
  }

  async function removeConnection() {
    if (
      !connectionToRemove ||
      removingRef.current ||
      mutationLockRef.current !== null
    ) {
      return;
    }
    const target = connectionToRemove;
    removingRef.current = true;
    mutationLockRef.current = "remove";
    setRemovingConnection(true);
    setRemoveError("");
    try {
      const { response, result } = await requestJson(
        apiUrl(`/api/connections/${target.id}`),
        { method: "DELETE" },
      );
      if (!response.ok) {
        const retainedConnection = result.connection;
        if (isModelConnection(retainedConnection)) {
          onConnectionsChangedRef.current(connectionsRef.current.map((connection) =>
            connection.id === retainedConnection.id ? retainedConnection : connection,
          ));
        }
        if (result.credentialRemoved === true) {
          throw new Error(tRef.current("settings.removeConnectionRecoverable"));
        }
        if (result.isDefault === true) {
          throw new Error(tRef.current("settings.removeDefaultConnectionBlocked"));
        }
        if (typeof result.inUseByAgents === "number" && result.inUseByAgents > 0) {
          throw new Error(
            tRef.current("settings.removeUsedConnectionBlocked")
              .replace("{count}", String(result.inUseByAgents)),
          );
        }
        throw new Error(tRef.current("settings.removeConnectionFailed"));
      }
      if (mountedRef.current) {
        onConnectionsChangedRef.current(
          connectionsRef.current.filter((connection) => connection.id !== target.id),
        );
        setConnectionToRemove(null);
      }
    } catch (removeError) {
      if (mountedRef.current) {
        setRemoveError(
          isAbortError(removeError)
            ? tRef.current("settings.requestTimedOut")
            : removeError instanceof Error
              ? removeError.message
              : tRef.current("settings.removeConnectionFailed"),
        );
      }
    } finally {
      removingRef.current = false;
      if (mutationLockRef.current === "remove") mutationLockRef.current = null;
      if (mountedRef.current) setRemovingConnection(false);
    }
  }

  async function refreshModels(connection: ModelConnection) {
    if (mutationLockRef.current !== null) return;
    mutationLockRef.current = "models-refresh";
    setRefreshingConnectionId(connection.id);
    setModelRefreshError("");
    try {
      const { response, result } = await requestJson(
        apiUrl(`/api/connections/${connection.id}/refresh`),
        { method: "POST" },
      );
      if (!response.ok || !isModelConnection(result.connection)) {
        throw new Error("Model catalog refresh failed");
      }
      const refreshed = result.connection;
      if (mountedRef.current) {
        onConnectionsChangedRef.current(connectionsRef.current.map((entry) =>
          entry.id === refreshed.id ? refreshed : entry,
        ));
        if (isDefaultSelection(result.settings)) {
          onDefaultSelectionSyncedRef.current({
            runtime: result.settings.defaultRuntime,
            model: result.settings.defaultModel,
            connectionId: result.settings.defaultConnectionId,
          });
        }
      }
    } catch (refreshError) {
      if (mountedRef.current) {
        setModelRefreshError(
          isAbortError(refreshError)
            ? tRef.current("settings.requestTimedOut")
            : tRef.current("settings.connectionRefreshFailed"),
        );
      }
    } finally {
      if (mutationLockRef.current === "models-refresh") mutationLockRef.current = null;
      if (mountedRef.current) setRefreshingConnectionId(null);
    }
  }

  async function checkConfiguration(connection: ModelConnection) {
    if (mutationLockRef.current !== null) return;
    mutationLockRef.current = "configuration-check";
    setCheckingConnectionId(connection.id);
    setConfigurationNotice("");
    setModelRefreshError("");
    try {
      const { response, result } = await requestJson(
        apiUrl(`/api/connections/${connection.id}/test`),
        { method: "POST" },
      );
      if (!response.ok || result.probe !== "configuration") {
        throw new Error("Configuration check failed");
      }
      if (mountedRef.current) {
        setConfigurationNotice(tRef.current("settings.configurationValid"));
        await reload();
      }
    } catch (checkError) {
      if (mountedRef.current) {
        setConfigurationNotice(tRef.current("settings.configurationInvalid"));
        setModelRefreshError(
          isAbortError(checkError)
            ? tRef.current("settings.requestTimedOut")
            : tRef.current("settings.configurationInvalid"),
        );
      }
    } finally {
      if (mutationLockRef.current === "configuration-check") mutationLockRef.current = null;
      if (mountedRef.current) setCheckingConnectionId(null);
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("settings.connections")}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t("settings.connectionsHint")}
          </p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => setAddDialogOpen(true)}>
          <Plus />
          {t("settings.addConnectionTitle")}
        </Button>
      </div>

      <Card>
        <CardPanel className="divide-y p-0">
          {runtimes.filter((runtime) => runtime.installed && runtime.id !== "pi").map((runtime) => {
            const isDefault = defaultConnectionId === null && defaultRuntime === runtime.id;
            return (
              <div key={runtime.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
                  <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{runtime.name}</p>
                    {isDefault && <Badge variant="secondary">{t("settings.defaultBadge")}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t("settings.localManagedConnection")}
                  </p>
                </div>
                <Badge className="shrink-0" variant="success"><Check />{t("settings.runtimeInstalled")}</Badge>
                {!isDefault && (
                  <Menu>
                    <MenuTrigger
                      aria-label={t("settings.connectionActions")}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Ellipsis className="size-4" />
                    </MenuTrigger>
                    <MenuPopup align="end" className="min-w-40">
                      <MenuItem onClick={() => onSetRuntimeDefault(runtime.id)}>
                        <Check /> {t("settings.setDefault")}
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                )}
              </div>
            );
          })}
          {connections.length === 0 && runtimes.every((runtime) => !runtime.installed || runtime.id === "pi") ? (
            <p className="px-4 py-5 text-sm text-muted-foreground">
              {t("settings.noConnections")}
            </p>
          ) : connections.map((connection) => {
            const ready = connection.status === "connected" && connection.models.length > 0;
            const isDefault = connection.id === defaultConnectionId;
            return (
              <div key={connection.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-muted-foreground">
                  <Bot className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium">{connection.name}</p>
                    {isDefault && <Badge variant="secondary">{t("settings.defaultBadge")}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {connection.auth_type === "oauth" ? "OAuth" : "API key"} · {connection.default_model} · {connection.models.length > 0
                      ? t("settings.modelsCount").replace("{count}", String(connection.models.length))
                      : t("settings.modelCatalogEmpty")}
                  </p>
                  {connection.auth_error && (
                    <p className="mt-0.5 truncate text-xs text-destructive">{connection.auth_error}</p>
                  )}
                </div>
                <Badge className="shrink-0" variant={ready ? "success" : "error"}>
                  {ready ? <Check /> : <AlertCircle />}
                  {ready ? t("settings.connected") : t("settings.configurationInvalid")}
                </Badge>
                <Menu>
                  <MenuTrigger
                    aria-label={t("settings.connectionActions")}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    disabled={mutationInProgress}
                  >
                    <Ellipsis className="size-4" />
                  </MenuTrigger>
                  <MenuPopup align="end" className="min-w-44">
                    {!isDefault && ready && (
                      <MenuItem onClick={() => onSetDefault(connection)}>
                        <Check /> {t("settings.setDefault")}
                      </MenuItem>
                    )}
                    {connection.model_selection_mode === "automatically-synced" && (
                      <MenuItem onClick={() => void refreshModels(connection)}>
                        <RefreshCw className={refreshingConnectionId === connection.id ? "animate-spin motion-reduce:animate-none" : ""} />
                        {t("settings.refreshModels")}
                      </MenuItem>
                    )}
                    <MenuItem onClick={() => void checkConfiguration(connection)}>
                      <Check />
                      {checkingConnectionId === connection.id
                        ? t("settings.configurationChecking")
                        : t("settings.configurationCheck")}
                    </MenuItem>
                    <MenuItem
                      variant="destructive"
                      onClick={() => {
                        setRemoveError("");
                        setConnectionToRemove(connection);
                      }}
                    >
                      {t("settings.removeConnection")}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            );
          })}
        </CardPanel>
      </Card>

      {modelRefreshError && (
        <p className="text-xs text-destructive" role="alert">{modelRefreshError}</p>
      )}
      {configurationNotice && !modelRefreshError && (
        <p className="text-xs text-muted-foreground" role="status">{configurationNotice}</p>
      )}

      <Dialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          if (!open && mutationInProgress) return;
          setAddDialogOpen(open);
          if (!open) {
            setName("");
            setProvider("openai-compatible");
            setBaseUrl("");
            setApiKey("");
            setModel("");
            setError("");
            setOauthError("");
          }
        }}
      >
        <DialogPopup>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void addConnection();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("settings.addConnectionTitle")}</DialogTitle>
              <DialogDescription>{t("settings.addConnectionDescription")}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
              {!chatGptConnected && (
                <div className="flex items-center justify-between gap-4 rounded-xl border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t("settings.chatGptOAuth")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t("settings.chatGptOAuthHint")}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={connectChatGpt}
                    disabled={mutationInProgress}
                  >
                    {oauthState === "starting" || oauthState === "waiting"
                      ? t("settings.connecting")
                      : t("settings.connect")}
                  </Button>
                </div>
              )}
              {oauthError && <p className="text-xs text-destructive" role="alert">{oauthError}</p>}
              {!chatGptConnected && <Separator />}
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("settings.addApi")}
              </p>
                <Field>
                  <FieldLabel>{t("settings.connectionName")}</FieldLabel>
                  <Input
                    value={name}
                    disabled={mutationInProgress}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="OpenRouter"
                  />
                </Field>
                <Field>
                  <FieldLabel>{t("settings.provider")}</FieldLabel>
                  <Select
                    items={PROVIDER_ITEMS}
                    value={selectedProvider}
                    disabled={mutationInProgress}
                    onValueChange={(next) => {
                      if (next) {
                        setProvider(
                          (next as typeof selectedProvider).value as typeof provider,
                        );
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {PROVIDER_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{t("settings.baseUrl")}</FieldLabel>
                  <Input
                    value={baseUrl}
                    disabled={mutationInProgress}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.example.com/v1"
                  />
                </Field>
                <Field>
                  <FieldLabel>{t("settings.apiKey")}</FieldLabel>
                  <Input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    disabled={mutationInProgress}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>{t("settings.connectionModel")}</FieldLabel>
                  <Input
                    value={model}
                    disabled={mutationInProgress}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="model-id"
                  />
                </Field>
                {error && (
                  <p className="text-xs text-destructive" role="alert">
                    {error}
                  </p>
                )}
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={mutationInProgress} onClick={() => setAddDialogOpen(false)}>
                {t("settings.cancel")}
              </Button>
              <Button
                type="submit"
                loading={saving}
                disabled={mutationInProgress || !name.trim() || !baseUrl.trim() || !apiKey.trim() || !model.trim()}
              >
                {t("settings.addConnection")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={connectionToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removingConnection) setConnectionToRemove(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.removeConnectionTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.removeConnectionDescription")}{" "}
              <span className="font-medium text-foreground">
                {connectionToRemove?.name}
              </span>
            </AlertDialogDescription>
            {removeError && (
              <p className="text-sm text-destructive" role="alert">
                {removeError}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={removingConnection}
              onClick={() => setConnectionToRemove(null)}
            >
              {t("settings.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={removingConnection}
              disabled={mutationInProgress}
              onClick={() => void removeConnection()}
            >
              {t("settings.removeConnection")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
