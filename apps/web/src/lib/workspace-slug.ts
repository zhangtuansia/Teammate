export const WORKSPACE_SLUG_MAX_LENGTH = 64;

export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeWorkspaceSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, WORKSPACE_SLUG_MAX_LENGTH)
    .replace(/-+$/, "");
}

function stableWorkspaceSuffix(value: string) {
  let hash = 2166136261;
  for (const character of value.normalize("NFKC")) {
    const codePoint = character.codePointAt(0) ?? 0;
    hash ^= codePoint;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function workspaceSlugFromName(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) return "";
  const normalized = normalizeWorkspaceSlug(trimmedName);
  return normalized || `workspace-${stableWorkspaceSuffix(trimmedName)}`;
}

export function isValidWorkspaceSlug(value: string) {
  return (
    value.length > 0 &&
    value.length <= WORKSPACE_SLUG_MAX_LENGTH &&
    WORKSPACE_SLUG_PATTERN.test(value)
  );
}
