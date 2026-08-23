/**
 * Folders exist because documents say they are in them. There is no folder
 * table: a folder is a distinct `folder_path` among the documents, which means
 * the tree can never disagree with its contents, and nothing has to be kept in
 * step when a document is moved or deleted.
 *
 * The cost is that an empty folder cannot be represented. That is the right
 * trade here — these folders come from folders on disk, which is where an empty
 * one would have to be created anyway.
 */

export interface DocumentLike {
  id: string;
  title: string;
  folder_path: string;
  pinned_at: string | null;
  updated_at: string;
}

export interface DocumentFolder<T extends DocumentLike> {
  /** Full path, which is also the key: `api/v2`. */
  path: string;
  /** Last segment, which is what the row shows: `v2`. */
  name: string;
  depth: number;
  folders: DocumentFolder<T>[];
  documents: T[];
  /** Everything underneath, however deep — what the row's count means. */
  totalDocuments: number;
}

export interface DocumentTree<T extends DocumentLike> {
  folders: DocumentFolder<T>[];
  /** Documents filed nowhere in particular. */
  loose: T[];
  /**
   * Pinned documents, oldest pin first, shown above everything. A pinned
   * document stays where it is filed as well — pinning is a second way to
   * reach a document, not a place to move it to.
   */
  pinned: T[];
}

function segmentsOf(path: string) {
  return path.split("/").filter((segment) => segment.length > 0);
}

/**
 * Builds the tree. Documents keep the order they arrive in — newest first from
 * the query — so a folder's contents read the same way the flat list did.
 */
export function buildDocumentTree<T extends DocumentLike>(documents: readonly T[]): DocumentTree<T> {
  const roots: DocumentFolder<T>[] = [];
  const byPath = new Map<string, DocumentFolder<T>>();
  const loose: T[] = [];

  /** Finds or opens the folder at a path, and every folder on the way to it. */
  const folderAt = (segments: string[]): DocumentFolder<T> | null => {
    let parent: DocumentFolder<T> | null = null;
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join("/");
      let folder = byPath.get(path);
      if (!folder) {
        folder = {
          depth: depth - 1,
          documents: [],
          folders: [],
          name: segments[depth - 1],
          path,
          totalDocuments: 0,
        };
        byPath.set(path, folder);
        if (parent) parent.folders.push(folder);
        else roots.push(folder);
      }
      parent = folder;
    }
    return parent;
  };

  for (const document of documents) {
    const segments = segmentsOf(document.folder_path || "");
    if (segments.length === 0) {
      loose.push(document);
      continue;
    }
    folderAt(segments)?.documents.push(document);
    // A document counts for every folder above it, so a collapsed folder can
    // still say how much is inside.
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const ancestor = byPath.get(segments.slice(0, depth).join("/"));
      if (ancestor) ancestor.totalDocuments += 1;
    }
  }

  const sortFolders = (folders: DocumentFolder<T>[]) => {
    folders.sort((a, b) => a.name.localeCompare(b.name));
    for (const folder of folders) sortFolders(folder.folders);
  };
  sortFolders(roots);

  const pinned = documents
    .filter((document) => document.pinned_at)
    .sort((a, b) => (a.pinned_at ?? "").localeCompare(b.pinned_at ?? ""));

  return { folders: roots, loose, pinned };
}

/** Every folder on the way to this one, so opening a document opens its path. */
export function ancestorPaths(path: string): string[] {
  const segments = segmentsOf(path);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** A folder row shows this one; the pane's location column shows the whole path. */
export function folderLabel(path: string) {
  const segments = segmentsOf(path);
  return segments[segments.length - 1] ?? "";
}
