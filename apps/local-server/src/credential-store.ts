import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

const LEGACY_SINGLE_PAYLOAD_MAGIC = Buffer.from("TEAMKEY1");
const LEGACY_ENTRY_MAGIC = Buffer.from("TEAMKEY2");
const MAGIC = Buffer.from("TEAMKEY3");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type StoredCredential =
  | { type: "api_key"; key: string }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      accountId?: string;
    };

type CredentialMap = Record<string, StoredCredential>;
type EncryptedCredentialMap = Record<string, unknown>;

type InternalCredentialStoreReadResult = CredentialStoreReadResult & {
  corruptEntries: EncryptedCredentialMap;
};

export type CredentialStoreIssue = {
  id?: string;
  code: "corrupt_entry" | "store_unreadable";
  message: string;
};

export type CredentialStoreReadResult = {
  credentials: CredentialMap;
  issues: CredentialStoreIssue[];
};

/** A safe error intended for callers that need to report a broken credential file. */
export class CredentialStoreError extends Error {
  readonly code = "store_unreadable" as const;

  constructor() {
    super("Teammate could not read the local credential store. Reconnect the affected provider.");
    this.name = "CredentialStoreError";
  }
}

function machineIdentity() {
  if (process.platform === "darwin") {
    try {
      const output = execFileSync(
        "ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } catch {
      // Fall back to the machine hostname below.
    }
  }
  return `${process.platform}:${hostname()}`;
}

function deriveKey(identity: string, salt: Buffer) {
  return pbkdf2Sync(
    `teammate:${identity}`,
    salt,
    120_000,
    32,
    "sha256",
  );
}

function entryAdditionalData(id: string) {
  return Buffer.from(`TEAMKEY3\0${id}`, "utf8");
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") return typeof credential.key === "string";
  return credential.type === "oauth"
    && typeof credential.access === "string"
    && typeof credential.refresh === "string"
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires)
    && (credential.accountId === undefined || typeof credential.accountId === "string");
}

function corruptEntry(id: string): CredentialStoreIssue {
  return {
    id,
    code: "corrupt_entry",
    message: "This provider credential is unreadable. Reconnect the provider.",
  };
}

function unreadableStore(): CredentialStoreIssue {
  return {
    code: "store_unreadable",
    message: "Teammate could not read the local credential store. Reconnect the affected provider.",
  };
}

export class EncryptedCredentialStore {
  private static readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly identity = machineIdentity();
  private readonly queueKey: string;

  constructor(private readonly filePath: string) {
    this.queueKey = resolve(filePath);
  }

  async list() {
    return (await this.readAll()).credentials;
  }

  /**
   * Returns readable credentials and safe, per-provider repair information.
   * Existing list/get callers can remain simple while settings UI can surface repair.
   */
  async listResult(): Promise<CredentialStoreReadResult> {
    try {
      return await this.readAll();
    } catch (error) {
      if (error instanceof CredentialStoreError) {
        return { credentials: {}, issues: [unreadableStore()] };
      }
      throw error;
    }
  }

  async get(id: string) {
    return (await this.readAll()).credentials[id];
  }

  async getResult(id: string): Promise<{
    credential?: StoredCredential;
    issue?: CredentialStoreIssue;
  }> {
    const result = await this.listResult();
    return {
      credential: result.credentials[id],
      issue: result.issues.find((issue) => issue.id === id)
        ?? result.issues.find((issue) => issue.code === "store_unreadable"),
    };
  }

  async set(id: string, credential: StoredCredential) {
    await this.mutate([id], (records) => {
      records[id] = credential;
    });
  }

  async delete(id: string) {
    await this.mutate([id], (records) => {
      delete records[id];
    });
  }

  private async mutate(
    affectedIds: string[],
    operation: (records: CredentialMap) => void | Promise<void>,
  ) {
    const previous = EncryptedCredentialStore.mutationQueues.get(this.queueKey) ?? Promise.resolve();
    const mutation = previous.then(async () => {
      const current = await this.readAll();
      const records = current.credentials;
      await operation(records);
      await this.writeAll(records, current.corruptEntries, new Set(affectedIds));
    });
    const settled = mutation.then(
      () => undefined,
      () => undefined,
    );
    EncryptedCredentialStore.mutationQueues.set(this.queueKey, settled);
    try {
      await mutation;
    } finally {
      if (EncryptedCredentialStore.mutationQueues.get(this.queueKey) === settled) {
        EncryptedCredentialStore.mutationQueues.delete(this.queueKey);
      }
    }
  }

  private async readAll(): Promise<InternalCredentialStoreReadResult> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { credentials: {}, issues: [], corruptEntries: {} };
      }
      throw error;
    }

    try {
      if (encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
        return this.readEntries(encrypted.subarray(MAGIC.length), true);
      }
      if (encrypted.subarray(0, LEGACY_ENTRY_MAGIC.length).equals(LEGACY_ENTRY_MAGIC)) {
        return this.readEntries(encrypted.subarray(LEGACY_ENTRY_MAGIC.length), false);
      }
      if (
        encrypted.subarray(0, LEGACY_SINGLE_PAYLOAD_MAGIC.length)
          .equals(LEGACY_SINGLE_PAYLOAD_MAGIC)
      ) {
        return this.readLegacy(encrypted);
      }
    } catch {
      throw new CredentialStoreError();
    }
    throw new CredentialStoreError();
  }

  private readEntries(
    payload: Buffer,
    authenticateId: boolean,
  ): InternalCredentialStoreReadResult {
    const encryptedEntries = JSON.parse(payload.toString("utf8")) as unknown;
    if (!encryptedEntries || typeof encryptedEntries !== "object" || Array.isArray(encryptedEntries)) {
      throw new CredentialStoreError();
    }

    const credentials: CredentialMap = {};
    const issues: CredentialStoreIssue[] = [];
    const corruptEntries: EncryptedCredentialMap = {};
    for (const [id, entry] of Object.entries(encryptedEntries)) {
      if (typeof entry !== "string") {
        issues.push(corruptEntry(id));
        corruptEntries[id] = entry;
        continue;
      }
      try {
        const credential = this.decryptEntry(
          Buffer.from(entry, "base64url"),
          id,
          authenticateId,
        );
        if (!isStoredCredential(credential)) throw new Error("invalid credential");
        credentials[id] = credential;
      } catch {
        issues.push(corruptEntry(id));
        corruptEntries[id] = entry;
      }
    }
    return { credentials, issues, corruptEntries };
  }

  private readLegacy(encrypted: Buffer): InternalCredentialStoreReadResult {
    const minimumBytes = LEGACY_SINGLE_PAYLOAD_MAGIC.length
      + SALT_BYTES
      + IV_BYTES
      + TAG_BYTES
      + 1;
    if (encrypted.length < minimumBytes) throw new CredentialStoreError();
    let offset = LEGACY_SINGLE_PAYLOAD_MAGIC.length;
    const salt = encrypted.subarray(offset, offset += SALT_BYTES);
    const iv = encrypted.subarray(offset, offset += IV_BYTES);
    const tag = encrypted.subarray(offset, offset += TAG_BYTES);
    const content = encrypted.subarray(offset);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(this.identity, salt), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(content), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CredentialStoreError();
    }

    const credentials: CredentialMap = {};
    const issues: CredentialStoreIssue[] = [];
    for (const [id, credential] of Object.entries(parsed)) {
      if (isStoredCredential(credential)) credentials[id] = credential;
      else issues.push(corruptEntry(id));
    }
    return { credentials, issues, corruptEntries: {} };
  }

  private decryptEntry(
    encrypted: Buffer,
    id: string,
    authenticateId: boolean,
  ): unknown {
    const minimumBytes = SALT_BYTES + IV_BYTES + TAG_BYTES + 1;
    if (encrypted.length < minimumBytes) throw new Error("entry too short");
    let offset = 0;
    const salt = encrypted.subarray(offset, offset += SALT_BYTES);
    const iv = encrypted.subarray(offset, offset += IV_BYTES);
    const tag = encrypted.subarray(offset, offset += TAG_BYTES);
    const content = encrypted.subarray(offset);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(this.identity, salt), iv);
    if (authenticateId) decipher.setAAD(entryAdditionalData(id));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(content), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as unknown;
  }

  private encryptEntry(id: string, credential: StoredCredential): string {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(this.identity, salt), iv);
    cipher.setAAD(entryAdditionalData(id));
    const content = Buffer.concat([
      cipher.update(JSON.stringify(credential), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([salt, iv, cipher.getAuthTag(), content]).toString("base64url");
  }

  private async writeAll(
    records: CredentialMap,
    corruptEntries: EncryptedCredentialMap = {},
    replacedIds = new Set<string>(),
  ) {
    const encryptedEntries: EncryptedCredentialMap = {};
    for (const [id, credential] of Object.entries(records)) {
      encryptedEntries[id] = this.encryptEntry(id, credential);
    }
    for (const [id, entry] of Object.entries(corruptEntries)) {
      if (!(id in encryptedEntries) && !replacedIds.has(id)) encryptedEntries[id] = entry;
    }
    const encrypted = Buffer.concat([
      MAGIC,
      Buffer.from(JSON.stringify(encryptedEntries), "utf8"),
    ]);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
