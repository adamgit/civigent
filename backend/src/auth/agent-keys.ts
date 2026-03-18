/**
 * Pre-authenticated agents — file-based key store.
 *
 * Reads data/auth/agents.keys (under data root).
 * Format: agent-id:secret-hash:display-name (one per line).
 * Lines starting with # and blank lines are skipped.
 *
 * Secret hashing uses Node.js built-in scrypt (no bcrypt dependency needed).
 * Hash format: scrypt:<salt-hex>:<hash-hex>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getDataRoot } from "../storage/data-root.js";

// ─── Types ───────────────────────────────────────────────────────

export interface AgentKeyEntry {
  agentId: string;
  secretHash: string;
  displayName: string;
}

// ─── File path ───────────────────────────────────────────────────

function keysFilePath(): string {
  return path.join(getDataRoot(), "auth", "agents.keys");
}

// ─── Scrypt helpers ──────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;   // N
const SCRYPT_BLOCK = 8;      // r
const SCRYPT_PARALLEL = 1;   // p

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Hash a plaintext secret for storage.
 * Returns "scrypt:<salt-hex>:<hash-hex>".
 */
export async function hashSecret(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(plaintext, salt);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Compare a plaintext secret against a stored hash.
 * Uses timing-safe comparison.
 */
export async function compareSecret(plaintext: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expectedHash = Buffer.from(parts[2], "hex");
  const computedHash = await scryptAsync(plaintext, salt);
  if (computedHash.length !== expectedHash.length) return false;
  return timingSafeEqual(computedHash, expectedHash);
}

// ─── File operations ─────────────────────────────────────────────

/**
 * Read and parse the agents.keys file.
 * Returns empty array if file doesn't exist.
 */
export async function readAgentKeys(): Promise<AgentKeyEntry[]> {
  let content: string;
  try {
    content = await readFile(keysFilePath(), "utf8");
  } catch {
    return [];
  }

  const entries: AgentKeyEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const firstColon = trimmed.indexOf(":");
    if (firstColon < 0) continue;

    const agentId = trimmed.slice(0, firstColon);
    const rest = trimmed.slice(firstColon + 1);

    // Secret hash may contain colons (scrypt:salt:hash), so find
    // the display name after the last colon that follows the hash
    // Format: agent-id:scrypt:salt:hash:display-name
    // We know the hash format is "scrypt:<hex>:<hex>" — find the
    // display name by matching backwards
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) continue;

    const secretHash = rest.slice(0, lastColon);
    const displayName = rest.slice(lastColon + 1);

    if (!agentId || !secretHash || !displayName) continue;

    entries.push({ agentId, secretHash, displayName });
  }

  return entries;
}

/**
 * Look up an agent by ID.
 * Returns the entry if found, null otherwise.
 */
export async function lookupAgentKey(agentId: string): Promise<AgentKeyEntry | null> {
  const entries = await readAgentKeys();
  return entries.find((e) => e.agentId === agentId) ?? null;
}

/**
 * Look up an agent by matching a plaintext secret against all entries.
 * Returns the matching entry, or null if no match.
 */
export async function lookupAgentBySecret(plainSecret: string): Promise<AgentKeyEntry | null> {
  const entries = await readAgentKeys();
  for (const entry of entries) {
    if (await compareSecret(plainSecret, entry.secretHash)) {
      return entry;
    }
  }
  return null;
}

/**
 * Add a new agent entry.
 * @param withSecret - if true (default), generate a secret and return its plaintext; if false, store "none" and return null.
 * Returns the plaintext secret (shown once), or null if no secret was generated.
 */
export async function addAgentKey(agentId: string, displayName: string, withSecret = true): Promise<string | null> {
  let secretField: string;
  let plainSecret: string | null = null;

  if (withSecret) {
    plainSecret = `sk_${randomBytes(24).toString("hex")}`;
    secretField = await hashSecret(plainSecret);
  } else {
    secretField = "none";
  }

  const filePath = keysFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(filePath, "utf8");
  } catch { /* file doesn't exist yet */ }

  const newLine = `${agentId}:${secretField}:${displayName}\n`;
  const content = existing.endsWith("\n") || existing === ""
    ? existing + newLine
    : existing + "\n" + newLine;

  await writeFile(filePath, content, "utf8");
  return plainSecret;
}

/**
 * Remove an agent entry by ID.
 * Returns true if an entry was removed, false if not found.
 */
export async function removeAgentKey(agentId: string): Promise<boolean> {
  const filePath = keysFilePath();
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    return !trimmed.startsWith(agentId + ":");
  });

  if (filtered.length === lines.length) return false;

  await writeFile(filePath, filtered.join("\n"), "utf8");
  return true;
}
