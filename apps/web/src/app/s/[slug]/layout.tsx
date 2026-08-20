"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/sidebar";
import { AgentActivityProvider } from "@/hooks/use-agent-activity";

interface Server {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  owner_id: string;
}

export default function ServerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;
  const [server, setServer] = useState<Server | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadServer() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      const { data } = await supabase
        .from("servers")
        .select("*")
        .eq("slug", slug)
        .single();

      if (!data) {
        // Server not found, redirect to home
        router.push("/");
        return;
      }

      setServer(data as Server);
      setLoading(false);
    }

    loadServer();
  }, [slug, router]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (!server) return null;

  return (
    <AgentActivityProvider>
      <div className="flex h-full bg-background p-2">
        <Sidebar serverSlug={server.slug} serverId={server.id} serverName={server.name} />
        <div className="flex flex-1 overflow-hidden rounded-xl bg-card shadow-border">
          {children}
        </div>
      </div>
    </AgentActivityProvider>
  );
}
