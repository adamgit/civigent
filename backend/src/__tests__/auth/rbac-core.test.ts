import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  checkDocPermission,
  getDocReadPermission,
  getDocWritePermission,
  listCustomRoles,
  addCustomRole,
  deleteCustomRole,
  invalidateCache,
} from "../../auth/acl.js";
import type { AuthenticatedWriter } from "../../auth/context.js";

describe("RBAC Core — role-based permission check", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  function saveEnv(...keys: string[]) {
    for (const k of keys) savedEnv[k] = process.env[k];
  }

  function setEnv(vars: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(vars)) {
      saveEnv(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  async function writeAuthFile(name: string, data: unknown) {
    const authDir = path.join(tmpDir, "auth");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, name), JSON.stringify(data, null, 2));
  }

  function makeWriter(id: string, type: "human" | "agent" = "human"): AuthenticatedWriter {
    return { id, type, displayName: `User ${id}` };
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "rbac-test-"));
    setEnv({
      KS_DATA_ROOT: tmpDir,
      KS_AUTH_MODE: "oidc",
    });
    invalidateCache();
  });

  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    invalidateCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── checkDocPermission ────────────────────────────────────────────

  describe("checkDocPermission", () => {
    it("'public' role allows unauthenticated access", async () => {
      await writeAuthFile("defaults.json", { read: "public" });
      invalidateCache();

      const allowed = await checkDocPermission(null, "any-doc", "read");
      expect(allowed).toBe(true);
    });

    it("'authenticated' role requires authentication", async () => {
      await writeAuthFile("defaults.json", { read: "authenticated" });
      invalidateCache();

      const denied = await checkDocPermission(null, "any-doc", "read");
      expect(denied).toBe(false);

      const allowed = await checkDocPermission(makeWriter("user-1"), "any-doc", "read");
      expect(allowed).toBe(true);
    });

    it("'admin' role requires admin", async () => {
      await writeAuthFile("defaults.json", { read: "admin" });
      await writeAuthFile("roles.json", { "admin-user": ["admin"] });
      invalidateCache();

      const deniedNonAdmin = await checkDocPermission(makeWriter("normal-user"), "doc", "read");
      expect(deniedNonAdmin).toBe(false);

      const allowed = await checkDocPermission(makeWriter("admin-user"), "doc", "read");
      expect(allowed).toBe(true);
    });

    it("custom role requires user to have that role assigned", async () => {
      await writeAuthFile("acl.json", { "secret/legal": { read: "legal-team" } });
      await writeAuthFile("roles.json", {
        "legal-user": ["legal-team"],
        "other-user": ["marketing"],
      });
      invalidateCache();

      const allowed = await checkDocPermission(makeWriter("legal-user"), "secret/legal", "read");
      expect(allowed).toBe(true);

      const denied = await checkDocPermission(makeWriter("other-user"), "secret/legal", "read");
      expect(denied).toBe(false);
    });

    it("admin always has admin role from roles.json", async () => {
      await writeAuthFile("acl.json", { "admin-doc": { write: "admin" } });
      await writeAuthFile("roles.json", { "admin-user": ["admin"] });
      invalidateCache();

      const allowed = await checkDocPermission(makeWriter("admin-user"), "admin-doc", "write");
      expect(allowed).toBe(true);
    });

    it("unauthenticated user only has 'public' role", async () => {
      await writeAuthFile("defaults.json", { read: "authenticated" });
      invalidateCache();

      const denied = await checkDocPermission(null, "doc", "read");
      expect(denied).toBe(false);
    });
  });

  // ── getDocWritePermission ─────────────────────────────────────────

  describe("getDocWritePermission", () => {
    it("resolves exact match from acl.json", async () => {
      await writeAuthFile("acl.json", { "my-doc": { write: "admin" } });
      invalidateCache();

      expect(await getDocWritePermission("my-doc")).toBe("admin");
    });

    it("resolves prefix match from acl.json", async () => {
      await writeAuthFile("acl.json", { "legal": { write: "legal-team" } });
      invalidateCache();

      expect(await getDocWritePermission("legal/contract-1")).toBe("legal-team");
    });

    it("falls back to defaults.json", async () => {
      await writeAuthFile("defaults.json", { write: "authenticated" });
      invalidateCache();

      expect(await getDocWritePermission("any-doc")).toBe("authenticated");
    });

    it("defaults to 'authenticated' when no files exist", async () => {
      invalidateCache();
      expect(await getDocWritePermission("any-doc")).toBe("authenticated");
    });

    it("exact match takes precedence over prefix", async () => {
      await writeAuthFile("acl.json", {
        "legal": { write: "legal-team" },
        "legal/public-doc": { write: "authenticated" },
      });
      invalidateCache();

      expect(await getDocWritePermission("legal/public-doc")).toBe("authenticated");
      expect(await getDocWritePermission("legal/other-doc")).toBe("legal-team");
    });
  });

  // ── getDocReadPermission (existing, verify still works) ───────────

  describe("getDocReadPermission", () => {
    it("resolves exact → prefix → defaults", async () => {
      await writeAuthFile("acl.json", { "secret": { read: "admin" } });
      await writeAuthFile("defaults.json", { read: "authenticated" });
      invalidateCache();

      expect(await getDocReadPermission("secret/doc1")).toBe("admin");
      expect(await getDocReadPermission("public-doc")).toBe("authenticated");
    });
  });

  // ── Custom roles CRUD ─────────────────────────────────────────────

  describe("custom roles", () => {
    it("create, list, and delete custom roles", async () => {
      invalidateCache();

      await addCustomRole("legal-team");
      expect(await listCustomRoles()).toEqual(["legal-team"]);

      await addCustomRole("board-members");
      expect(await listCustomRoles()).toEqual(["legal-team", "board-members"]);

      await deleteCustomRole("legal-team");
      expect(await listCustomRoles()).toEqual(["board-members"]);
    });

    it("rejects creating magic roles", async () => {
      await expect(addCustomRole("public")).rejects.toThrow(/magic role/);
      await expect(addCustomRole("authenticated")).rejects.toThrow(/magic role/);
      await expect(addCustomRole("admin")).rejects.toThrow(/magic role/);
    });

    it("rejects deleting magic roles", async () => {
      await expect(deleteCustomRole("public")).rejects.toThrow(/magic role/);
      await expect(deleteCustomRole("authenticated")).rejects.toThrow(/magic role/);
      await expect(deleteCustomRole("admin")).rejects.toThrow(/magic role/);
    });

    it("rejects creating duplicate role", async () => {
      await addCustomRole("legal-team");
      await expect(addCustomRole("legal-team")).rejects.toThrow(/already exists/);
    });

    it("rejects deleting nonexistent role", async () => {
      await expect(deleteCustomRole("nonexistent")).rejects.toThrow(/does not exist/);
    });
  });
});
