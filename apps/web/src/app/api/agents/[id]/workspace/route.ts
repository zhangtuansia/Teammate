import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readdir, readFile, stat, access } from "fs/promises";
import { join } from "path";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: string;
}

// GET /api/agents/[id]/workspace — list workspace files or read a specific file
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get agent with workspace_path
  const { data: agent } = await supabase
    .from("agents")
    .select("id, workspace_path")
    .eq("id", id)
    .eq("owner_id", user.id)
    .single();

  if (!agent || !agent.workspace_path) {
    return NextResponse.json(
      { error: "Agent not found or workspace not initialized" },
      { status: 404 }
    );
  }

  const workspacePath = agent.workspace_path as string;

  // Check if workspace path is accessible from this server
  try {
    await access(workspacePath);
  } catch {
    return NextResponse.json(
      {
        error: "remote_workspace",
        message:
          "Workspace files are stored on the machine running the bridge and cannot be browsed from the cloud.",
        workspace_path: workspacePath,
      },
      { status: 422 }
    );
  }

  const filePath = request.nextUrl.searchParams.get("file");

  // If ?file= is specified, read that file's content
  if (filePath) {
    // Security: prevent path traversal
    const resolvedPath = join(workspacePath, filePath);
    if (!resolvedPath.startsWith(workspacePath)) {
      return NextResponse.json(
        { error: "Invalid file path" },
        { status: 400 }
      );
    }

    try {
      const content = await readFile(resolvedPath, "utf-8");
      return NextResponse.json({ file: filePath, content });
    } catch {
      return NextResponse.json(
        { error: "File not found" },
        { status: 404 }
      );
    }
  }

  // Otherwise, list workspace files (top-level + notes/)
  try {
    const files: FileEntry[] = [];

    const entries = await readdir(workspacePath);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const entryPath = join(workspacePath, entry);
      const entryStat = await stat(entryPath);
      files.push({
        name: entry,
        type: entryStat.isDirectory() ? "directory" : "file",
        size: entryStat.size,
        modified: entryStat.mtime.toISOString(),
      });
    }

    // Also list files inside notes/ if it exists
    const notesDir = join(workspacePath, "notes");
    const notesFiles: FileEntry[] = [];
    try {
      const notesEntries = await readdir(notesDir);
      for (const entry of notesEntries) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(notesDir, entry);
        const entryStat = await stat(entryPath);
        notesFiles.push({
          name: `notes/${entry}`,
          type: entryStat.isDirectory() ? "directory" : "file",
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
        });
      }
    } catch {
      // notes/ directory may not exist yet
    }

    return NextResponse.json({
      workspace_path: workspacePath,
      files,
      notes_files: notesFiles,
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to read workspace" },
      { status: 500 }
    );
  }
}
