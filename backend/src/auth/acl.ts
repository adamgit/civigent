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
import { getExportedSkillsConfig } from "../exported-skills-config.js";
import {
  AclAction,
  AclPermissionSet,
  BuiltinRoleName,
  RoleName,
  type AclSnapshot,
} from "../types/shared.js";

export type { AclSnapshot } from "../types/shared.js";

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
export async function getDocReadPermission(docPath: string): Promise<RoleName> {
  return RoleName.of(await resolveDocPermissionRaw(docPath, "read"));
}

/**
 * Returns the effective write permission for a given docPath.
 *
 * Resolution order:
 *   1. Exact match in acl.json
 *   2. Longest-prefix folder match in acl.json
 *   3. defaults.json "write" value (fallback: "authenticated")
 */
export async function getDocWritePermission(docPath: string): Promise<RoleName> {
  return RoleName.of(await resolveDocPermissionRaw(docPath, "write"));
}

/**
 * Resolve the effective required role for `(docPath, action)` as a raw persisted
 * string. Internal to this module: the hot permission path compares raw strings;
 * public getters mint the result into a `RoleName` at the boundary.
 */
async function resolveDocPermissionRaw(docPath: string, action: AclAction): Promise<string> {
  if (action === "read") {
    const folder = getExportedSkillsConfig().folder;
    if (docPath === folder || docPath.startsWith(`${folder}/`)) {
      return "public";
    }
  }

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
  action: AclAction,
): Promise<boolean> {
  const requiredRole = await resolveDocPermissionRaw(docPath, action);
  const effectiveRoles = await getEffectiveRoles(writer);
  return effectiveRoles.includes(requiredRole);
}

/**
 * Compute the effective roles for a writer as raw persisted strings.
 * Always includes the builtin "public" role. Authenticated writers also get
 * "authenticated" plus any roles from roles.json (including "admin" if present).
 * Internal to the hot permission path; not exposed as `RoleName[]`.
 */
async function getEffectiveRoles(writer: AuthenticatedWriter | null): Promise<string[]> {
  const [PUBLIC, AUTHENTICATED, ADMIN] = BuiltinRoleName.values;
  const roles: string[] = [PUBLIC];

  if (!writer) return roles;

  roles.push(AUTHENTICATED);

  // In single_user mode, the configured user is always admin
  if (isSingleUserMode() && writer.id === getSingleUserId()) {
    roles.push(ADMIN);
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

export async function listCustomRoles(): Promise<RoleName[]> {
  const cache = await loadCache();
  return cache.customRoles.map((role) => RoleName.of(role));
}

export async function addCustomRole(name: RoleName): Promise<void> {
  const raw = RoleName.text(name);
  if (BuiltinRoleName.is(raw)) {
    throw new Error(`Cannot create magic role "${raw}" — it is auto-granted by the system.`);
  }
  const cache = await loadCache();
  if (cache.customRoles.includes(raw)) {
    throw new Error(`Custom role "${raw}" already exists.`);
  }
  cache.customRoles.push(raw);
  await writeCustomRoles(cache.customRoles);
  invalidateCache();
}

export async function deleteCustomRole(name: RoleName): Promise<void> {
  const raw = RoleName.text(name);
  if (BuiltinRoleName.is(raw)) {
    throw new Error(`Cannot delete magic role "${raw}" — it is auto-granted by the system.`);
  }
  const cache = await loadCache();
  const idx = cache.customRoles.indexOf(raw);
  if (idx === -1) {
    throw new Error(`Custom role "${raw}" does not exist.`);
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
//
// `AclSnapshot` is the shared API contract (re-exported at the top of this file).
// On-disk persistence stays as plain JSON strings; these functions mint/widen
// `RoleName` at the domain boundary only.

export async function getAclSnapshot(): Promise<AclSnapshot> {
  const cache = await loadCache();
  const [, AUTHENTICATED] = BuiltinRoleName.values;
  const acl: Record<string, AclPermissionSet> = {};
  for (const [docPath, perms] of Object.entries(cache.acl)) {
    const entry: AclPermissionSet = {};
    if (perms.read !== undefined) entry.read = RoleName.of(perms.read);
    if (perms.write !== undefined) entry.write = RoleName.of(perms.write);
    acl[docPath] = entry;
  }
  const roles: Record<string, RoleName[]> = {};
  for (const [userId, assigned] of Object.entries(cache.roles)) {
    roles[userId] = assigned.map((role) => RoleName.of(role));
  }
  return {
    defaults: {
      read: RoleName.of(cache.defaults.read ?? AUTHENTICATED),
      write: RoleName.of(cache.defaults.write ?? AUTHENTICATED),
    },
    acl,
    roles,
    customRoles: cache.customRoles.map((role) => RoleName.of(role)),
  };
}

export async function updateDefaults(defaults: AclPermissionSet): Promise<void> {
  const cache = await loadCache();
  if (defaults.read !== undefined) cache.defaults.read = RoleName.text(defaults.read);
  if (defaults.write !== undefined) cache.defaults.write = RoleName.text(defaults.write);
  const authDir = getAuthRoot();
  await mkdir(authDir, { recursive: true });
  await writeFile(path.join(authDir, "defaults.json"), JSON.stringify(cache.defaults, null, 2) + "\n");
  invalidateCache();
}

export async function setDocAcl(docPath: string, perms: AclPermissionSet): Promise<void> {
  const cache = await loadCache();
  const next: { read?: string; write?: string } = { ...cache.acl[docPath] };
  if (perms.read !== undefined) next.read = RoleName.text(perms.read);
  if (perms.write !== undefined) next.write = RoleName.text(perms.write);
  cache.acl[docPath] = next;
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

export async function setUserRoles(userId: string, roles: RoleName[]): Promise<void> {
  const cache = await loadCache();
  cache.roles[userId] = roles.map((role) => RoleName.text(role));
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
