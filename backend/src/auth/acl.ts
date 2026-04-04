/**
 * Role-based authorization model.
 *
 * All files live under {dataRoot}/auth/:
 *   defaults.json      — { "read": "authenticated", "write": "authenticated" }
 *   roles.json         — { "<userUUID>": ["admin", "legal-team"] }
 *   acl.json           — { "<docPath>": { "read": "public", "write": "admin" } }
 *   custom-roles.json  — ["legal-team", "board-members"]
 *
 * Three "magic" roles are auto-granted based on connection state:
 *   "public"        → every connection (even unauthenticated)
 *   "authenticated" → every authenticated connection
 *   "admin"         → every user whose roles.json entry includes "admin"
 *
 * Beyond auto-granting, these three are not special. The permission check is
 * identical for all roles: "does this user hold a role matching the document's
 * required role?"
 *
 * Absent file = empty/default for that concern; never throws on missing file.
 * Cache is invalidated by calling invalidateCache() after any write.
 */

import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { getAuthRoot } from "../storage/data-root.js";
import { isSingleUserMode, type AuthenticatedWriter } from "./context.js";
import { readEnvVar } from "../env.js";

/** PermissionLevel is now a plain string — any role name is valid. */
export type PermissionLevel = string;

const MAGIC_ROLES = ["public", "authenticated", "admin"] as const;

interface DefaultsFile {
  read?: string;
  write?: string;
}

interface RolesFile {
  [userId: string]: string[];
}

interface AclFile {
  [docPath: string]: { read?: string; write?: string };
}

interface AclCache {
  defaults: DefaultsFile;
  roles: RolesFile;
  acl: AclFile;
  customRoles: string[];
}

let _cache: AclCache | null = null;

async function loadJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function loadCache(): Promise<AclCache> {
  if (_cache) return _cache;

  const authDir = getAuthRoot();
  const [defaults, roles, acl, customRoles] = await Promise.all([
    loadJsonFile<DefaultsFile>(path.join(authDir, "defaults.json")),
    loadJsonFile<RolesFile>(path.join(authDir, "roles.json")),
    loadJsonFile<AclFile>(path.join(authDir, "acl.json")),
    loadJsonFile<string[]>(path.join(authDir, "custom-roles.json")),
  ]);

  _cache = {
    defaults: defaults ?? {},
    roles: roles ?? {},
    acl: acl ?? {},
    customRoles: Array.isArray(customRoles) ? customRoles : [],
  };
  return _cache;
}

export function invalidateCache(): void {
  _cache = null;
}

function getSingleUserId(): string {
  return readEnvVar("KS_USER_ID", "human-ui");
}

/**
 * Returns true if the given writer ID has the "admin" role.
 *
 * In single_user mode, the configured user is always admin without reading roles.json.
 * In oidc/hybrid mode, admin is granted via roles.json only.
 */
export async function isAdmin(writerId: string): Promise<boolean> {
  // single_user: the singleton identity is always admin
  if (isSingleUserMode()) {
    return writerId === getSingleUserId();
  }

  const cache = await loadCache();
  const roles = cache.roles[writerId];
  return Array.isArray(roles) && roles.includes("admin");
}

/**
 * Returns true if any user in roles.json has the "admin" role.
 */
export async function hasAnyAdmin(): Promise<boolean> {
  const cache = await loadCache();
  return Object.values(cache.roles).some(
    (roles) => Array.isArray(roles) && roles.includes("admin"),
  );
}

/**
 * Grant admin role to a user by writing to roles.json.
 * Creates the auth directory and file if they don't exist.
 */
export async function grantAdmin(writerId: string): Promise<void> {
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  const rolesPath = path.join(authDir, "roles.json");
  const cache = await loadCache();
  const roles = cache.roles[writerId] ?? [];
  if (!roles.includes("admin")) {
    roles.push("admin");
  }
  cache.roles[writerId] = roles;
  await writeFile(rolesPath, JSON.stringify(cache.roles, null, 2) + "\n");
  invalidateCache();
}

/**
 * Returns the effective read permission for a given docPath.
 *
 * Resolution order:
 *   1. Exact match in acl.json
 *   2. Longest-prefix folder match in acl.json
 *   3. defaults.json "read" value (fallback: "authenticated")
 */
export async function getDocReadPermission(docPath: string): Promise<string> {
  return resolveDocPermission(docPath, "read");
}

/**
 * Returns the effective write permission for a given docPath.
 *
 * Resolution order:
 *   1. Exact match in acl.json
 *   2. Longest-prefix folder match in acl.json
 *   3. defaults.json "write" value (fallback: "authenticated")
 */
export async function getDocWritePermission(docPath: string): Promise<string> {
  return resolveDocPermission(docPath, "write");
}

async function resolveDocPermission(docPath: string, action: "read" | "write"): Promise<string> {
  const cache = await loadCache();

  // Exact match
  const exact = cache.acl[docPath];
  if (exact?.[action]) return exact[action];

  // Longest-prefix folder match — strip trailing segments until we match or exhaust
  const segments = docPath.split("/");
  for (let i = segments.length - 1; i > 0; i--) {
    const prefix = segments.slice(0, i).join("/");
    const folderEntry = cache.acl[prefix];
    if (folderEntry?.[action]) return folderEntry[action];
  }

  // Defaults
  return cache.defaults[action] ?? "authenticated";
}

/**
 * Check whether a writer has permission to perform an action on a document.
 *
 * Computes the user's effective roles (magic auto-granted + assigned from roles.json)
 * and checks if the required role for (docPath, action) is among them.
 */
export async function checkDocPermission(
  writer: AuthenticatedWriter | null,
  docPath: string,
  action: "read" | "write",
): Promise<boolean> {
  const requiredRole = await resolveDocPermission(docPath, action);
  const effectiveRoles = await getEffectiveRoles(writer);
  return effectiveRoles.includes(requiredRole);
}

/**
 * Compute the effective roles for a writer.
 * Always includes "public". Authenticated writers get "authenticated" plus any
 * roles from roles.json (including "admin" if present).
 */
async function getEffectiveRoles(writer: AuthenticatedWriter | null): Promise<string[]> {
  const roles: string[] = ["public"];

  if (!writer) return roles;

  roles.push("authenticated");

  // In single_user mode, the configured user is always admin
  if (isSingleUserMode() && writer.id === getSingleUserId()) {
    roles.push("admin");
  }

  const cache = await loadCache();
  const assignedRoles = cache.roles[writer.id];
  if (Array.isArray(assignedRoles)) {
    for (const r of assignedRoles) {
      if (!roles.includes(r)) roles.push(r);
    }
  }

  return roles;
}

// ── Custom roles ─────────────────────────────────────────────────────

export async function listCustomRoles(): Promise<string[]> {
  const cache = await loadCache();
  return [...cache.customRoles];
}

export async function addCustomRole(name: string): Promise<void> {
  if ((MAGIC_ROLES as readonly string[]).includes(name)) {
    throw new Error(`Cannot create magic role "${name}" — it is auto-granted by the system.`);
  }
  const cache = await loadCache();
  if (cache.customRoles.includes(name)) {
    throw new Error(`Custom role "${name}" already exists.`);
  }
  cache.customRoles.push(name);
  await writeCustomRoles(cache.customRoles);
  invalidateCache();
}

export async function deleteCustomRole(name: string): Promise<void> {
  if ((MAGIC_ROLES as readonly string[]).includes(name)) {
    throw new Error(`Cannot delete magic role "${name}" — it is auto-granted by the system.`);
  }
  const cache = await loadCache();
  const idx = cache.customRoles.indexOf(name);
  if (idx === -1) {
    throw new Error(`Custom role "${name}" does not exist.`);
  }
  cache.customRoles.splice(idx, 1);
  await writeCustomRoles(cache.customRoles);
  invalidateCache();
}

async function writeCustomRoles(roles: string[]): Promise<void> {
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "custom-roles.json"), JSON.stringify(roles, null, 2) + "\n");
}

// ── Admin API support ────────────────────────────────────────────

export interface AclSnapshot {
  defaults: { read: string; write: string };
  acl: Record<string, { read?: string; write?: string }>;
  roles: Record<string, string[]>;
  customRoles: string[];
}

export async function getAclSnapshot(): Promise<AclSnapshot> {
  const cache = await loadCache();
  return {
    defaults: {
      read: cache.defaults.read ?? "authenticated",
      write: cache.defaults.write ?? "authenticated",
    },
    acl: { ...cache.acl },
    roles: { ...cache.roles },
    customRoles: [...cache.customRoles],
  };
}

export async function updateDefaults(defaults: { read?: string; write?: string }): Promise<void> {
  const cache = await loadCache();
  if (defaults.read !== undefined) cache.defaults.read = defaults.read;
  if (defaults.write !== undefined) cache.defaults.write = defaults.write;
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "defaults.json"), JSON.stringify(cache.defaults, null, 2) + "\n");
  invalidateCache();
}

export async function setDocAcl(docPath: string, perms: { read?: string; write?: string }): Promise<void> {
  const cache = await loadCache();
  cache.acl[docPath] = { ...cache.acl[docPath], ...perms };
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "acl.json"), JSON.stringify(cache.acl, null, 2) + "\n");
  invalidateCache();
}

export async function removeDocAcl(docPath: string): Promise<void> {
  const cache = await loadCache();
  delete cache.acl[docPath];
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "acl.json"), JSON.stringify(cache.acl, null, 2) + "\n");
  invalidateCache();
}

export async function setUserRoles(userId: string, roles: string[]): Promise<void> {
  const cache = await loadCache();
  cache.roles[userId] = roles;
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "roles.json"), JSON.stringify(cache.roles, null, 2) + "\n");
  invalidateCache();
}

export async function removeUserRoles(userId: string): Promise<void> {
  const cache = await loadCache();
  delete cache.roles[userId];
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "roles.json"), JSON.stringify(cache.roles, null, 2) + "\n");
  invalidateCache();
}
