import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

const MAGIC = Buffer.from("TEAMKEY1");
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

export class EncryptedCredentialStore {
  private readonly identity = machineIdentity();

  constructor(private readonly filePath: string) {}

  async list() {
    return this.readAll();
  }

  async get(id: string) {
    return (await this.readAll())[id];
  }

  async set(id: string, credential: StoredCredential) {
    const records = await this.readAll();
    records[id] = credential;
    await this.writeAll(records);
  }

  async delete(id: string) {
    const records = await this.readAll();
    delete records[id];
    await this.writeAll(records);
  }

  private async readAll(): Promise<CredentialMap> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }

    const minimumBytes = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES + 1;
    if (encrypted.length < minimumBytes || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("Teammate credential store is invalid");
    }

    let offset = MAGIC.length;
    const salt = encrypted.subarray(offset, offset += SALT_BYTES);
    const iv = encrypted.subarray(offset, offset += IV_BYTES);
    const tag = encrypted.subarray(offset, offset += TAG_BYTES);
    const content = encrypted.subarray(offset);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(this.identity, salt), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(content), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as CredentialMap;
  }

  private async writeAll(records: CredentialMap) {
    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", deriveKey(this.identity, salt), iv);
    const content = Buffer.concat([
      cipher.update(JSON.stringify(records), "utf8"),
      cipher.final(),
    ]);
    const encrypted = Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), content]);
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, encrypted, { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
