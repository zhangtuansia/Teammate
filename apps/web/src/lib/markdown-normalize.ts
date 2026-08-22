const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/**
 * Collapse runs of blank lines. The serializer leaves two where the author
 * wrote one, and in Markdown the extra line means nothing — but it means a
 * diff, on every save, for whoever reads the document next. Blank lines inside
 * a fenced code block are content and are left exactly as they are.
 */
export function collapseBlankLines(markdown: string) {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let insideFence = false;
  let blanks = 0;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) insideFence = !insideFence;
    if (!insideFence && line.trim() === "") {
      blanks += 1;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * The editor writes a blank line between list items, which turns a tight list
 * into a loose one: Markdown then wraps each item in a paragraph and the list
 * renders with extra spacing. A document saved unchanged should come back
 * unchanged, and these documents are read and rewritten by teammates through
 * the CLI, where a spurious blank line on every save is noise in the diff.
 *
 * Only blank lines *between two items of the same list* are dropped. A blank
 * line before or after the list, or one separating a list from a paragraph,
 * is the author's spacing and stays.
 */
export function tightenMarkdownLists(markdown: string) {
  const lines = markdown.split("\n");
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() !== "") {
      out.push(line);
      continue;
    }

    // Look past a run of blank lines to whatever comes next.
    let lookahead = index;
    while (lookahead < lines.length && lines[lookahead].trim() === "") lookahead += 1;
    const previous = out[out.length - 1];
    const next = lines[lookahead];

    const previousItem = previous ? LIST_ITEM.exec(previous) : null;
    const nextItem = next ? LIST_ITEM.exec(next) : null;
    // Same list means same indent; a nested item is a different list.
    if (previousItem && nextItem && previousItem[1].length === nextItem[1].length) {
      index = lookahead - 1;
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

/**
 * Undo the column padding the serializer adds to tables. It aligns cells with
 * runs of spaces, which reads well but rewrites every row of a table a teammate
 * wrote the first time a person saves the document — the whole table shows as
 * changed when one cell was touched. Only the padding at cell boundaries is
 * removed; whatever is inside a cell is left alone, and rows inside a fenced
 * code block are not tables at all.
 */
export function unpadMarkdownTables(markdown: string) {
  let insideFence = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) return line;
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return line;
      const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
      const normalized = cells.map((cell) =>
        // The delimiter row carries alignment in its colons; the dashes
        // themselves only need to be there.
        /^:?-{2,}:?$/.test(cell) ? cell.replace(/-+/, "---") : cell,
      );
      return `| ${normalized.join(" | ")} |`;
    })
    .join("\n");
}
