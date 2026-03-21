import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  addAgentKey,
  readAgentKeysAndErrors,
  readAgentKeysSkipErrors,
  lookupAgentKey,
  lookupAgentBySecret,
  hashSecret,
} from "../../auth/agent-keys.js";

let tempDir: string;
let savedDataRoot: string | undefined;

beforeEach(async () => {
  savedDataRoot = process.env.KS_DATA_ROOT;
  tempDir = path.join(tmpdir(), `agent-keys-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(path.join(tempDir, "auth"), { recursive: true });
  process.env.KS_DATA_ROOT = tempDir;
});

afterEach(async () => {
  if (savedDataRoot === undefined) delete process.env.KS_DATA_ROOT;
  else process.env.KS_DATA_ROOT = savedDataRoot;
  await rm(tempDir, { recursive: true, force: true });
});

function keysPath(): string {
  return path.join(tempDir, "auth", "agents.keys");
}

describe("addAgentKey — colon validation", () => {
  it("throws when display name contains a colon", async () => {
    await expect(addAgentKey("agent-1", "My: Agent")).rejects.toThrowError(
      /Display name cannot contain ":"/,
    );
  });

  it("allows display names without colons", async () => {
    const secret = await addAgentKey("agent-1", "My Agent");
    expect(secret).toBeTruthy();
    const { entries } = await readAgentKeysAndErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0].displayName).toBe("My Agent");
  });
});

describe("readAgentKeysAndErrors", () => {
  it("returns valid entries and errors for malformed lines", async () => {
    const validHash = await hashSecret("test-secret");
    await writeFile(keysPath(), [
      `agent-good:${validHash}:Good Agent`,
      `agent-bad:garbage`,
      `agent-ok:${validHash}:OK Agent`,
      `# comment line`,
      `another-bad-line`,
    ].join("\n"));

    const { entries, errors } = await readAgentKeysAndErrors();

    expect(entries).toHaveLength(2);
    expect(entries[0].agentId).toBe("agent-good");
    expect(entries[1].agentId).toBe("agent-ok");

    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/agent-bad/);
    expect(errors[0]).toMatch(/malformed/);
    expect(errors[1]).toMatch(/\(unknown\)/);
  });

  it("returns empty arrays for missing file", async () => {
    const { entries, errors } = await readAgentKeysAndErrors();
    expect(entries).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("readAgentKeysSkipErrors", () => {
  it("returns only valid entries, silently skipping malformed lines", async () => {
    const validHash = await hashSecret("test-secret");
    await writeFile(keysPath(), [
      `agent-good:${validHash}:Good Agent`,
      `agent-bad:garbage`,
    ].join("\n"));

    const entries = await readAgentKeysSkipErrors();
    expect(entries).toHaveLength(1);
    expect(entries[0].agentId).toBe("agent-good");
  });
});

describe("lookupAgentKey — malformed entry handling", () => {
  it("returns entry for a valid agent when another line is malformed", async () => {
    const validHash = await hashSecret("test-secret");
    await writeFile(keysPath(), [
      `agent-good:${validHash}:Good Agent`,
      `agent-bad:garbage`,
    ].join("\n"));

    const entry = await lookupAgentKey("agent-good");
    expect(entry).not.toBeNull();
    expect(entry!.agentId).toBe("agent-good");
  });

  it("throws when the requested agent's entry is malformed", async () => {
    const validHash = await hashSecret("test-secret");
    await writeFile(keysPath(), [
      `agent-good:${validHash}:Good Agent`,
      `agent-bad:garbage`,
    ].join("\n"));

    await expect(lookupAgentKey("agent-bad")).rejects.toThrowError(
      /Agent "agent-bad" exists but its entry in agents.keys is malformed/,
    );
  });

  it("returns null when agent genuinely does not exist", async () => {
    const validHash = await hashSecret("test-secret");
    await writeFile(keysPath(), `agent-good:${validHash}:Good Agent\n`);

    const entry = await lookupAgentKey("agent-missing");
    expect(entry).toBeNull();
  });
});

describe("lookupAgentBySecret — malformed entry handling", () => {
  it("returns entry when secret matches a valid line", async () => {
    const secret = await addAgentKey("agent-1", "Test Agent");
    expect(secret).toBeTruthy();

    const entry = await lookupAgentBySecret(secret!);
    expect(entry).not.toBeNull();
    expect(entry!.agentId).toBe("agent-1");
  });

  it("throws when no match found and malformed lines exist", async () => {
    const validHash = await hashSecret("real-secret");
    await writeFile(keysPath(), [
      `agent-good:${validHash}:Good Agent`,
      `agent-bad:garbage`,
    ].join("\n"));

    await expect(lookupAgentBySecret("wrong-secret")).rejects.toThrowError(
      /Cannot verify agent secret.*malformed/,
    );
  });

  it("returns null when no match and no malformed lines", async () => {
    const validHash = await hashSecret("real-secret");
    await writeFile(keysPath(), `agent-good:${validHash}:Good Agent\n`);

    const entry = await lookupAgentBySecret("wrong-secret");
    expect(entry).toBeNull();
  });
});
