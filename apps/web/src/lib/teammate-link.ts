export {
  documentIdFromHref,
  documentLinkHref,
  documentLinkMarkdown,
} from "@teammate/shared";

/** Where a document reference goes once it is clicked. Routing, not format. */
export function documentPath(serverSlug: string, id: string) {
  return `/s/${serverSlug}/documents?document=${encodeURIComponent(id)}`;
}
