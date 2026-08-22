/**
 * Documents here have more than one author: a person edits what a teammate
 * wrote, through the CLI, in Markdown. A rich editor only holds the constructs
 * its extensions know about, so anything else it is handed comes back changed —
 * and a table an agent spent a turn producing would quietly disappear the first
 * time someone opened the document and pressed save.
 *
 * So the editor is offered only for documents it can return unharmed. The rest
 * are edited as source, which is lossless by construction.
 */
const UNSUPPORTED = [
  // GFM tables: no table extension is installed.
  /^[ \t]*\|.*\|[ \t]*$/m,
  // Raw HTML blocks and inline tags.
  /<\/?[a-z][a-z0-9-]*(\s[^>]*)?>/i,
  // Footnote definitions and references.
  /\[\^[^\]]+\]/,
  // Definition lists and other directive-ish syntax remark-gfm may carry.
  /^:{3,}/m,
];

export function canEditAsRichText(markdown: string) {
  return !UNSUPPORTED.some((pattern) => pattern.test(markdown));
}
