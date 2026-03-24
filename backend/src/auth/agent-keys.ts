/**
 * Pre-authenticated agents — file-based key store.
 *
 * Reads data/auth/agents.keys (under data root).
 * Format: agent-id:scrypt:salt:hash:display-name (one per line).
 * Lines starting with # and blank lines are skipped.
 *
 * Secret hashing uses Node.js built-in scrypt (no bcrypt dependency needed).
 * Hash format: scrypt:<salt-hex>:<hash-hex>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getAuthRoot } from "../storage/data-root.js";

// ─── Types ───────────────────────────────────────────────────────

export interface AgentKeyEntry {
  agentId: string;
  secretHash: string;
  displayName: string;
}

export interface AgentKeysWithErrors {
  entries: AgentKeyEntry[];
  errors: string[];
}

// ─── File path ───────────────────────────────────────────────────

function keysFilePath(): string {
  return path.join(getAuthRoot(), "agents.keys");
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

// ─── Line parsing ───────────────────────────────────────────────

/**
 * Parse a single non-comment, non-blank line from agents.keys.
 * Returns the entry or null if malformed.
 */
function parseLine(trimmed: string): AgentKeyEntry | null {
  // Format: agent-id:scrypt:salt:hash:display-name
  // We need exactly 5 colon-separated fields: agentId, "scrypt", salt, hash, displayName
  const firstColon = trimmed.indexOf(":");
  if (firstColon < 0) return null;

  const agentId = trimmed.slice(0, firstColon);
  const rest = trimmed.slice(firstColon + 1);

  // For "none" secret (no-secret agents): agent-id:none:display-name
  if (rest.startsWith("none:")) {
    const displayName = rest.slice(5);
    if (!agentId || !displayName) return null;
    return { agentId, secretHash: "none", displayName };
  }

  // For scrypt: rest = scrypt:salt:hash:display-name (4 parts)
  const parts = rest.split(":");
  if (parts.length < 4) return null;
  if (parts[0] !== "scrypt") return null;

  const secretHash = `${parts[0]}:${parts[1]}:${parts[2]}`;
  const displayName = parts.slice(3).join(":");
  if (!agentId || !displayName) return null;

  return { agentId, secretHash, displayName };
}

/**
 * Extract the agentId prefix from a raw line (best-effort, for error messages).
 */
function extractAgentIdPrefix(trimmed: string): string | null {
  const firstColon = trimmed.indexOf(":");
  if (firstColon > 0) return trimmed.slice(0, firstColon);
  return null;
}

// ─── File operations ─────────────────────────────────────────────

/**
 * Read and parse the agents.keys file, collecting errors for malformed lines.
 * Returns both valid entries and error descriptions.
 */
export async function readAgentKeysAndErrors(): Promise<AgentKeysWithErrors> {
  let content: string;
  try {
    content = await readFile(keysFilePath(), "utf8");
  } catch {
    return { entries: [], errors: [] };
  }

  const entries: AgentKeyEntry[] = [];
  const errors: string[] = [];
  let lineNum = 0;

  for (const line of content.split("\n")) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const entry = parseLine(trimmed);
    if (entry) {
      entries.push(entry);
    } else {
      const prefix = extractAgentIdPrefix(trimmed) ?? "(unknown)";
      errors.push(`Line ${lineNum}: malformed entry for agent "${prefix}" — expected format agent-id:scrypt:salt:hash:display-name`);
    }
  }

  return { entries, errors };
}

/**
 * Read and parse the agents.keys file, silently skipping malformed lines.
 * Name makes it explicit that some entries may be missing.
 */
export async function readAgentKeysSkipErrors(): Promise<AgentKeyEntry[]> {
  const { entries } = await readAgentKeysAndErrors();
  return entries;
}

/**
 * Look up an agent by ID.
 * Throws if the agent's entry exists but is malformed.
 * Returns null if the agent genuinely doesn't exist.
 */
export async function lookupAgentKey(agentId: string): Promise<AgentKeyEntry | null> {
  const { entries, errors } = await readAgentKeysAndErrors();
  const found = entries.find((e) => e.agentId === agentId);
  if (found) return found;

  // Check if the agent's ID appears in a malformed line
  const malformedMatch = errors.find((err) => err.includes(`"${agentId}"`));
  if (malformedMatch) {
    throw new Error(
      `Agent "${agentId}" exists but its entry in agents.keys is malformed: ` +
      `expected format agent-id:scrypt:salt:hash:display-name`,
    );
  }

  return null;
}

/**
 * Look up an agent by matching a plaintext secret against all entries.
 * Throws if no match is found but malformed lines exist (can't be sure it's not there).
 * Returns null only when no match AND no malformed lines.
 */
export async function lookupAgentBySecret(plainSecret: string): Promise<AgentKeyEntry | null> {
  const { entries, errors } = await readAgentKeysAndErrors();
  for (const entry of entries) {
    if (await compareSecret(plainSecret, entry.secretHash)) {
      return entry;
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Cannot verify agent secret: ${errors.length} entries in agents.keys are malformed and could not be checked`,
    );
  }
  return null;
}

/**
 * Add a new agent entry.
 * @param withSecret - if true (default), generate a secret and return its plaintext; if false, store "none" and return null.
 * Returns the plaintext secret (shown once), or null if no secret was generated.
 * Throws if display name contains a colon.
 */
export async function addAgentKey(agentId: string, displayName: string, withSecret = true): Promise<string | null> {
  if (displayName.includes(":")) {
    throw new Error(
      `Display name cannot contain ":" — the agents.keys file uses colons as field delimiters. ` +
      `Received: "${displayName}"`,
    );
  }

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
