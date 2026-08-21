import { chmodSync, mkdirSync } from "node:fs";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function supportsPosixPermissions(platform = process.platform) {
  return platform !== "win32";
}

export function enforcePrivateFileCreationMask(platform = process.platform) {
  if (supportsPosixPermissions(platform)) process.umask(0o077);
}

export function ensurePrivateDirectory(path: string, platform = process.platform) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (supportsPosixPermissions(platform)) chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export function restrictPrivateFile(path: string, platform = process.platform) {
  if (!supportsPosixPermissions(platform)) return;
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function restrictSqliteFiles(databasePath: string, platform = process.platform) {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
    `${databasePath}-journal`,
  ]) {
    restrictPrivateFile(path, platform);
  }
}
