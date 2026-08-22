export interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
}

/**
 * Chat newlines are line breaks. CommonMark folds a single newline inside a
 * paragraph into a space, so a message typed across two lines with Shift+Enter
 * arrived as one run-on line — which is not what either a person or a teammate
 * meant by pressing return. Only `text` nodes are rewritten, so code blocks and
 * inline code keep their newlines as content.
 */
export function remarkChatBreaks() {
  const split = (node: MdastNode) => {
    if (!node.children) return;
    const next: MdastNode[] = [];
    for (const child of node.children) {
      if (child.type !== "text" || !child.value?.includes("\n")) {
        split(child);
        next.push(child);
        continue;
      }
      const pieces = child.value.split("\n");
      pieces.forEach((piece, index) => {
        if (index > 0) next.push({ type: "break" });
        if (piece) next.push({ ...child, value: piece });
      });
    }
    node.children = next;
  };
  return (tree: MdastNode) => split(tree);
}
