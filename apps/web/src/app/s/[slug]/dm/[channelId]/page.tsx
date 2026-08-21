"use client";

import { useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { MessageArea } from "@/components/message-area";
import { AgentSettingsPanel } from "@/components/agent-settings-panel";
import { useChannel } from "@/hooks/use-channel";
import { useAppSettings } from "@/hooks/use-app-settings";
import { useWorkspaceServer } from "@/components/workspace-server-context";
import { Button } from "@/components/ui/button";

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
  avatar_url: string | null;
  owner_id: string;
}

interface AgentPanelSelection {
  channelId: string;
  agent: AgentInfo;
}

export default function DmPage() {
  const params = useParams();
  const router = useRouter();
  const channelId = params.channelId as string;
  const server = useWorkspaceServer();
  const { channel, error, loading, notFound, retry } = useChannel(channelId, server.id);
  const [settingsSelection, setSettingsSelection] = useState<AgentPanelSelection | null>(null);
  const { t } = useAppSettings();

  const handleToggleSettings = useCallback((agent: AgentInfo | null) => {
    setSettingsSelection(agent ? { channelId, agent } : null);
  }, [channelId]);

  const handleAgentDeleted = useCallback(() => {
    setSettingsSelection(null);
    window.requestAnimationFrame(() => {
      router.replace(`/s/${server.slug}`);
    });
  }, [router, server.slug]);

  const handleAgentUpdated = useCallback((updated: AgentInfo) => {
    setSettingsSelection({ channelId, agent: updated });
  }, [channelId]);

  const settingsAgent = settingsSelection?.channelId === channelId
    ? settingsSelection.agent
    : null;

  if (error || notFound) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-destructive" role="alert" title={error || undefined}>
          {notFound ? t("conversation.notFound") : t("conversation.loadFailed")}
        </p>
        {!notFound && (
          <Button onClick={retry} size="sm" variant="outline">
            {t("runtime.retry")}
          </Button>
        )}
      </div>
    );
  }
  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">{t("conversation.loading")}</div>;
  }

  return (
    <>
      <MessageArea
        channel={channel}
        onToggleSettings={handleToggleSettings}
        showSettings={Boolean(settingsAgent)}
      />
      {settingsAgent && (
        <AgentSettingsPanel
          agent={settingsAgent}
          onClose={() => setSettingsSelection(null)}
          onDeleted={handleAgentDeleted}
          onUpdated={handleAgentUpdated}
        />
      )}
    </>
  );
}
