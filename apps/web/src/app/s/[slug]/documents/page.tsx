"use client";

import { WorkspaceSection } from "../../../../../../desktop/src/workspace-section";
import { useWorkspaceServer } from "@/components/workspace-server-context";

export default function DocumentsPage() {
  const server = useWorkspaceServer();
  return (
    <WorkspaceSection
      section="documents"
      serverId={server.id}
      serverSlug={server.slug}
    />
  );
}
