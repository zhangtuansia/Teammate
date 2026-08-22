import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching a link's metadata means this machine issues a request to a URL that
 * arrived in a message — including one an agent wrote. Everything here exists
 * to keep that from becoming a way to reach things only this machine can see:
 * the address is resolved and checked before the request goes out, every
 * redirect hop is checked again, and the response is capped and timed out.
 */

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;
/** Enough for any sane <head>; the body is abandoned past this. */
const MAX_BYTES = 512 * 1024;

export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
}

function isBlockedIPv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isBlockedIPv6(address: string) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
  // ::ffff:a.b.c.d carries a v4 address that must face the v4 rules.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isBlockedIPv4(mapped[1]);
  return false;
}

export function isBlockedAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return isBlockedIPv4(address);
  if (family === 6) return isBlockedIPv6(address);
  return true;
}

/** Resolve the host and refuse anything that points back inside the network. */
async function assertPublicHost(hostname: string) {
  const literal = isIP(hostname);
  if (literal) {
    if (isBlockedAddress(hostname)) throw new Error("That address is not reachable from here");
    return;
  }
  const records = await lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) throw new Error("That host could not be resolved");
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error("That address is not reachable from here");
    }
  }
}

function decodeEntities(value: string) {
  return value
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|#39|apos);/gi, (match, entity: string) => {
      const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        quot: '"',
        "#39": "'",
      };
      const key = entity.toLowerCase();
      if (named[key]) return named[key];
      if (key.startsWith("#x")) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(Number.parseInt(key.slice(1), 10));
      return match;
    })
    .trim();
}

function metaContent(html: string, property: string) {
  const pattern = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]*>`,
    "i",
  );
  const tag = pattern.exec(html)?.[0];
  if (!tag) return null;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decodeEntities(content).slice(0, 500) : null;
}

export function parseLinkMetadata(url: string, html: string): LinkPreview {
  const head = html.slice(0, MAX_BYTES);
  const title =
    metaContent(head, "og:title") ||
    metaContent(head, "twitter:title") ||
    (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
      ? decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)![1]).slice(0, 300)
      : null);
  return {
    description:
      metaContent(head, "og:description") ||
      metaContent(head, "twitter:description") ||
      metaContent(head, "description"),
    imageUrl: metaContent(head, "og:image") || metaContent(head, "twitter:image"),
    siteName: metaContent(head, "og:site_name"),
    title,
    url,
  };
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error("That is not a URL");
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("Only http and https links can be previewed");
    }
    await assertPublicHost(current.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        // Redirects are followed by hand so every hop faces assertPublicHost;
        // letting fetch follow them would skip the check on the real target.
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Teammate link preview",
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("That link redirected nowhere");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`That link returned HTTP ${response.status}`);

    const type = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      throw new Error("That link is not a web page");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("That link returned no content");
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let html = "";
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        html += decoder.decode(value, { stream: true });
        // The metadata lives in <head>; stop as soon as it is behind us.
        if (received >= MAX_BYTES || /<\/head>/i.test(html)) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return parseLinkMetadata(current.toString(), html);
  }

  throw new Error("That link redirected too many times");
}
