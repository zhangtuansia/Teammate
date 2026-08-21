"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { Field, FieldLabel } from "@/components/ui/field";
import { apiUrl } from "@/lib/api-url";
import { useAppSettings, type ThinkingLevel } from "@/hooks/use-app-settings";
import {
  CODEX_MODEL_ITEMS,
  resolveAgentRuntimeSelection,
  runtimeSelectionIssueMessage,
  type AgentRuntimeId,
} from "@/lib/agent-runtime";
import {
  installedAgentRuntimeIds,
  loadAgentRuntimes,
  type AgentRuntimeStatus,
} from "@/lib/agent-runtime-status";
import {
  loadModelConnections,
  type ModelConnection,
} from "@/lib/model-connections";
import { agentProviderItems } from "@/lib/model-provider-registry";

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  serverId: string;
}

const CONNECTION_LOAD_TIMEOUT_MS = 15_000;
const CREATE_AGENT_TIMEOUT_MS = 20_000;

function getResponseError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (
    record.error &&
    typeof record.error === "object" &&
    typeof (record.error as Record<string, unknown>).message === "string"
  ) {
    return (record.error as Record<string, unknown>).message as string;
  }
  return typeof record.message === "string" ? record.message : null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Server returned an invalid response (HTTP ${response.status})`);
  }
}

export function CreateAgentDialog({
  open,
  onClose,
  onCreated,
  serverId,
}: CreateAgentDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState<AgentRuntimeId>("codex");
  const [model, setModel] = useState("default");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>("medium");
  const [connections, setConnections] = useState<ModelConnection[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntimeStatus[] | null>(null);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mountedRef = useRef(false);
  const savingRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const connectionLoadGenerationRef = useRef(0);
  const activeRequestRef = useRef<{
    controller: AbortController;
    deadlineTimer: number;
    generation: number;
    rejectPending: (reason: Error) => void;
    serverId: string;
    timedOut: boolean;
  } | null>(null);
  const activeConnectionLoadRef = useRef<{
    controller: AbortController;
    deadlineTimer: number;
    generation: number;
    timedOut: boolean;
  } | null>(null);
  const { settings, t } = useAppSettings();
  const localMode = process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true";
  const modelItems = [
    { value: "opus", label: t("settings.modelOpus") },
    { value: "sonnet", label: t("settings.modelSonnet") },
    { value: "haiku", label: t("settings.modelHaiku") },
  ];
  const thinkingItems: Array<{ value: ThinkingLevel; label: string }> = [
    { value: "low", label: t("settings.thinkingLow") },
    { value: "medium", label: t("settings.thinkingMedium") },
    { value: "high", label: t("settings.thinkingHigh") },
  ];
  const selectedThinkingLevel = thinkingItems.find((item) => item.value === thinkingLevel) || thinkingItems[1];
  const runtimeItems = [
    { value: "claude-code", label: t("settings.runtimeClaude") },
    { value: "codex", label: t("settings.runtimeCodex") },
    ...(localMode ? [{ value: "pi", label: t("settings.runtimePi") }] : []),
  ];
  const connectionTimeoutMessage = settings.language === "zh-CN"
    ? "运行时与模型连接加载超时，请稍后重试。"
    : "Loading runtimes and model connections timed out. Try again shortly.";
  const creationTimeoutMessage = settings.language === "zh-CN"
    ? "创建请求超时。请先检查侧栏，再重试以免重复创建。"
    : "The creation request timed out. Check the sidebar before retrying to avoid a duplicate.";
  const creationCancelledMessage = settings.language === "zh-CN"
    ? "已取消创建请求。若服务端已经完成，智能体仍会出现在侧栏中。"
    : "The creation request was cancelled. If the server already finished, the agent will still appear in the sidebar.";
  const cancelCreationLabel = settings.language === "zh-CN"
    ? "取消创建"
    : "Cancel creation";

  const invalidateConnectionLoad = useCallback(() => {
    const activeLoad = activeConnectionLoadRef.current;
    if (!activeLoad) return false;

    activeConnectionLoadRef.current = null;
    if (connectionLoadGenerationRef.current === activeLoad.generation) {
      connectionLoadGenerationRef.current += 1;
    }
    window.clearTimeout(activeLoad.deadlineTimer);
    activeLoad.controller.abort();
    return true;
  }, []);

  const invalidateActiveRequest = useCallback(() => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return false;

    requestGenerationRef.current += 1;
    activeRequestRef.current = null;
    savingRef.current = false;
    window.clearTimeout(activeRequest.deadlineTimer);
    activeRequest.controller.abort();
    activeRequest.rejectPending(new DOMException("Creation cancelled", "AbortError"));
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateConnectionLoad();
      invalidateActiveRequest();
    };
  }, [invalidateActiveRequest, invalidateConnectionLoad]);

  useEffect(() => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest || (open && activeRequest.serverId === serverId)) return;

    invalidateActiveRequest();
    const frame = window.requestAnimationFrame(() => {
      if (mountedRef.current) setSaving(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [invalidateActiveRequest, open, serverId]);

  useEffect(() => {
    const generation = ++connectionLoadGenerationRef.current;
    if (!open || savingRef.current) return;

    const frame = window.requestAnimationFrame(() => {
      if (connectionLoadGenerationRef.current !== generation) return;
      savingRef.current = false;
      setSaving(false);
      setDisplayName("");
      setDescription("");
      setRuntime(settings.defaultRuntime);
      setModel(settings.defaultModel);
      setConnectionId(settings.defaultConnectionId);
      setThinkingLevel(settings.defaultThinkingLevel);
      setSystemPrompt("");
      setError("");
      setRuntimes(null);
      if (localMode) {
        const controller = new AbortController();
        const activeLoad = {
          controller,
          deadlineTimer: 0,
          generation,
          timedOut: false,
        };
        activeConnectionLoadRef.current = activeLoad;
        activeLoad.deadlineTimer = window.setTimeout(() => {
          if (activeConnectionLoadRef.current !== activeLoad) return;
          activeLoad.timedOut = true;
          controller.abort();
        }, CONNECTION_LOAD_TIMEOUT_MS);

        void Promise.all([
          loadModelConnections(controller.signal),
          loadAgentRuntimes(controller.signal),
        ])
          .then(([nextConnections, nextRuntimes]) => {
            if (
              connectionLoadGenerationRef.current === generation &&
              activeConnectionLoadRef.current === activeLoad &&
              !controller.signal.aborted &&
              !savingRef.current
            ) {
              setConnections(nextConnections);
              setRuntimes(nextRuntimes);
              const installed = installedAgentRuntimeIds(nextRuntimes);
              const configured = resolveAgentRuntimeSelection({
                runtime: settings.defaultRuntime,
                model: settings.defaultModel,
                connectionId: settings.defaultConnectionId,
              }, nextConnections, installed);
              const candidates = [
                configured,
                resolveAgentRuntimeSelection({ runtime: "codex" }, nextConnections, installed),
                resolveAgentRuntimeSelection({ runtime: "claude-code" }, nextConnections, installed),
                ...nextConnections.map((connection) => resolveAgentRuntimeSelection({
                  runtime: "pi",
                  connectionId: connection.id,
                }, nextConnections, installed)),
              ];
              const availableDefault = candidates.find((candidate) => !candidate.issue);
              if (availableDefault) {
                setRuntime(availableDefault.selection.runtime);
                setModel(availableDefault.selection.model);
                setConnectionId(availableDefault.selection.connectionId);
              }
            }
          })
          .catch((loadError: unknown) => {
            if (
              connectionLoadGenerationRef.current === generation &&
              activeConnectionLoadRef.current === activeLoad &&
              !savingRef.current
            ) {
              setConnections([]);
              setRuntimes(null);
              setError(
                activeLoad.timedOut
                  ? connectionTimeoutMessage
                  : settings.language === "zh-CN"
                    ? "无法加载运行时与模型连接，请稍后重试。"
                    : loadError instanceof Error
                      ? loadError.message
                      : "Failed to load runtimes and model connections",
              );
            }
          })
          .finally(() => {
            window.clearTimeout(activeLoad.deadlineTimer);
            if (activeConnectionLoadRef.current === activeLoad) {
              activeConnectionLoadRef.current = null;
            }
          });
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (activeConnectionLoadRef.current?.generation === generation) {
        invalidateConnectionLoad();
      }
      if (connectionLoadGenerationRef.current === generation) {
        connectionLoadGenerationRef.current += 1;
      }
    };
  }, [connectionTimeoutMessage, invalidateConnectionLoad, localMode, open, settings.defaultConnectionId, settings.defaultModel, settings.defaultRuntime, settings.defaultThinkingLevel, settings.language]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim() || savingRef.current) return;

    const resolved = resolveAgentRuntimeSelection(
      { runtime, model, connectionId },
      connections,
      localMode ? installedAgentRuntimeIds(runtimes || []) : undefined,
    );
    if (resolved.issue) {
      setError(runtimeSelectionIssueMessage(resolved.issue, settings.language));
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setError("");
    invalidateConnectionLoad();
    const controller = new AbortController();
    const generation = ++requestGenerationRef.current;
    const activeRequest: NonNullable<typeof activeRequestRef.current> = {
      controller,
      deadlineTimer: 0,
      generation,
      rejectPending: () => undefined,
      serverId,
      timedOut: false,
    };
    activeRequestRef.current = activeRequest;
    const ownsRequest = () =>
      mountedRef.current &&
      activeRequestRef.current === activeRequest;
    const canContinue = () => ownsRequest() && !controller.signal.aborted;
    const deadline = new Promise<never>((_, reject) => {
      activeRequest.rejectPending = reject;
      activeRequest.deadlineTimer = window.setTimeout(() => {
        if (!ownsRequest()) return;
        activeRequest.timedOut = true;
        controller.abort();
        reject(new Error(creationTimeoutMessage));
      }, CREATE_AGENT_TIMEOUT_MS);
    });

    try {
      await Promise.race([
        (async () => {
          const supabase = createClient();
          const { error: sessionError } = await supabase.auth.getSession();
          if (!canContinue()) return;
          if (sessionError) throw new Error(sessionError.message);

          const res = await fetch(apiUrl("/api/agents"), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: document.cookie,
            },
            body: JSON.stringify({
              display_name: displayName,
              description,
              runtime: resolved.selection.runtime,
              model: resolved.selection.model,
              connection_id: resolved.selection.connectionId,
              ...(localMode ? { thinking_level: thinkingLevel } : {}),
              system_prompt: systemPrompt,
              server_id: serverId,
            }),
            signal: controller.signal,
          });
          if (!canContinue()) return;

          const data = await readResponsePayload(res);
          if (!canContinue()) return;
          if (!res.ok) {
            throw new Error(
              getResponseError(data) ||
                `Failed to create agent (HTTP ${res.status})`,
            );
          }
        })(),
        deadline,
      ]);
      if (!canContinue()) return;

      onCreated();
      onClose();
    } catch (err) {
      if (ownsRequest()) {
        if (activeRequest.timedOut) onCreated();
        setError(
          activeRequest.timedOut
            ? creationTimeoutMessage
            : err instanceof Error
              ? err.message
              : "Failed to create agent",
        );
      }
    } finally {
      window.clearTimeout(activeRequest.deadlineTimer);
      if (activeRequestRef.current === activeRequest) {
        activeRequestRef.current = null;
        savingRef.current = false;
        if (mountedRef.current) setSaving(false);
      }
    }
  }

  function handleCancelCreation() {
    if (!invalidateActiveRequest()) return;
    setSaving(false);
    setError(creationCancelledMessage);
    onCreated();
  }

  const selectedModel = modelItems.find((item) => item.value === model) ?? modelItems[0];
  const selectedRuntime = runtimeItems.find((item) => item.value === runtime) ?? runtimeItems[0];
  const codexModelItems: Array<{ value: string; label: string }> = CODEX_MODEL_ITEMS.map((item) => ({
    ...item,
    label: item.value === "default"
      ? (settings.language === "zh-CN" ? "自动（推荐）" : item.label)
      : item.label,
  }));
  const selectedCodexModel = codexModelItems.find((item) => item.value === model) ?? codexModelItems[0];
  const resolvedSelection = resolveAgentRuntimeSelection(
    { runtime, model, connectionId },
    connections,
    localMode ? installedAgentRuntimeIds(runtimes || []) : undefined,
  );
  const selectionError = runtimeSelectionIssueMessage(
    resolvedSelection.issue,
    settings.language,
  );
  const connectionItems = [
    { value: "", label: "—" },
    ...connections
      .filter((connection) => connection.hasCredential)
      .map((connection) => ({ value: connection.id, label: connection.name })),
  ];
  const selectedConnection = connectionItems.find((item) => item.value === connectionId) ?? connectionItems[0];
  const providerItems = localMode
    ? agentProviderItems(connections, runtimes, settings.language)
    : [];
  const selectedProviderValue = runtime === "pi" && connectionId
    ? `connection:${connectionId}`
    : `runtime:${runtime}`;
  const selectedProvider = providerItems.find((item) => item.value === selectedProviderValue) ?? providerItems[0];
  const activeConnection = connections.find((connection) => connection.id === connectionId);
  const selectionSupportsThinking = runtime === "codex" || (
    runtime === "pi" &&
    activeConnection?.models.find((modelDefinition) => modelDefinition.id === model)?.reasoning === true
  );
  const connectionModelItems = resolvedSelection.models.map((value) => ({
    value,
    label: activeConnection?.models.find((modelDefinition) => modelDefinition.id === value)?.name || value,
  }));
  const selectedConnectionModel = connectionModelItems.find((item) => item.value === model) ?? connectionModelItems[0];

  const applyResolvedSelection = (next: ReturnType<typeof resolveAgentRuntimeSelection>) => {
    setRuntime(next.selection.runtime);
    setModel(next.selection.model);
    setConnectionId(next.selection.connectionId);
    setError("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !savingRef.current) onClose();
      }}
    >
      <DialogPopup closeProps={{ disabled: saving }}>
        <DialogHeader>
          <DialogTitle>{t("createAgent.title")}</DialogTitle>
          <DialogDescription>{t("createAgent.description")}</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit} aria-busy={saving}>
          <DialogPanel>
            <div className="space-y-4">
              <Field>
                <FieldLabel>{t("createAgent.name")}</FieldLabel>
                <Input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName((e.target as HTMLInputElement).value)}
                  placeholder={t("createAgent.namePlaceholder")}
                  required
                  autoFocus
                />
              </Field>

              <Field>
                <FieldLabel>
                  {t("createAgent.descriptionField")} <span className="text-muted-foreground font-normal">({t("createAgent.optional")})</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder={t("createAgent.descriptionPlaceholder")}
                />
              </Field>

              {localMode ? (
                <Field>
                  <FieldLabel>{settings.language === "zh-CN" ? "模型连接" : "Model connection"}</FieldLabel>
                  <Select
                    value={selectedProvider}
                    items={providerItems}
                    onValueChange={(next) => {
                      if (!next) return;
                      const value = (next as typeof selectedProvider).value;
                      if (value.startsWith("connection:")) {
                        applyResolvedSelection(resolveAgentRuntimeSelection({
                          runtime: "pi",
                          connectionId: value.slice("connection:".length),
                        }, connections, installedAgentRuntimeIds(runtimes || [])));
                      } else {
                        applyResolvedSelection(resolveAgentRuntimeSelection({
                          runtime: value.slice("runtime:".length),
                        }, connections, installedAgentRuntimeIds(runtimes || [])));
                      }
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectPopup>
                      {providerItems.map((item) => (
                        <SelectItem disabled={item.disabled} key={item.value} value={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              ) : (
              <Field>
                <FieldLabel>{t("createAgent.runtime")}</FieldLabel>
                <Select
                  value={selectedRuntime}
                  items={runtimeItems}
                  onValueChange={(next) => {
                    if (!next) return;
                    const nextRuntime = (next as typeof selectedRuntime).value as AgentRuntimeId;
                    applyResolvedSelection(resolveAgentRuntimeSelection({
                      runtime: nextRuntime,
                    }, connections));
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectPopup>
                    {runtimeItems.map((item) => (
                      <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </Field>
              )}

              <Field>
                <FieldLabel>{t("createAgent.model")}</FieldLabel>
                {runtime === "claude-code" ? (
                  <Select
                    value={selectedModel}
                    onValueChange={(val) => {
                      if (val) setModel((val as typeof selectedModel).value);
                    }}
                    items={modelItems}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectPopup>
                      {modelItems.map((item) => (
                        <SelectItem key={item.value} value={item}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : runtime === "codex" ? (
                  <Select
                    value={selectedCodexModel}
                    items={codexModelItems}
                    onValueChange={(next) => {
                      if (next) setModel((next as typeof selectedCodexModel).value);
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectPopup>
                      {codexModelItems.map((item) => (
                        <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <Select
                    value={selectedConnectionModel}
                    items={connectionModelItems}
                    onValueChange={(next) => {
                      if (next) setModel((next as typeof selectedConnectionModel).value);
                    }}
                  >
                    <SelectTrigger><SelectValue placeholder={settings.language === "zh-CN" ? "选择可用模型" : "Choose an available model"} /></SelectTrigger>
                    <SelectPopup>
                      {connectionModelItems.map((item) => (
                        <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                )}
              </Field>

              {!localMode && runtime === "pi" && (
                <Field>
                  <FieldLabel>{t("settings.chooseConnection")}</FieldLabel>
                  <Select
                    value={selectedConnection}
                    items={connectionItems}
                    onValueChange={(next) => {
                      if (!next) return;
                      const connection = connections.find((entry) => entry.id === (next as typeof selectedConnection).value);
                      setConnectionId(connection?.id || null);
                      if (connection) setModel(connection.default_model);
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectPopup>
                      {connectionItems.map((item) => (
                        <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              )}

              {selectionError && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs text-warning-foreground" role="alert">
                  <p>{selectionError}</p>
                  {resolvedSelection.models.length > 0 && (
                    <Button
                      className="mt-2"
                      size="xs"
                      type="button"
                      variant="outline"
                      onClick={() => applyResolvedSelection(resolveAgentRuntimeSelection({
                        runtime,
                        connectionId,
                      }, connections, localMode ? installedAgentRuntimeIds(runtimes || []) : undefined))}
                    >
                      {settings.language === "zh-CN" ? "使用推荐模型" : "Use recommended model"}
                    </Button>
                  )}
                </div>
              )}

              {localMode && selectionSupportsThinking && (
                <Field>
                  <FieldLabel>{t("settings.thinkingLevel")}</FieldLabel>
                  <Select
                    items={thinkingItems}
                    value={selectedThinkingLevel}
                    onValueChange={(next) => {
                      if (next) setThinkingLevel((next as { value: ThinkingLevel }).value);
                    }}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectPopup>
                      {thinkingItems.map((item) => (
                        <SelectItem key={item.value} value={item}>{item.label}</SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
              )}

              <Field>
                <FieldLabel>
                  {t("createAgent.instructions")} <span className="text-muted-foreground font-normal">({t("createAgent.optional")})</span>
                </FieldLabel>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt((e.target as HTMLTextAreaElement).value)}
                  placeholder={t("createAgent.instructionsPlaceholder")}
                />
              </Field>

              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            {saving ? (
              <Button
                variant="ghost"
                type="button"
                onClick={handleCancelCreation}
              >
                {cancelCreationLabel}
              </Button>
            ) : (
              <DialogClose
                render={
                  <Button variant="ghost" type="button" />
                }
              >
                {t("createAgent.cancel")}
              </DialogClose>
            )}
            <Button
              type="submit"
              loading={saving}
              disabled={
                saving ||
                !displayName.trim() ||
                Boolean(resolvedSelection.issue)
              }
            >
              {t("createAgent.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
