"use client";

import { createContext, useContext, type ReactNode } from "react";

export interface WorkspaceServer {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
}

const WorkspaceServerContext = createContext<WorkspaceServer | null>(null);

export function WorkspaceServerProvider({
  children,
  server,
}: {
  children: ReactNode;
  server: WorkspaceServer;
}) {
  return (
    <WorkspaceServerContext.Provider value={server}>
      {children}
    </WorkspaceServerContext.Provider>
  );
}

export function useWorkspaceServer() {
  const server = useContext(WorkspaceServerContext);
  if (!server) throw new Error("Workspace server context is unavailable");
  return server;
}
