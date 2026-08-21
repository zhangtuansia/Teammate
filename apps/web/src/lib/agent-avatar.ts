import { apiUrl } from "@/lib/api-url";
import { isAuthenticatedLocalAssetPath } from "@/lib/local-auth";

export const AGENT_AVATAR_PRESETS = [
  "teammate-sun",
  "teammate-moon",
  "teammate-forest",
  "teammate-ocean",
  "teammate-coral",
  "teammate-violet",
  "teammate-cloud",
  "teammate-spark",
] as const;

export function isGeneratedAgentAvatar(value: unknown) {
  return (
    typeof value === "string" &&
    /^generated:[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)
  );
}

export function isValidAgentAvatarUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (isGeneratedAgentAvatar(value)) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  return (
    /^https:\/\/[^\s]+$/i.test(value) ||
    /^\/api\/avatars\/[a-f0-9-]{36}\.(?:png|jpg|webp)(?:\?v=\d+)?$/i.test(
      value,
    )
  );
}

export function getAgentAvatarSeed(agentId: string, avatarUrl?: string | null) {
  return typeof avatarUrl === "string" && isGeneratedAgentAvatar(avatarUrl)
    ? avatarUrl.slice("generated:".length)
    : agentId;
}

export function resolveAgentAvatarImageUrl(avatarUrl?: string | null) {
  if (!avatarUrl || isGeneratedAgentAvatar(avatarUrl)) return null;
  if (avatarUrl.startsWith("/")) {
    return isAuthenticatedLocalAssetPath(avatarUrl) ? null : apiUrl(avatarUrl);
  }
  if (/^(?:https:|data:|blob:)/i.test(avatarUrl)) return avatarUrl;
  return null;
}
