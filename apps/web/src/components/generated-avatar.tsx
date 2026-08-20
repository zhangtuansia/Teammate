"use client";

import { useMemo, useState } from "react";
import NotionAvatar from "react-notion-avatar";
import { getAvatarColor, getNotionAvatarConfig } from "@/lib/avatar";
import {
  getAgentAvatarSeed,
  resolveAgentAvatarImageUrl,
} from "@/lib/agent-avatar";

import { cn } from "@/lib/utils";

interface GeneratedAvatarProps {
  id: string;
  name?: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
  avatarUrl?: string | null;
  /** If true, show initials instead of notion avatar (for workspace icons) */
  initials?: boolean;
}

const SIZE_CLASSES = {
  xs: "size-6",
  sm: "size-7",
  md: "size-8",
  lg: "size-10",
};

const INITIALS_TEXT_SIZES = {
  xs: "text-[10px]",
  sm: "text-[11px]",
  md: "text-xs",
  lg: "text-sm",
};

export function GeneratedAvatar({
  id,
  name,
  size = "md",
  className,
  avatarUrl,
  initials,
}: GeneratedAvatarProps) {
  const seed = getAgentAvatarSeed(id, avatarUrl);
  const color = useMemo(() => getAvatarColor(seed), [seed]);
  const config = useMemo(() => getNotionAvatarConfig(seed), [seed]);
  const imageUrl = resolveAgentAvatarImageUrl(avatarUrl);
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageFailed = Boolean(imageUrl && failedImageUrl === imageUrl);

  const showInitials = initials && name;

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full",
        showInitials ? "" : "border-[0.5px] border-border bg-background",
        SIZE_CLASSES[size],
        className,
      )}
      style={showInitials ? { backgroundColor: color.bg, color: color.fg } : undefined}
      title={name}
    >
      {showInitials ? (
        <span className={cn("font-semibold", INITIALS_TEXT_SIZES[size])}>
          {name.charAt(0).toUpperCase()}
        </span>
      ) : (
        <NotionAvatar
          className="h-full w-full"
          style={{ width: "100%", height: "100%" }}
          config={config}
        />
      )}
      {imageUrl && !imageFailed && (
        // eslint-disable-next-line @next/next/no-img-element -- local desktop avatars use runtime URLs.
        <img
          src={imageUrl}
          alt=""
          className="absolute inset-0 size-full object-cover"
          onError={() => setFailedImageUrl(imageUrl)}
        />
      )}
    </div>
  );
}
