import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, type AclSnapshot } from "../services/api-client";
import { DocPath } from "../types/shared";
import {
  RoleName,
  BuiltinRoleName,
  type SetAclDefaultsRequest,
  type SetDocumentAclRequest,
} from "../types/shared";

const MAGIC_ROLES: string[] = [...BuiltinRoleName.values];

export function PermissionsPage() {
  const [snapshot, setSnapshot] = useState<AclSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newDocPath, setNewDocPath] = useState("");
  const [newDocRead, setNewDocRead] = useState("");
  const [newDocWrite, setNewDocWrite] = useState("");
  const [newUserId, setNewUserId] = useState("");
  const [newUserRoles, setNewUserRoles] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getAcl();
      setSnapshot(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const allRoles = [...MAGIC_ROLES, ...(snapshot?.customRoles ?? [])];

  const handleUpdateDefaults = async (field: "read" | "write", value: string) => {
    setSaving(true);
    try {
      const request: SetAclDefaultsRequest =
        field === "read"
          ? { read: RoleName.of(value) }
          : { write: RoleName.of(value) };
      await apiClient.updateAclDefaults(request);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateRole = async (e: FormEvent) => {
    e.preventDefault();
    const name = newRoleName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await apiClient.createCustomRole({ name: RoleName.of(name) });
      setNewRoleName("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRole = async (name: string) => {
    setSaving(true);
    try {
      await apiClient.deleteCustomRole(name);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleAddDocOverride = async (e: FormEvent) => {
    e.preventDefault();
    const raw = newDocPath.trim();
    if (!raw) return;
    const docPath = DocPath.tryParse(raw);
    if (!docPath) {
      setError(`Invalid document path: ${JSON.stringify(raw)}`);
      return;
    }
    const perms: SetDocumentAclRequest = {};
    if (newDocRead) perms.read = RoleName.of(newDocRead);
    if (newDocWrite) perms.write = RoleName.of(newDocWrite);
    if (!perms.read && !perms.write) return;
    setSaving(true);
    try {
      await apiClient.setDocAcl(docPath, perms);
      setNewDocPath("");
      setNewDocRead("");
      setNewDocWrite("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveDocOverride = async (aclKey: string) => {
    const docPath = DocPath.parse(aclKey);
    setSaving(true);
    try {
      await apiClient.removeDocAcl(docPath);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleSetUserRoles = async (e: FormEvent) => {
    e.preventDefault();
    const userId = newUserId.trim();
    if (!userId) return;
    const roles = newUserRoles
      .split(",")
      .map(r => r.trim())
      .filter(Boolean)
      .map(r => RoleName.of(r));
    setSaving(true);
    try {
      await apiClient.setUserRoles(userId, { roles });
      setNewUserId("");
      setNewUserRoles("");
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveUser = async (userId: string) => {
    setSaving(true);
    try {
      await apiClient.removeUserRoles(userId);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col">
        <SharedPageHeader title="Permissions" backTo="/admin" />
        <div className="p-8 font-ui text-[13px] text-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Permissions" backTo="/admin" />
      <div className="p-4 font-ui max-w-[900px]">

        {error && (
          <div className="mb-4 p-3 bg-status-red-light border border-status-red/25 text-status-red rounded text-[13px]">
            {error}
          </div>
        )}

        <section className="mb-8">
          <h2 className="text-[15px] font-semibold text-text-primary m-0 mb-1">Roles</h2>
          <p className="text-text-muted text-[13px] mb-3">
            Magic roles (<strong className="text-text-primary">public</strong>, <strong className="text-text-primary">authenticated</strong>, <strong className="text-text-primary">admin</strong>) are auto-granted and cannot be edited.
          </p>
          <div className="flex gap-2 flex-wrap mb-3">
            {MAGIC_ROLES.map(r => (
              <span key={r} className="bg-accent-light text-accent-text px-3 py-1 rounded-full text-[13px]">{r}</span>
            ))}
            {(snapshot?.customRoles ?? []).map(r => (
              <span key={r} className="bg-status-green-light text-status-green px-3 py-1 rounded-full text-[13px] inline-flex items-center gap-1">
                {r}
                <button
                  type="button"
                  onClick={() => void handleDeleteRole(r)}
                  disabled={saving}
                  className="bg-transparent border-none cursor-pointer text-status-red font-bold text-[14px] leading-none disabled:opacity-50"
                >
                  x
                </button>
              </span>
            ))}
          </div>
          <form onSubmit={(e) => void handleCreateRole(e)} className="flex gap-2">
            <input
              value={newRoleName}
              onChange={e => setNewRoleName(e.target.value)}
              placeholder="New role name"
              className="input-field"
            />
            <button type="submit" disabled={saving || !newRoleName.trim()} className="btn-primary disabled:opacity-50">
              Create
            </button>
          </form>
        </section>

        <section className="mb-8">
          <h2 className="text-[15px] font-semibold text-text-primary m-0 mb-1">Default Permissions</h2>
          <p className="text-text-muted text-[13px] mb-3">Applied when no document-specific override exists.</p>
          <div className="flex gap-8">
            <label className="text-[13px] text-text-primary">
              Read:
              <select
                value={snapshot?.defaults.read ?? "authenticated"}
                onChange={e => void handleUpdateDefaults("read", e.target.value)}
                disabled={saving}
                className="input-field ml-2"
              >
                {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="text-[13px] text-text-primary">
              Write:
              <select
                value={snapshot?.defaults.write ?? "authenticated"}
                onChange={e => void handleUpdateDefaults("write", e.target.value)}
                disabled={saving}
                className="input-field ml-2"
              >
                {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-[15px] font-semibold text-text-primary m-0 mb-3">Document Overrides</h2>
          <div className="border border-card-border rounded-lg overflow-hidden bg-canvas-bg mb-3">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-section-hover border-b border-footer-border">
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Document Path</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Read</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Write</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(snapshot?.acl ?? {}).map(([path, perms]) => (
                  <tr key={path} className="border-b border-footer-border last:border-0">
                    <td className="px-3 py-2 font-mono text-[12px] text-text-primary">{path}</td>
                    <td className="px-3 py-2 text-text-primary">{perms.read ?? "-"}</td>
                    <td className="px-3 py-2 text-text-primary">{perms.write ?? "-"}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void handleRemoveDocOverride(path)}
                        disabled={saving}
                        className="btn-danger disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form onSubmit={(e) => void handleAddDocOverride(e)} className="flex gap-2 flex-wrap">
            <input
              value={newDocPath}
              onChange={e => setNewDocPath(e.target.value)}
              placeholder="Document path"
              className="input-field flex-1 min-w-[200px]"
            />
            <select value={newDocRead} onChange={e => setNewDocRead(e.target.value)} className="input-field">
              <option value="">Read: (default)</option>
              {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <select value={newDocWrite} onChange={e => setNewDocWrite(e.target.value)} className="input-field">
              <option value="">Write: (default)</option>
              {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="submit" disabled={saving || !newDocPath.trim()} className="btn-primary disabled:opacity-50">
              Add
            </button>
          </form>
        </section>

        <section className="mb-8">
          <h2 className="text-[15px] font-semibold text-text-primary m-0 mb-3">User Roles</h2>
          <div className="border border-card-border rounded-lg overflow-hidden bg-canvas-bg mb-3">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-section-hover border-b border-footer-border">
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">User ID</th>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Roles</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(snapshot?.roles ?? {}).map(([userId, roles]) => (
                  <tr key={userId} className="border-b border-footer-border last:border-0">
                    <td className="px-3 py-2 font-mono text-[12px] text-text-primary">{userId}</td>
                    <td className="px-3 py-2 text-text-primary">{roles.join(", ")}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void handleRemoveUser(userId)}
                        disabled={saving}
                        className="btn-danger disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form onSubmit={(e) => void handleSetUserRoles(e)} className="flex gap-2 flex-wrap">
            <input
              value={newUserId}
              onChange={e => setNewUserId(e.target.value)}
              placeholder="User ID"
              className="input-field min-w-[200px]"
            />
            <input
              value={newUserRoles}
              onChange={e => setNewUserRoles(e.target.value)}
              placeholder="Roles (comma-separated)"
              className="input-field flex-1 min-w-[200px]"
            />
            <button type="submit" disabled={saving || !newUserId.trim()} className="btn-primary disabled:opacity-50">
              Set
            </button>
          </form>
        </section>
      </div>
    </div>
  );
}
