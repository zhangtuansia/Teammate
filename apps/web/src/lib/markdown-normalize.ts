const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

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
