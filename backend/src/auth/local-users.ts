import { accessSync, readFileSync, constants } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { expectJsonObject, parseJson, type JsonObject, type JsonValue } from "../types/shared.js";
import { readEnvVar } from "../env.js";
import { missingEnvAdminVars } from "./context.js";
import { getLocalUsersFilePath } from "../storage/data-root.js";
import { pathExistsSync } from "../storage/fs-primitives.js";
import { InvalidCredentialsError } from "./service.js";

export interface LocalUserRow {
  username: string;
  id: string;
  displayName: string;
  password_hash: string;
}

export class LocalUsersConfigError extends Error {}

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;

const SCRYPT_HASH_SHAPE = /^scrypt:[0-9a-f]+:[0-9a-f]+$/;

const LOCAL_USER_ROW_KEYS: readonly string[] = ["username", "id", "displayName", "password_hash"];

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_COST, r: SCRYPT_BLOCK, p: SCRYPT_PARALLEL },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

export async function hashLocalUserPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(plaintext, salt);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function compareLocalUserPassword(plaintext: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expectedHash = Buffer.from(parts[2], "hex");
  const computedHash = await scryptAsync(plaintext, salt);
  if (computedHash.length !== expectedHash.length) return false;
  return timingSafeEqual(computedHash, expectedHash);
}

export function isScryptPasswordHash(value: string): boolean {
  return SCRYPT_HASH_SHAPE.test(value);
}

function requiredString(row: JsonObject, key: string, index: number): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LocalUsersConfigError(
      `Account ${index} in the local users file has no non-empty string "${key}".`,
    );
  }
  return value;
}

function decodeLocalUserRow(value: JsonValue, index: number): LocalUserRow {
  let row: JsonObject;
  try {
    row = expectJsonObject(value);
  } catch {
    throw new LocalUsersConfigError(`Account ${index} in the local users file is not a JSON object.`);
  }
  for (const key of Object.keys(row)) {
    if (!LOCAL_USER_ROW_KEYS.includes(key)) {
      throw new LocalUsersConfigError(
        `Account ${index} in the local users file has an unknown field "${key}". ` +
        `Accounts carry only username, id, displayName, and password_hash.`,
      );
    }
  }
  const username = requiredString(row, "username", index);
  const id = requiredString(row, "id", index);
  const displayName = requiredString(row, "displayName", index);
  const passwordHash = requiredString(row, "password_hash", index);
  if (!isScryptPasswordHash(passwordHash)) {
    throw new LocalUsersConfigError(
      `Account "${username}" in the local users file has a password_hash that is not scrypt:<salt-hex>:<hash-hex>. ` +
      `Plaintext passwords are never accepted in that field.`,
    );
  }
  return { username, id, displayName, password_hash: passwordHash };
}

export function readValidatedLocalUsers(): readonly LocalUserRow[] {
  const filePath = getLocalUsersFilePath();

  if (!pathExistsSync(filePath)) {
    return [];
  }
  try {
    accessSync(filePath, constants.R_OK);
  } catch {
    throw new LocalUsersConfigError(`The local users file "${filePath}" is not readable by this process.`);
  }
  try {
    accessSync(filePath, constants.W_OK);
  } catch {
    throw new LocalUsersConfigError(
      `The local users file "${filePath}" is not writable by this process. Account administration writes to it.`,
    );
  }

  let parsed: JsonValue;
  try {
    parsed = parseJson(readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LocalUsersConfigError(`The local users file "${filePath}" is not valid JSON: ${detail}`);
  }

  if (!Array.isArray(parsed)) {
    throw new LocalUsersConfigError(
      `The local users file "${filePath}" must contain a JSON array of accounts.`,
    );
  }
  const rows = parsed.map((value, index) => decodeLocalUserRow(value, index));
  assertLocalUserRowsConsistent(rows, filePath);
  return rows;
}

function assertLocalUserRowsConsistent(rows: readonly LocalUserRow[], filePath: string): void {
  const seenUsernames = new Set<string>();
  const seenIds = new Set<string>();
  for (const row of rows) {
    if (!isScryptPasswordHash(row.password_hash)) {
      throw new LocalUsersConfigError(
        `Account "${row.username}" has a password_hash that is not scrypt:<salt-hex>:<hash-hex>.`,
      );
    }
    if (seenUsernames.has(row.username)) {
      throw new LocalUsersConfigError(
        `The local users file "${filePath}" has more than one account with username "${row.username}".`,
      );
    }
    seenUsernames.add(row.username);
    if (seenIds.has(row.id)) {
      throw new LocalUsersConfigError(
        `The local users file "${filePath}" has more than one account with id "${row.id}".`,
      );
    }
    seenIds.add(row.id);
  }
}

export interface LocalUserIdentity {
  id: string;
  type: "human";
  displayName: string;
}

const DUMMY_PASSWORD_HASH = `scrypt:${randomBytes(16).toString("hex")}:${randomBytes(SCRYPT_KEYLEN).toString("hex")}`;

export async function verifyLocalUser(username: string, password: string): Promise<LocalUserIdentity> {
  const rows = readValidatedLocalUsers();
  const found = rows.find((row) => row.username === username);
  const passwordMatches = await compareLocalUserPassword(
    password,
    found?.password_hash ?? DUMMY_PASSWORD_HASH,
  );
  if (!found || !passwordMatches) {
    throw new InvalidCredentialsError("unauthorized: invalid credentials.");
  }
  return { id: found.id, type: "human", displayName: found.displayName };
}

export interface LocalUserPublic {
  username: string;
  id: string;
  displayName: string;
}

export class LocalUserWriteError extends Error {}

export const LOCAL_USER_MIN_PASSWORD_LENGTH = 8;

export interface AddLocalUserInput {
  username: string;
  displayName: string;
  password: string;
}

export interface UpdateLocalUserInput {
  username?: string;
  displayName?: string;
  password?: string;
}

let localUsersWriteChain: Promise<unknown> = Promise.resolve();

function withExclusiveLocalUsersFile<T>(fn: () => Promise<T>): Promise<T> {
  const gate = localUsersWriteChain.catch(() => undefined);
  const next = gate.then(fn);
  localUsersWriteChain = next;
  return next;
}

function publicRow(row: LocalUserRow): LocalUserPublic {
  return { username: row.username, id: row.id, displayName: row.displayName };
}

function requireUsableUsername(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LocalUserWriteError("An account username cannot be empty.");
  }
  return trimmed;
}

function requireUsableDisplayName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LocalUserWriteError("An account display name cannot be empty.");
  }
  return trimmed;
}

function requireUsablePassword(value: string): string {
  if (value.length === 0) {
    throw new LocalUserWriteError("An account password cannot be empty.");
  }
  if (value.length < LOCAL_USER_MIN_PASSWORD_LENGTH) {
    throw new LocalUserWriteError(
      `An account password must be at least ${LOCAL_USER_MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  return value;
}

function assertUsernameAndIdFree(
  rows: readonly LocalUserRow[],
  username: string,
  id: string,
  ignoreId: string | null,
): void {
  for (const row of rows) {
    if (ignoreId !== null && row.id === ignoreId) continue;
    if (row.username === username) {
      throw new LocalUserWriteError(`Another account already uses the username "${username}".`);
    }
    if (row.id === id) {
      throw new LocalUserWriteError(`Another account already uses the id "${id}".`);
    }
  }
}

async function replaceLocalUsersFile(filePath: string, rows: readonly LocalUserRow[]): Promise<void> {
  assertLocalUserRowsConsistent(rows, filePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

export function addLocalUser(input: AddLocalUserInput): Promise<LocalUserPublic> {
  return withExclusiveLocalUsersFile(async () => {
    const filePath = getLocalUsersFilePath();
    const username = requireUsableUsername(input.username);
    const displayName = requireUsableDisplayName(input.displayName);
    const password = requireUsablePassword(input.password);

    const rows = readValidatedLocalUsers();
    const id = `human-${randomUUID()}`;
    assertUsernameAndIdFree(rows, username, id, null);

    const added: LocalUserRow = {
      username,
      id,
      displayName,
      password_hash: await hashLocalUserPassword(password),
    };
    await replaceLocalUsersFile(filePath, [...rows, added]);
    return publicRow(added);
  });
}

export function updateLocalUser(id: string, changes: UpdateLocalUserInput): Promise<LocalUserPublic> {
  return withExclusiveLocalUsersFile(async () => {
    const filePath = getLocalUsersFilePath();
    const rows = readValidatedLocalUsers();
    const existing = rows.find((row) => row.id === id);
    if (!existing) {
      throw new LocalUserWriteError(`No account has the id "${id}".`);
    }

    const username = changes.username === undefined
      ? existing.username
      : requireUsableUsername(changes.username);
    const displayName = changes.displayName === undefined
      ? existing.displayName
      : requireUsableDisplayName(changes.displayName);
    const passwordHash = changes.password === undefined
      ? existing.password_hash
      : await hashLocalUserPassword(requireUsablePassword(changes.password));

    assertUsernameAndIdFree(rows, username, existing.id, existing.id);

    const updated: LocalUserRow = { username, id: existing.id, displayName, password_hash: passwordHash };
    await replaceLocalUsersFile(filePath, rows.map((row) => (row.id === existing.id ? updated : row)));
    return publicRow(updated);
  });
}

export function deleteLocalUser(id: string): Promise<void> {
  return withExclusiveLocalUsersFile(async () => {
    const filePath = getLocalUsersFilePath();
    const rows = readValidatedLocalUsers();
    if (!rows.some((row) => row.id === id)) {
      throw new LocalUserWriteError(`No account has the id "${id}".`);
    }
    if (rows.length === 1) {
      throw new LocalUserWriteError("The last local account cannot be deleted.");
    }
    await replaceLocalUsersFile(filePath, rows.filter((row) => row.id !== id));
  });
}

export function listLocalUsers(): LocalUserPublic[] {
  return readValidatedLocalUsers().map(publicRow);
}

export function assertLocalUsersModeConsistency(): void {
  const filePath = getLocalUsersFilePath();
  const mode = (readEnvVar("KS_AUTH_MODE") ?? "").toLowerCase();

  if (mode === "local_users") {
    const missing = missingEnvAdminVars();
    if (missing.length > 0) {
      throw new Error(
        `FATAL: KS_AUTH_MODE=local_users requires the hard-coded admin identity to be configured.\n` +
        `Unset or empty: ${missing.join(", ")}.\n` +
        `KS_USER_NAME, KS_USER_EMAIL, and KS_USER_ID still count until renamed. When both names are set, KS_ADMIN_* is used.\n` +
        `That identity is this install's admin and is separate from every local account.\n` +
        `Local accounts are ordinary humans; the admin adds and removes them in Admin -> Accounts.`,
      );
    }
    return;
  }

  if (pathExistsSync(filePath)) {
    throw new Error(
      `FATAL: a local users accounts file exists at "${filePath}" but KS_AUTH_MODE is "${mode}".\n` +
      `Local accounts are only ever used when KS_AUTH_MODE=local_users, so this is a corrupt setup:\n` +
      `either set KS_AUTH_MODE=local_users, or remove that file.`,
    );
  }
}
