import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EncryptedCredentialStore,
  type StoredCredential,
} from "./credential-store.js";

const SALT_BYTES = 16;
const IV_BYTES = 12;

function testMachineIdentity() {
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
      // Match the production hostname fallback.
    }
  }
  return `${process.platform}:${hostname()}`;
}

function legacyEncrypt(value: unknown) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = pbkdf2Sync(
    `teammate:${testMachineIdentity()}`,
    salt,
    120_000,
    32,
    "sha256",
  );
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const content = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), content]);
}

function legacyStore(
  version: 1 | 2,
  records: Record<string, StoredCredential>,
) {
  if (version === 1) {
    return Buffer.concat([Buffer.from("TEAMKEY1"), legacyEncrypt(records)]);
  }
  return Buffer.concat([
    Buffer.from("TEAMKEY2"),
    Buffer.from(JSON.stringify(Object.fromEntries(
      Object.entries(records).map(([id, credential]) => [
        id,
        legacyEncrypt(credential).toString("base64url"),
      ]),
    )), "utf8"),
  ]);
}

async function withTemporaryStore(
  run: (filePath: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "teammate-credential-store-"));
  try {
    await run(join(directory, "credentials.enc"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("concurrent set and delete operations preserve unrelated credentials", async () => {
  await withTemporaryStore(async (filePath) => {
    const first = new EncryptedCredentialStore(filePath);
    const second = new EncryptedCredentialStore(filePath);
    await first.set("keep", { type: "api_key", key: "original" });

    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? first : second).set(`connection-${index}`, {
          type: "api_key",
          key: `key-${index}`,
        }),
      ),
      first.set("keep", { type: "api_key", key: "updated" }),
    ]);
    await Promise.all([
      first.delete("connection-2"),
      second.delete("connection-7"),
      first.set("connection-8", { type: "api_key", key: "key-8" }),
    ]);

    const records = await second.list();
    assert.equal(records.keep?.type, "api_key");
    assert.equal(records.keep?.key, "updated");
    assert.equal(records["connection-0"]?.type, "api_key");
    assert.equal(records["connection-0"]?.key, "key-0");
    assert.equal(records["connection-2"], undefined);
    assert.equal(records["connection-7"], undefined);
    assert.equal(records["connection-8"]?.type, "api_key");
    assert.equal(records["connection-8"]?.key, "key-8");
    assert.equal((await readdir(join(filePath, ".."))).some((name) => name.endsWith(".tmp")), false);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  });
});

test("a corrupt credential entry does not hide healthy entries or leak secret data", async () => {
  await withTemporaryStore(async (filePath) => {
    const store = new EncryptedCredentialStore(filePath);
    await store.set("healthy", { type: "api_key", key: "safe-key" });
    await store.set("broken", { type: "api_key", key: "do-not-leak" });

    const encrypted = await readFile(filePath);
    const entries = JSON.parse(encrypted.subarray(Buffer.byteLength("TEAMKEY3")).toString("utf8")) as Record<string, string>;
    entries.broken = "not-an-encrypted-entry";
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.from("TEAMKEY3"),
        Buffer.from(JSON.stringify(entries), "utf8"),
      ]),
      { mode: 0o600 },
    );

    const result = await store.listResult();
    assert.equal(result.credentials.healthy?.type, "api_key");
    assert.equal(result.credentials.healthy?.key, "safe-key");
    assert.equal(result.credentials.broken, undefined);
    assert.deepEqual(result.issues, [{
      id: "broken",
      code: "corrupt_entry",
      message: "This provider credential is unreadable. Reconnect the provider.",
    }]);
    assert.doesNotMatch(JSON.stringify(result.issues), /safe-key|do-not-leak/);
    assert.deepEqual(await store.getResult("broken"), {
      credential: undefined,
      issue: result.issues[0],
    });

    await store.set("new-provider", { type: "api_key", key: "new-key" });
    const afterUnrelatedWrite = await store.listResult();
    assert.equal(afterUnrelatedWrite.credentials["new-provider"]?.type, "api_key");
    assert.equal(afterUnrelatedWrite.issues[0]?.id, "broken");

    await store.set("broken", { type: "api_key", key: "reconnected" });
    assert.deepEqual((await store.listResult()).issues, []);
    assert.equal((await store.get("broken"))?.type, "api_key");
  });
});

test("TEAMKEY3 rejects ciphertext moved to a different connection id", async () => {
  await withTemporaryStore(async (filePath) => {
    const store = new EncryptedCredentialStore(filePath);
    await store.set("connection-a", { type: "api_key", key: "key-a" });
    await store.set("connection-b", { type: "api_key", key: "key-b" });

    const encrypted = await readFile(filePath);
    assert.equal(encrypted.subarray(0, 8).toString("utf8"), "TEAMKEY3");
    const entries = JSON.parse(encrypted.subarray(8).toString("utf8")) as Record<string, string>;
    [entries["connection-a"], entries["connection-b"]] = [
      entries["connection-b"],
      entries["connection-a"],
    ];
    await writeFile(
      filePath,
      Buffer.concat([Buffer.from("TEAMKEY3"), Buffer.from(JSON.stringify(entries))]),
      { mode: 0o600 },
    );

    const result = await store.listResult();
    assert.deepEqual(result.credentials, {});
    assert.deepEqual(result.issues.map((issue) => issue.id), [
      "connection-a",
      "connection-b",
    ]);
    assert.doesNotMatch(JSON.stringify(result.issues), /key-a|key-b/);
  });
});

test("TEAMKEY1 and TEAMKEY2 remain readable and migrate on the next mutation", async () => {
  await withTemporaryStore(async (filePath) => {
    for (const version of [1, 2] as const) {
      await writeFile(filePath, legacyStore(version, {
        existing: { type: "api_key", key: `legacy-${version}` },
      }), { mode: 0o600 });
      const store = new EncryptedCredentialStore(filePath);

      const beforeMigration = await store.listResult();
      assert.equal(beforeMigration.credentials.existing?.type, "api_key");
      assert.equal(beforeMigration.credentials.existing?.key, `legacy-${version}`);
      assert.deepEqual(beforeMigration.issues, []);

      await store.set("added", { type: "api_key", key: `added-${version}` });
      const migrated = await readFile(filePath);
      assert.equal(migrated.subarray(0, 8).toString("utf8"), "TEAMKEY3");
      assert.equal((await store.get("existing"))?.type, "api_key");
      assert.equal((await store.get("added"))?.type, "api_key");
    }
  });
});
