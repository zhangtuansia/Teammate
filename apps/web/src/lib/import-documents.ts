import {
  FOLDER_IMPORT_FILE_LIMIT,
  documentPlacement,
  planFolderImport,
} from "@/lib/folder-import";

export interface ImportOutcome {
  added: number;
  /** Readable notes left behind because the folder holds more than we take. */
  skippedOverLimit: number;
  error?: string;
}

interface DocumentWriter {
  from: (table: string) => {
    insert: (rows: unknown[]) => PromiseLike<{ error: { message: string } | null }>;
  };
  auth: { getUser: () => PromiseLike<{ data: { user: { id: string } | null } }> };
}

/**
 * Notes from the disk become documents. Used by the card in the documents pane
 * and by dropping onto a folder in the sidebar, which have to agree about what
 * counts as a note and where it lands — a file dropped on a folder belongs in
 * that folder, and one dropped on the workspace belongs nowhere in particular.
 *
 * They are copied, not linked. The workspace owns what it holds, and a document
 * that quietly rewrote a file on disk — or went missing when one was renamed —
 * would be a surprise nobody asked for.
 */
export async function importFilesAsDocuments({
  client,
  files,
  intoFolder,
  serverId,
}: {
  client: DocumentWriter;
  files: File[];
  intoFolder: string;
  serverId: string;
}): Promise<ImportOutcome> {
  const plan = planFolderImport(files);
  if (plan.candidates.length === 0) {
    return { added: 0, skippedOverLimit: plan.skippedOverLimit };
  }

  const { data: auth } = await client.auth.getUser();
  if (!auth.user) return { added: 0, error: "no-user", skippedOverLimit: 0 };
  const owner = auth.user.id;

  const rows = await Promise.all(
    plan.candidates.map(async (candidate) => {
      const placement = documentPlacement(candidate.path);
      // A note's own folders sit under wherever it was dropped.
      const folder = [intoFolder, placement.folder].filter(Boolean).join("/");
      return {
        content: await candidate.file.text(),
        created_by: owner,
        folder_path: folder,
        server_id: serverId,
        title: placement.title,
      };
    }),
  );

  const { error } = await client.from("documents").insert(rows);
  if (error) return { added: 0, error: error.message, skippedOverLimit: 0 };
  return { added: rows.length, skippedOverLimit: plan.skippedOverLimit };
}

export { FOLDER_IMPORT_FILE_LIMIT };
