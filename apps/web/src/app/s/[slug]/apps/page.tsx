"use client";

import { useWorkspaceServer } from "@/components/workspace-server-context";
import { AppsSection } from "@/components/apps-section";

export default function AppsPage() {
  const server = useWorkspaceServer();
  return <AppsSection serverId={server.id} />;
}
