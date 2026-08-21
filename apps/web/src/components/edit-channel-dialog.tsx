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
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Trash2Icon } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  display_name: string;
  description: string | null;
  avatar_url: string | null;
  status: string;
}

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
  server_id: string;
}

interface EditChannelDialogProps {
  channel: Channel;
  open: boolean;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: (channelId: string) => void;
}

export function EditChannelDialog({
  channel,
  open,
  onClose,
  onUpdated,
  onDeleted,
}: EditChannelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [agentSearch, setAgentSearch] = useState("");
  const [memberAgentIds, setMemberAgentIds] = useState<Set<string>>(new Set());
  const [dataLoading, setDataLoading] = useState(false);
  const [dataLoadError, setDataLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const memberAgentIdsRef = useRef<Set<string>>(new Set());
  const loadedMemberAgentIdsRef = useRef<Set<string>>(new Set());
  const loadedChannelNameRef = useRef(channel.name);
  const loadedChannelDescriptionRef = useRef<string | null>(channel.description);
  const savingRef = useRef(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const draftDirtyRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const supabase = createClient();
  const { t } = useAppSettings();

  const fetchData = useCallback(async (signal: AbortSignal) => {
    const [directoryResult, channelMembersResult] =
      await Promise.all([
        supabase
          .rpc("list_workspace_agent_directory", {
            server_uuid: channel.server_id,
          })
          .abortSignal(signal),
        supabase
          .from("channel_members")
          .select("member_id")
          .eq("channel_id", channel.id)
          .eq("member_type", "agent")
          .abortSignal(signal),
      ]);

    if (directoryResult.error) throw new Error(directoryResult.error.message);
    if (channelMembersResult.error) {
      throw new Error(channelMembersResult.error.message);
    }

    const eligibleAgents = (directoryResult.data || []) as Agent[];
    const eligibleIds = new Set(eligibleAgents.map((agent) => agent.id));
    const channelMemberIds = new Set(
      ((channelMembersResult.data || []) as Array<{ member_id: string }>).map(
        (membership) => membership.member_id,
      ),
    );

    return {
      agents: eligibleAgents,
      eligibleIds,
      memberIds: new Set(
        Array.from(channelMemberIds).filter((id) => eligibleIds.has(id)),
      ),
    };
  }, [channel.id, channel.server_id, supabase]);

  const loadData = useCallback(async (preserveDraft: boolean) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setDataLoading(true);
    setDataLoadError("");
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const data = await fetchData(controller.signal);
      if (loadGenerationRef.current !== generation) return;
      setAllAgents(data.agents);
      const currentSelection = memberAgentIdsRef.current;
      const nextSelection = preserveDraft
        ? new Set(
            Array.from(currentSelection).filter((id) => data.eligibleIds.has(id)),
          )
        : data.memberIds;
      if (preserveDraft && nextSelection.size < currentSelection.size) {
        setError(t("channel.agentEligibilityChanged"));
      }
      memberAgentIdsRef.current = nextSelection;
      setMemberAgentIds(nextSelection);
      if (!preserveDraft) {
        loadedMemberAgentIdsRef.current = new Set(data.memberIds);
        draftDirtyRef.current = false;
      }
    } catch (loadError) {
      if (loadGenerationRef.current !== generation) return;
      setDataLoadError(
        controller.signal.aborted
          ? t("channel.loadTimedOut")
          : loadError instanceof Error
          ? loadError.message
          : t("channel.loadAgentsFailed"),
      );
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      if (loadGenerationRef.current === generation) setDataLoading(false);
    }
  }, [fetchData, t]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      setName(channel.name);
      setDescription(channel.description || "");
      setAgentSearch("");
      loadedChannelNameRef.current = channel.name;
      loadedChannelDescriptionRef.current = channel.description;
      setError("");
      setAllAgents([]);
      memberAgentIdsRef.current = new Set();
      loadedMemberAgentIdsRef.current = new Set();
      setMemberAgentIds(new Set());
      draftDirtyRef.current = false;
      void loadData(false);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      loadGenerationRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    };
  }, [channel.description, channel.name, loadData, open]);

  useEffect(() => {
    if (!open) return;
    const refreshCandidates = () => {
      if (!savingRef.current) void loadData(draftDirtyRef.current);
    };
    const refreshMembership = () => {
      if (savingRef.current) return;
      if (draftDirtyRef.current) {
        setError(t("channel.membershipChangedElsewhere"));
        return;
      }
      void loadData(false);
    };
    const subscription = supabase
      .channel(`edit-channel-members:${channel.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "agents",
          filter: `server_id=eq.${channel.server_id}`,
        },
        refreshCandidates,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "server_members",
          filter: `server_id=eq.${channel.server_id}`,
        },
        refreshCandidates,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "channel_members",
          filter: `channel_id=eq.${channel.id}`,
        },
        refreshMembership,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(subscription);
    };
  }, [channel.id, channel.server_id, loadData, open, supabase, t]);

  const duplicateDisplayNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const agent of allAgents) {
      counts.set(agent.display_name, (counts.get(agent.display_name) || 0) + 1);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count > 1)
        .map(([displayName]) => displayName),
    );
  }, [allAgents]);
  const filteredAgents = useMemo(() => {
    const query = agentSearch.trim().toLocaleLowerCase();
    if (!query) return allAgents;
    return allAgents.filter((agent) =>
      [agent.display_name, agent.name, agent.description || ""]
        .some((value) => value.toLocaleLowerCase().includes(query)),
    );
  }, [agentSearch, allAgents]);

  function toggleAgent(agentId: string) {
    if (savingRef.current) return;
    draftDirtyRef.current = true;
    setMemberAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      memberAgentIdsRef.current = next;
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (savingRef.current || dataLoading || dataLoadError || !name.trim()) return;

    savingRef.current = true;
    setSaving(true);
    setError("");
    const dialogGeneration = loadGenerationRef.current;
    const desiredMemberIds = new Set(memberAgentIdsRef.current);
    let updated = false;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);

    try {
      const latestData = await fetchData(controller.signal);
      if (loadGenerationRef.current === dialogGeneration) {
        setAllAgents(latestData.agents);
      }
      const unavailableSelections = Array.from(desiredMemberIds).filter(
        (agentId) => !latestData.eligibleIds.has(agentId),
      );
      if (unavailableSelections.length > 0) {
        if (loadGenerationRef.current === dialogGeneration) {
          const nextSelection = new Set(
            Array.from(desiredMemberIds).filter((id) =>
              latestData.eligibleIds.has(id),
            ),
          );
          memberAgentIdsRef.current = nextSelection;
          setMemberAgentIds(nextSelection);
        }
        throw new Error(t("channel.agentEligibilityChanged"));
      }

      const normalizedName = name.trim();
      const normalizedDescription = description.trim() || null;
      const { data: result, error: updateError } = await supabase
        .rpc("set_channel_agent_members", {
          channel_uuid: channel.id,
          agent_ids: Array.from(desiredMemberIds),
          expected_agent_ids: Array.from(loadedMemberAgentIdsRef.current),
          expected_channel_name: loadedChannelNameRef.current,
          expected_channel_description: loadedChannelDescriptionRef.current,
          channel_name: normalizedName,
          channel_description: normalizedDescription,
        })
        .abortSignal(controller.signal);
      if (
        updateError ||
        !result ||
        typeof result !== "object" ||
        !("channel" in result)
      ) {
        const message = updateError?.message || t("channel.updateFailed");
        throw new Error(
          /unique|duplicate|channels_server_id_name/i.test(message)
            ? t("channel.nameInUse")
            : message,
        );
      }

      updated = true;
    } catch (err) {
      if (loadGenerationRef.current === dialogGeneration) {
        setError(
          controller.signal.aborted
            ? t("channel.updateTimedOut")
            : err instanceof Error ? err.message : t("channel.updateFailed"),
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      savingRef.current = false;
      if (loadGenerationRef.current === dialogGeneration) setSaving(false);
    }

    if (loadGenerationRef.current !== dialogGeneration) return;
    if (updated) {
      draftDirtyRef.current = false;
      onUpdated();
      onClose();
    }
  }

  async function handleDelete() {
    if (savingRef.current || channel.type === "dm") return;
    savingRef.current = true;
    setDeleting(true);
    setError("");
    const dialogGeneration = loadGenerationRef.current;
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    let deleted = false;

    try {
      const { data: deletedChannel, error: deleteError } = await supabase
        .from("channels")
        .delete()
        .eq("id", channel.id)
        .eq("server_id", channel.server_id)
        .select("id")
        .maybeSingle()
        .abortSignal(controller.signal);
      if (deleteError) throw new Error(deleteError.message);
      if (!deletedChannel) throw new Error(t("channel.deleteFailed"));
      deleted = true;
    } catch (deleteError) {
      if (loadGenerationRef.current === dialogGeneration) {
        setError(
          controller.signal.aborted
            ? t("channel.deleteTimedOut")
            : deleteError instanceof Error
              ? deleteError.message
              : t("channel.deleteFailed"),
        );
      }
    } finally {
      window.clearTimeout(timeout);
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
      savingRef.current = false;
      if (loadGenerationRef.current === dialogGeneration) setDeleting(false);
    }

    if (loadGenerationRef.current !== dialogGeneration || !deleted) return;
    setConfirmDelete(false);
    onDeleted(channel.id);
    onClose();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o && !savingRef.current) onClose(); }}>
        <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("channel.editTitle")}</DialogTitle>
          <DialogDescription>{t("channel.editDescription")}</DialogDescription>
        </DialogHeader>
        <form className="contents" onSubmit={handleSubmit}>
          <fieldset disabled={saving || deleting} className="contents">
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
                      required
                      maxLength={80}
                      autoFocus
                      className="flex-1"
                    />
                  </div>
                </Field>

                <Field>
                  <FieldLabel>{t("createChannel.descriptionField")}</FieldLabel>
                  <Input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription((e.target as HTMLInputElement).value)}
                    placeholder={t("createChannel.descriptionPlaceholder")}
                    maxLength={500}
                  />
                </Field>

                <fieldset className="flex w-full flex-col items-start gap-2">
                  <legend className="text-sm font-medium text-foreground">
                    {t("channel.agents")}
                  </legend>
                  {dataLoading ? (
                    <p className="text-sm text-muted-foreground" aria-live="polite">
                      {t("channel.loadingAgents")}
                    </p>
                  ) : dataLoadError ? (
                    <div className="flex w-full items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <p className="min-w-0 text-sm text-destructive" role="alert">
                        {t("channel.loadAgentsFailed")} {dataLoadError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void loadData(draftDirtyRef.current)}
                      >
                        {t("channel.retry")}
                      </Button>
                    </div>
                  ) : allAgents.length === 0 ? (
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
                          htmlFor={`edit-channel-agent-${agent.id}`}
                          className="flex items-center gap-2.5 rounded-md px-2.5 py-2 cursor-pointer transition-colors hover:bg-accent"
                        >
                          <Checkbox
                            id={`edit-channel-agent-${agent.id}`}
                            aria-label={`${t("channel.agents")}: ${agent.display_name}${
                              duplicateDisplayNames.has(agent.display_name)
                                ? ` (@${agent.name})`
                                : ""
                            }`}
                            checked={memberAgentIds.has(agent.id)}
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
                              <span className="truncate">{agent.display_name}</span>
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
              {channel.type !== "dm" && (
                <Button
                  type="button"
                  variant="destructive-outline"
                  className="sm:mr-auto"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2Icon />
                  {t("channel.delete")}
                </Button>
              )}
              <DialogClose render={<Button variant="ghost" type="button" />}>
                {t("createChannel.cancel")}
              </DialogClose>
              <Button
                type="submit"
                loading={saving}
                disabled={!name.trim() || dataLoading || !!dataLoadError}
              >
                {t("channel.save")}
              </Button>
            </DialogFooter>
          </fieldset>
        </form>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={confirmDelete}
        onOpenChange={(nextOpen) => {
          if (!deleting) setConfirmDelete(nextOpen);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("channel.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("channel.deleteDescription", { name: channel.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              {t("createChannel.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} loading={deleting}>
              {t("channel.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
