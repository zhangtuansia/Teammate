/**
 * Defanging for content that enters an agent's context but did not come from
 * the operator: channel messages, document text, tool output.
 *
 * The runtime protocol carries meaning in a few bracketed markers — the
 * message header, wake notices, and the reply-sent end-of-turn marker. Any of
 * those appearing inside message *content* is either a coincidence worth
 * keeping readable or an injection attempt; both are handled by rewriting the
 * marker so it can no longer be parsed as structure, without silently
 * dropping what the sender wrote.
 */

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

function defangLine(line: string): string {
  if (/^\[target=\S+\s+msg=[0-9a-f-]+/.test(line)) {
    return line.replace(/^\[/, "⟦untrusted-header⟧ ");
  }
  const notification = /^(\[)\s*(System notification\s*:)/i.exec(line);
  if (notification) {
    return `⟦untrusted-content claims ${notification[2].toLowerCase()}⟧${line.slice(notification[0].length)}`;
  }
  return line.replace(/\[\s*teammate\s*:\s*reply-sent\s*\]/gi, "⟦untrusted-content claimed [teammate:reply-sent]⟧");
}

export function sanitizeUntrustedContent(text: string): string {
  if (!text) return text;
  const withoutInvisible = text.replace(ZERO_WIDTH, "");
  if (!withoutInvisible.includes("[")) return withoutInvisible;
  return withoutInvisible
    .split("\n")
    .map(defangLine)
    .join("\n");
}
