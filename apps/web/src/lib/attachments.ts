import { apiUrl } from "@/lib/api-url";

export interface UploadedAttachment {
  id: string;
  url: string;
  display_name: string;
  mime_type: string;
  byte_size: number;
}

/** Mirrors the local service's accepted types so the picker and the paste
 * handler reject a file before spending a round trip on it. */
export const ATTACHMENT_ACCEPT = [
  "application/json",
  "application/pdf",
  "application/zip",
  "audio/mpeg",
  "audio/wav",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
  "video/mp4",
  "video/quicktime",
];

export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;

/** Browsers leave `type` empty for extensions they do not know; fall back to
 * the suffix so a plain .log or .md still uploads as text. */
function resolveMimeType(file: File) {
  const declared = file.type.split(";")[0].trim().toLowerCase();
  if (declared && ATTACHMENT_ACCEPT.includes(declared)) return declared;
  const suffix = file.name.split(".").pop()?.toLowerCase() || "";
  if (["txt", "log", "ts", "tsx", "js", "jsx", "py", "rs", "go", "sh", "yml", "yaml", "toml", "ini", "env"].includes(suffix)) {
    return "text/plain";
  }
  if (suffix === "md" || suffix === "markdown") return "text/markdown";
  if (suffix === "csv") return "text/csv";
  if (suffix === "json") return "application/json";
  return declared;
}

export function attachmentMarkdown(attachment: UploadedAttachment) {
  const label = attachment.display_name.replace(/[[\]]/g, "");
  return attachment.mime_type.startsWith("image/") && attachment.mime_type !== "image/svg+xml"
    ? `![${label}](${attachment.url})`
    : `[${label}](${attachment.url})`;
}

export async function uploadAttachment(file: File): Promise<UploadedAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("File is larger than the 64 MB limit");
  }
  const mimeType = resolveMimeType(file);
  if (!ATTACHMENT_ACCEPT.includes(mimeType)) {
    throw new Error("That file type cannot be attached");
  }
  const response = await fetch(apiUrl("/api/attachments"), {
    body: await file.arrayBuffer(),
    headers: {
      "Content-Type": mimeType,
      "X-Teammate-Filename": encodeURIComponent(file.name),
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => null)) as
    | { attachment?: UploadedAttachment; error?: string }
    | null;
  if (!response.ok || !payload?.attachment) {
    throw new Error(payload?.error || `Upload failed with HTTP ${response.status}`);
  }
  return payload.attachment;
}
