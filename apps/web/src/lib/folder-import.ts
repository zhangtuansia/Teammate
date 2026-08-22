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

export const FOLDER_IMPORT_FILE_LIMIT = 200;
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
 * What to call the document. A nested file keeps its folders in the name, since
 * `api.md` and `internal/api.md` are two different notes and the workspace has
 * no folders of its own to tell them apart with.
 */
export function documentTitleFor(path: string) {
  const withoutExtension = path.replace(/\.(md|markdown|mdx|txt|text)$/i, '');
  return withoutExtension || path;
}
