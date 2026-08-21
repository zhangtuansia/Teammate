"use client";

import { WorkspaceSection } from "../../../../../../desktop/src/workspace-section";
import { useWorkspaceServer } from "@/components/workspace-server-context";

export default function TasksPage() {
  const server = useWorkspaceServer();
  return (
    <WorkspaceSection
      section="tasks"
      serverId={server.id}
      serverSlug={server.slug}
    />
  );
}
