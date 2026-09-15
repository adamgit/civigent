import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { mintShareGrant, validateShareGrant } from "../../auth/share-grants.js";
import { appendShareDiaryEntry, listShareDiaryEntriesForUser } from "../../auth/share-diary.js";
import { getAuthRoot } from "../../storage/data-root.js";
import type { ShareDiaryEntry } from "../../types/shared.js";

describe("share diary — non-authority (spec 08)", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function setEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      savedEnv[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "share-diary-test-"));
    setEnv({ KS_DATA_ROOT: tmpDir });
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("validates and redeems a grant whose diary entry was never written", () => {
    const { token } = mintShareGrant({
      target: { kind: "file", path: "/doc.md" },
      action: "read",
      expiry: 7,
      issuedBy: "human-1",
    });

    // No appendShareDiaryEntry call at all — the diary file does not exist.
    const grant = validateShareGrant(token);
    expect(grant).not.toBeNull();
    expect(grant?.path).toBe("/doc.md");
  });

  it("still validates a grant after its diary entry is deleted / the diary file is corrupted", async () => {
    const { token } = mintShareGrant({
      target: { kind: "folder", path: "/shared" },
      action: "write",
      expiry: 7,
      issuedBy: "human-1",
    });

    await appendShareDiaryEntry({
      id: randomUUID(),
      kind: "folder",
      path: "/shared",
      action: "write",
      created_by: "human-1",
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    });

    // Corrupt the diary file directly — the grant's validity must not depend
    // on the diary being readable at all.
    const authDir = getAuthRoot();
    await writeFile(path.join(authDir, "share-diary.json"), "not valid json{{{");

    const grant = validateShareGrant(token);
    expect(grant).not.toBeNull();
    expect(grant?.path).toBe("/shared");
  });

  it("lists only the requesting minter's own entries and never carries a bearer token", async () => {
    const humanA = "human-a";
    const humanB = "human-b";

    const entryA: ShareDiaryEntry = {
      id: randomUUID(),
      kind: "file",
      path: "/a.md",
      action: "read",
      created_by: humanA,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const entryB: ShareDiaryEntry = {
      id: randomUUID(),
      kind: "folder",
      path: "/b",
      action: "write",
      created_by: humanB,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    };

    await appendShareDiaryEntry(entryA);
    await appendShareDiaryEntry(entryB);

    const forA = await listShareDiaryEntriesForUser(humanA);
    expect(forA.map((e) => e.id)).toEqual([entryA.id]);
    expect(forA.every((e) => e.created_by === humanA)).toBe(true);

    const forB = await listShareDiaryEntriesForUser(humanB);
    expect(forB.map((e) => e.id)).toEqual([entryB.id]);

    for (const entry of [...forA, ...forB]) {
      expect(Object.keys(entry).sort()).toEqual(
        ["action", "created_at", "created_by", "expires_at", "id", "kind", "path"].sort(),
      );
    }
  });

  it("serializes concurrent mints so no entry is lost to a read-modify-write race", async () => {
    const writes = Array.from({ length: 20 }, (_, i) =>
      appendShareDiaryEntry({
        id: `entry-${i}`,
        kind: "file",
        path: `/doc-${i}.md`,
        action: "read",
        created_by: "human-concurrent",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    );
    await Promise.all(writes);

    const entries = await listShareDiaryEntriesForUser("human-concurrent");
    expect(entries).toHaveLength(20);
    expect(new Set(entries.map((e) => e.id)).size).toBe(20);
  });
});
