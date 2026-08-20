"use client";

import { useMemo } from "react";
import { useParams } from "next/navigation";
import { MessageArea } from "@/components/message-area";

export default function ChannelPage() {
  const params = useParams();
  const channelId = params.channelId as string;

  const channel = useMemo(
    () => ({ id: channelId, name: "", type: "public" as const, description: null }),
    [channelId]
  );

  return <MessageArea channel={channel} />;
}
