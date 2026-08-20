"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ChatRedirect() {
  const router = useRouter();

  useEffect(() => {
    async function redirect() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push("/login");
        return;
      }

      // Find user's servers
      const { data: memberships } = await supabase
        .from("server_members")
        .select("server_id")
        .eq("member_id", user.id)
        .eq("member_type", "human");

      if (memberships && memberships.length > 0) {
        const { data: server } = await supabase
          .from("servers")
          .select("slug")
          .eq("id", memberships[0].server_id)
          .single();

        if (server) {
          router.replace(`/s/${server.slug}`);
          return;
        }
      }

      // No server found — redirect to onboarding
      router.replace("/onboarding");
    }

    redirect();
  }, [router]);

  return (
    <div className="flex flex-1 items-center justify-center bg-background">
      <div className="text-sm text-muted-foreground">Loading...</div>
    </div>
  );
}
