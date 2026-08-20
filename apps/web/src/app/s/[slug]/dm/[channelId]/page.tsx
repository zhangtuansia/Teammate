"use client";

import { useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { MessageArea } from "@/components/message-area";
import { AgentSettingsPanel } from "@/components/agent-settings-panel";

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
}

export default function DmPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const [settingsAgent, setSettingsAgent] = useState<AgentInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const channel = useMemo(
    () => ({ id: channelId, name: "", type: "dm" as const, description: null }),
    [channelId]
  );

  const handleToggleSettings = useCallback((agent: AgentInfo | null) => {
    setSettingsAgent(agent);
  }, []);

  const handleAgentDeleted = useCallback(() => {
    setSettingsAgent(null);
    // Navigate back would go here, but for now just clear
  }, []);

  const handleAgentUpdated = useCallback((updated: AgentInfo) => {
    setSettingsAgent(updated);
    setRefreshKey((k) => k + 1);
  }, []);

  return (
    <>
      <MessageArea
        key={refreshKey}
        channel={channel}
        onToggleSettings={handleToggleSettings}
        showSettings={!!settingsAgent}
      />
      {settingsAgent && (
        <AgentSettingsPanel
          agent={settingsAgent}
          onClose={() => setSettingsAgent(null)}
          onDeleted={handleAgentDeleted}
          onUpdated={handleAgentUpdated}
        />
      )}
    </>
  );
}
