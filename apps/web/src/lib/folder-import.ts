/**
 * Reading a folder off the disk is this app's version of "upload". There is no
 * server to upload to — the documents live in a SQLite file next to the app —
 * so the honest gesture is to point at a folder and have its notes appear.
 *
 * Only text is taken. A folder of holiday photos should produce nothing rather
 * than a thousand rows of binary, and someone who picks their home directory by
 * accident should get a refusal, not a workspace they have to clean out.
 */

/** Extensions worth reading. Markdown is the storage format; the rest are text. */
const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'mdx', 'txt', 'text']);

/** Folders that belong to tools, not to the person who keeps notes in them. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.obsidian',
  '.trash',
  'node_modules',
  '__pycache__',
]);

export const FOLDER_IMPORT_FILE_LIMIT = 500;
const FILE_SIZE_LIMIT = 1024 * 1024;

export interface FolderImportCandidate {
  /** Path within the chosen folder, which is also what makes the title unique. */
  path: string;
  file: File;
}

export interface FolderImportPlan {
  candidates: FolderImportCandidate[];
  /** Readable files left out because the folder holds more than we will take. */
  skippedOverLimit: number;
}

function extensionOf(name: string) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The path the browser reports, minus the name of the folder itself. */
function relativePath(file: File) {
  const full = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  const cut = full.indexOf('/');
  return cut === -1 ? full : full.slice(cut + 1);
}

export function planFolderImport(files: readonly File[]): FolderImportPlan {
  const readable: FolderImportCandidate[] = [];
  for (const file of files) {
    if (file.size === 0 || file.size > FILE_SIZE_LIMIT) continue;
    if (!TEXT_EXTENSIONS.has(extensionOf(file.name))) continue;
    const path = relativePath(file);
    if (path.split('/').some((segment) => SKIPPED_DIRECTORIES.has(segment))) continue;
    readable.push({ file, path });
  }
  readable.sort((a, b) => a.path.localeCompare(b.path));
  return {
    candidates: readable.slice(0, FOLDER_IMPORT_FILE_LIMIT),
    skippedOverLimit: Math.max(0, readable.length - FOLDER_IMPORT_FILE_LIMIT),
  };
}

/**
 * The document's name and the folder it goes in. The folder a note was filed
 * under is what tells you what it is about, so the tree the folder came in is
 * kept rather than pressed flat into the title.
 *
 * The chosen folder is the root, so `notes/api/v2/errors.md` becomes `errors`
 * in `api/v2` — the same shape it had on disk.
 */
export function documentPlacement(path: string) {
  const segments = path.split('/');
  const name = segments.pop() ?? path;
  return {
    folder: segments.join('/'),
    title: name.replace(/\.(md|markdown|mdx|txt|text)$/i, '') || name,
  };
}

/** The folders a set of documents implies, including the ones only on the way. */
export function folderTreeOf(paths: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    const segments = path.split('/');
    // `api/v2` means there is an `api` too, even with nothing filed directly
    // in it — otherwise the tree would have a branch growing out of nothing.
    for (let depth = 1; depth <= segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join('/'));
    }
  }
  return [...folders].sort((a, b) => a.localeCompare(b));
}
