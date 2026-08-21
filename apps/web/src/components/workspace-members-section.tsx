"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useWorkspaceServer } from "@/components/workspace-server-context";
import { GeneratedAvatar } from "@/components/generated-avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { AlertCircle, Check, RefreshCw, UserMinus } from "@/components/ui/settings-icons";

interface WorkspaceHumanMember {
  id: string;
  display_name: string;
  avatar_url: string | null;
  role: "owner" | "admin" | "member";
  joined_at: string;
  agent_count: number | string;
  is_current_user: boolean;
}

interface RemovalResult {
  removed: boolean;
  agents_removed: number;
  machine_keys_revoked: number;
  dm_channels_removed: number;
  task_assignments_cleared: number;
  deliveries_removed: number;
}

export function WorkspaceMembersSection() {
  const { t } = useAppSettings();
  const server = useWorkspaceServer();
  const [members, setMembers] = useState<WorkspaceHumanMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [removeError, setRemoveError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [target, setTarget] = useState<WorkspaceHumanMember | null>(null);
  const [removing, setRemoving] = useState(false);
  const loadGenerationRef = useRef(0);
  const removingRef = useRef(false);

  const loadMembers = useCallback(async (quiet = false) => {
    const generation = ++loadGenerationRef.current;
    if (!quiet) setLoading(true);
    setLoadError("");
    const { data, error } = await createClient().rpc("list_workspace_human_members", {
      server_uuid: server.id,
    });
    if (generation !== loadGenerationRef.current) return;
    if (error) {
      setLoadError(error.message);
      setLoading(false);
      return;
    }
    setMembers((data || []) as WorkspaceHumanMember[]);
    setLoading(false);
  }, [server.id]);

  useEffect(() => {
    const client = createClient();
    let refreshTimer: number | null = null;
    const refresh = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadMembers(true);
      }, 80);
    };
    const initialLoadFrame = window.requestAnimationFrame(() => {
      void loadMembers();
    });
    const subscription = client
      .channel(`workspace-members-settings:${server.id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "server_members", filter: `server_id=eq.${server.id}` },
        refresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "agents", filter: `server_id=eq.${server.id}` },
        refresh,
      )
      .subscribe();
    return () => {
      loadGenerationRef.current += 1;
      window.cancelAnimationFrame(initialLoadFrame);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      void client.removeChannel(subscription);
    };
  }, [loadMembers, server.id]);

  const currentMember = members.find((member) => member.is_current_user);
  const canRemoveMembers = currentMember?.id === server.owner_id;

  async function removeMember() {
    if (!target || removingRef.current) return;
    removingRef.current = true;
    setRemoving(true);
    setRemoveError("");
    setFeedback("");
    const targetId = target.id;
    const targetName = target.display_name;
    try {
      const { data, error } = await createClient().rpc("remove_server_human_member", {
        server_uuid: server.id,
        human_uuid: targetId,
      });
      if (error) {
        setRemoveError(error.message);
        return;
      }

      const result = data as RemovalResult | null;
      setMembers((current) => current.filter((member) => member.id !== targetId));
      setTarget(null);
      setFeedback(
        result?.removed
          ? t("workspaceMembers.removed", {
              name: targetName,
              count: String(result.agents_removed || 0),
            })
          : t("workspaceMembers.alreadyRemoved", { name: targetName }),
      );
      await loadMembers(true);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : t("workspaceMembers.removeFailed"));
    } finally {
      removingRef.current = false;
      setRemoving(false);
    }
  }

  return (
    <section className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold">{t("settings.navWorkspace")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("workspaceMembers.description")}
        </p>
      </div>

      {loadError && (
        <Alert variant="error">
          <AlertCircle />
          <AlertTitle>{t("workspaceMembers.loadFailed")}</AlertTitle>
          <AlertDescription>
            <span>{loadError}</span>
            <Button className="w-fit" onClick={() => void loadMembers()} size="sm" variant="outline">
              <RefreshCw />
              {t("runtime.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {feedback && (
        <Alert aria-live="polite" variant="success">
          <Check />
          <AlertDescription>{feedback}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardPanel className="divide-y p-0">
          {loading ? (
            <p aria-live="polite" className="p-5 text-sm text-muted-foreground" role="status">
              {t("workspaceMembers.loading")}
            </p>
          ) : members.length === 0 ? (
            <p className="p-5 text-sm text-muted-foreground">{t("workspaceMembers.empty")}</p>
          ) : members.map((member) => {
            const agentCount = Number(member.agent_count) || 0;
            return (
              <div className="flex min-w-0 items-center gap-3 p-4" key={member.id}>
                <GeneratedAvatar
                  avatarUrl={member.avatar_url}
                  id={member.id}
                  name={member.display_name}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate text-sm font-medium">{member.display_name}</p>
                    {member.is_current_user && (
                      <Badge size="sm" variant="secondary">{t("workspaceMembers.you")}</Badge>
                    )}
                    <Badge size="sm" variant={member.role === "owner" ? "info" : "outline"}>
                      {t(member.role === "owner"
                        ? "workspaceMembers.role.owner"
                        : member.role === "admin"
                          ? "workspaceMembers.role.admin"
                          : "workspaceMembers.role.member")}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("workspaceMembers.agentCount", { count: String(agentCount) })}
                  </p>
                </div>
                {canRemoveMembers && member.id !== server.owner_id && !member.is_current_user && (
                  <Button
                    aria-label={t("workspaceMembers.removeNamed", { name: member.display_name })}
                    onClick={() => {
                      setFeedback("");
                      setRemoveError("");
                      setTarget(member);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    <UserMinus />
                    {t("workspaceMembers.remove")}
                  </Button>
                )}
              </div>
            );
          })}
        </CardPanel>
      </Card>

      <AlertDialog
        open={Boolean(target)}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setTarget(null);
            setRemoveError("");
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("workspaceMembers.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {target && t("workspaceMembers.confirmDescription", {
                name: target.display_name,
                count: String(Number(target.agent_count) || 0),
              })}
            </AlertDialogDescription>
            {removeError && (
              <Alert className="mt-2 text-left" variant="error">
                <AlertCircle />
                <AlertDescription>{removeError}</AlertDescription>
              </Alert>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button disabled={removing} onClick={() => setTarget(null)} variant="ghost">
              {t("workspaceMembers.cancel")}
            </Button>
            <Button loading={removing} onClick={() => void removeMember()} variant="destructive">
              <UserMinus />
              {removing ? t("workspaceMembers.removing") : t("workspaceMembers.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
