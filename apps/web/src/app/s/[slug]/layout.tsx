"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/sidebar";
import { AgentActivityProvider } from "@/hooks/use-agent-activity";
import { DesktopSettingsProvider } from "../../../../../desktop/src/settings";
import { WorkspaceServerProvider } from "@/components/workspace-server-context";
import { WorkspaceNavigationGuardProvider } from "@/hooks/use-navigation-guard";
import { Button } from "@/components/ui/button";

interface Server {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
}

interface ServerResolution {
  slug: string;
  request: number;
  server: Server | null;
  error: string;
}

export default function ServerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const [request, setRequest] = useState(0);
  const [resolution, setResolution] = useState<ServerResolution | null>(null);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    let cancelled = false;
    const isCurrent = () => !cancelled && loadGenerationRef.current === generation;

    async function loadServer() {
      try {
        const supabase = createClient();
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();
        if (!isCurrent()) return;

        if (authError) throw new Error(authError.message);
        if (!user) {
          router.replace("/login");
          return;
        }

        const { data, error: serverError } = await supabase
          .from("servers")
          .select("*")
          .eq("slug", slug)
          .single();
        if (!isCurrent()) return;

        if (serverError) throw new Error(serverError.message);
        if (!data) {
          router.replace("/");
          return;
        }

        setResolution({
          slug,
          request,
          server: data as Server,
          error: "",
        });
      } catch (loadError) {
        if (!isCurrent()) return;
        setResolution({
          slug,
          request,
          server: null,
          error: loadError instanceof Error ? loadError.message : "Could not load workspace",
        });
      }
    }

    void loadServer();
    return () => {
      cancelled = true;
    };
  }, [request, router, slug]);

  const currentResolution =
    resolution?.slug === slug && resolution.request === request ? resolution : null;

  if (!currentResolution) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (currentResolution.error || !currentResolution.server) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <p role="alert" className="text-sm text-destructive">
            {currentResolution.error || "Workspace not found"}
          </p>
          <Button variant="outline" size="sm" onClick={() => setRequest((value) => value + 1)}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const server = currentResolution.server;

  const workspace = (
    <WorkspaceNavigationGuardProvider>
      <WorkspaceServerProvider server={server}>
        <AgentActivityProvider key={server.id} serverId={server.id}>
          <div className="flex h-full bg-background p-2">
            <Sidebar serverSlug={server.slug} serverId={server.id} serverName={server.name} />
            <div className="flex flex-1 overflow-hidden rounded-xl bg-card shadow-border">
              {children}
            </div>
          </div>
        </AgentActivityProvider>
      </WorkspaceServerProvider>
    </WorkspaceNavigationGuardProvider>
  );

  return process.env.NEXT_PUBLIC_TEAMMATE_LOCAL_MODE === "true" ? (
    <DesktopSettingsProvider>{workspace}</DesktopSettingsProvider>
  ) : workspace;
}
