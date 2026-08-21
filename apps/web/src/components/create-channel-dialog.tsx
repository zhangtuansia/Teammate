"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Field, FieldLabel } from "@/components/ui/field";
import { GeneratedAvatar } from "./generated-avatar";
import { useAppSettings } from "@/hooks/use-app-settings";
import { withRequestDeadline } from "@/lib/request-deadline";

interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  avatar_url: string | null;
  status: string;
}

interface CreateChannelDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  serverId: string;
}

export function CreateChannelDialog({
  open,
  onClose,
  onCreated,
  serverId,
}: CreateChannelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentSearch, setAgentSearch] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    new Set()
  );
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsLoadError, setAgentsLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const selectedAgentIdsRef = useRef<Set<string>>(new Set());
  const savingRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const loadGenerationRef = useRef(0);
  const supabase = createClient();
  const { t } = useAppSettings();

  const fetchEligibleAgents = useCallback(async (signal: AbortSignal) => {
    const { data, error: directoryError } = await supabase
      .rpc("list_workspace_agent_directory", { server_uuid: serverId })
      .abortSignal(signal);
    if (directoryError) throw new Error(directoryError.message);
    return (data || []) as Agent[];
  }, [serverId, supabase]);

  const loadAgents = useCallback(async (preserveSelection: boolean) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setAgentsLoading(true);
    setAgentsLoadError("");
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const eligibleAgents = await fetchEligibleAgents(controller.signal);
      if (loadGenerationRef.current !== generation) return;
      const eligibleIds = new Set(eligibleAgents.map((agent) => agent.id));
      setAgents(eligibleAgents);
      const currentSelection = selectedAgentIdsRef.current;
      const nextSelection = preserveSelection
        ? new Set(Array.from(currentSelection).filter((id) => eligibleIds.has(id)))
        : new Set<string>();
      if (preserveSelection && nextSelection.size < currentSelection.size) {
        setError(t("channel.agentEligibilityChanged"));
      }
      selectedAgentIdsRef.current = nextSelection;
      setSelectedAgentIds(nextSelection);
    } catch (loadError) {
      if (loadGenerationRef.current !== generation) return;
      setAgentsLoadError(
        controller.signal.aborted
          ? t("channel.loadTimedOut")
          : loadError instanceof Error
          ? loadError.message
          : t("channel.loadAgentsFailed"),
      );
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      if (loadGenerationRef.current === generation) setAgentsLoading(false);
    }
  }, [fetchEligibleAgents, t]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      setName("");
      setDescription("");
      setAgentSearch("");
      selectedAgentIdsRef.current = new Set();
      setSelectedAgentIds(new Set());
      setError("");
      setAgents([]);
      void loadAgents(false);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      loadGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, [loadAgents, open]);

  useEffect(() => {
    if (!open) return;
    const subscription = supabase
      .channel(`create-channel-agents:${serverId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agents",
          filter: `server_id=eq.${serverId}`,
        },
        () => {
          if (!savingRef.current) void loadAgents(true);
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "server_members",
          filter: `server_id=eq.${serverId}`,
        },
        () => {
          if (!savingRef.current) void loadAgents(true);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(subscription);
    };
  }, [loadAgents, open, serverId, supabase]);

  const duplicateDisplayNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of agents) {
      counts.set(agent.display_name, (counts.get(agent.display_name) || 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([displayName]) => displayName),
    );
  }, [agents]);
  const filteredAgents = useMemo(() => {
    const query = agentSearch.trim().toLocaleLowerCase();
    if (!query) return agents;
    return agents.filter((agent) =>
      [agent.display_name, agent.name, agent.description || ""]
        .some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [agentSearch, agents]);

  function toggleAgent(agentId: string) {
    if (savingRef.current) return;
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      selectedAgentIdsRef.current = next;
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current || agentsLoading || agentsLoadError || !name.trim()) return;

    savingRef.current = true;
    setSaving(true);
    setError("");
    const dialogGeneration = loadGenerationRef.current;
    const desiredAgentIds = new Set(selectedAgentIdsRef.current);
    let created = false;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);

    try {
      const userRequest = supabase.auth.getUser();
      const {
        data: { user },
        error: authError,
      } = await withRequestDeadline<Awaited<typeof userRequest>>(
        userRequest,
        20_000,
        () => controller.abort(),
      );
      if (authError) throw new Error(authError.message);
      if (!user) throw new Error(t("channel.notAuthenticated"));

      const latestEligibleAgents = await fetchEligibleAgents(controller.signal);
      const latestEligibleIds = new Set(
        latestEligibleAgents.map((agent) => agent.id),
      );
      const unavailableSelections = Array.from(desiredAgentIds).filter(
        (agentId) => !latestEligibleIds.has(agentId),
      );
      if (loadGenerationRef.current === dialogGeneration) {
        setAgents(latestEligibleAgents);
      }
      if (unavailableSelections.length > 0) {
        if (loadGenerationRef.current === dialogGeneration) {
          const nextSelection = new Set(
            Array.from(desiredAgentIds).filter((id) => latestEligibleIds.has(id)),
          );
          selectedAgentIdsRef.current = nextSelection;
          setSelectedAgentIds(nextSelection);
        }
        throw new Error(t("channel.agentEligibilityChanged"));
      }

      const { data: result, error: createError } = await supabase
        .rpc("create_channel_with_members", {
          server_uuid: serverId,
          channel_name: name.trim(),
          channel_description: description.trim() || null,
          channel_type: "public",
          selected_members: Array.from(desiredAgentIds).map((agentId) => ({
            member_id: agentId,
            member_type: "agent",
          })),
        })
        .abortSignal(controller.signal);

      if (
        createError ||
        !result ||
        typeof result !== "object" ||
        !("channel" in result)
      ) {
        const message = createError?.message || t("channel.createFailed");
        throw new Error(
          /unique|duplicate|channels_server_id_name/i.test(message)
            ? t("channel.nameInUse")
            : message,
        );
      }

      created = true;
    } catch (err) {
      if (loadGenerationRef.current === dialogGeneration) {
        setError(
          controller.signal.aborted
            ? t("channel.createTimedOut")
            : err instanceof Error ? err.message : t("channel.createFailed"),
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      savingRef.current = false;
      if (loadGenerationRef.current === dialogGeneration) setSaving(false);
    }

    if (loadGenerationRef.current !== dialogGeneration) return;
    if (created) {
      onCreated();
      onClose();
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !savingRef.current) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("createChannel.title")}</DialogTitle>
          <DialogDescription>{t("createChannel.description")}</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <fieldset disabled={saving} className="contents">
            <DialogPanel>
              <div className="space-y-4">
              <Field>
                <FieldLabel>{t("createChannel.name")}</FieldLabel>
                <div className="flex items-center gap-1">
                  <span className="text-muted-foreground text-sm">#</span>
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) =>
                      setName((e.target as HTMLInputElement).value.toLowerCase().replace(/\s+/g, "-"))
                    }
                    placeholder={t("createChannel.namePlaceholder")}
                    required
                    maxLength={80}
                    autoFocus
                    className="flex-1"
                  />
                </div>
              </Field>

              <Field>
                <FieldLabel>
                  {t("createChannel.descriptionField")} <span className="text-muted-foreground font-normal">({t("createChannel.optional")})</span>
                </FieldLabel>
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                  placeholder={t("createChannel.descriptionPlaceholder")}
                  maxLength={500}
                />
              </Field>

              <fieldset className="flex w-full flex-col items-start gap-2">
                <legend className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                  {t("createChannel.invite")} <span className="text-muted-foreground font-normal">({t("createChannel.optional")})</span>
                </legend>
                {agentsLoading ? (
                  <p className="text-sm text-muted-foreground" aria-live="polite">
                    {t("channel.loadingAgents")}
                  </p>
                ) : agentsLoadError ? (
                  <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                    <p className="min-w-0 text-sm text-destructive" role="alert">
                      {t("channel.loadAgentsFailed")} {agentsLoadError}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadAgents(true)}
                    >
                      {t("channel.retry")}
                    </Button>
                  </div>
                ) : agents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("channel.noEligibleAgents")}
                  </p>
                ) : (
                  <div className="w-full space-y-2">
                    <Input
                      type="search"
                      value={agentSearch}
                      onChange={(event) => setAgentSearch(event.target.value)}
                      placeholder={t("channel.searchAgents")}
                      aria-label={t("channel.searchAgents")}
                    />
                    <div className="max-h-64 overflow-y-auto rounded-lg border p-2">
                      {filteredAgents.length === 0 ? (
                        <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                          {t("channel.noMatchingAgents")}
                        </p>
                      ) : filteredAgents.map((agent) => (
                        <Label
                          key={agent.id}
                          htmlFor={`create-channel-agent-${agent.id}`}
                          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer transition-colors hover:bg-accent"
                        >
                          <Checkbox
                            id={`create-channel-agent-${agent.id}`}
                            aria-label={`${t("createChannel.invite")}: ${agent.display_name}${
                              duplicateDisplayNames.has(agent.display_name)
                                ? ` (@${agent.name})`
                                : ""
                            }`}
                            checked={selectedAgentIds.has(agent.id)}
                            onCheckedChange={() => toggleAgent(agent.id)}
                          />
                          <GeneratedAvatar
                            id={agent.id}
                            name={agent.display_name}
                            avatarUrl={agent.avatar_url}
                            size="xs"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex min-w-0 items-baseline gap-1.5 text-sm">
                              <span className="truncate">
                              {agent.display_name}
                              </span>
                              {duplicateDisplayNames.has(agent.display_name) && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  @{agent.name}
                                </span>
                              )}
                            </div>
                            {agent.description && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {agent.description}
                              </div>
                            )}
                          </div>
                        </Label>
                      ))}
                    </div>
                  </div>
                )}
              </fieldset>

                {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
              </div>
            </DialogPanel>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" type="button" />}>
                {t("createChannel.cancel")}
              </DialogClose>
              <Button
                type="submit"
                loading={saving}
                disabled={!name.trim() || agentsLoading || !!agentsLoadError}
              >
                {t("createChannel.submit")}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
