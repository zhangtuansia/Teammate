/**
 * A readable first impression of a document. The stored text is Markdown, so
 * the heading marks, bullets and emphasis that give it structure on screen are
 * just noise in two lines of preview — and a fenced code block's contents say
 * even less about what the document is for than its prose does.
 */
export function documentPreview(excerpt: string) {
  const lines: string[] = [];
  let insideFence = false;
  for (const raw of excerpt.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence || !line) continue;
    const stripped = line
      // Leading block marks: heading, bullet, ordered item, quote.
      .replace(/^(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/, "")
      // A table rule or a horizontal rule carries nothing to read.
      .replace(/^[|\s:-]+$/, "")
      .trim();
    if (stripped) lines.push(stripped);
  }
  return lines
    .join(" · ")
    // Inline emphasis and code marks, once the text is out of context.
    .replace(/[*_`~]/g, "")
    // Links keep their text; the target is not readable at this size.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}
