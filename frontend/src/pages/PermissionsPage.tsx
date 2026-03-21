import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, type AclSnapshot } from "../services/api-client";

const MAGIC_ROLES = ["public", "authenticated", "admin"];

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
      await apiClient.updateAclDefaults({ [field]: value });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateRole = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newRoleName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await apiClient.createCustomRole(name);
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

  const handleAddDocOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    const docPath = newDocPath.trim();
    if (!docPath) return;
    const perms: { read?: string; write?: string } = {};
    if (newDocRead) perms.read = newDocRead;
    if (newDocWrite) perms.write = newDocWrite;
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

  const handleRemoveDocOverride = async (docPath: string) => {
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

  const handleSetUserRoles = async (e: React.FormEvent) => {
    e.preventDefault();
    const userId = newUserId.trim();
    if (!userId) return;
    const roles = newUserRoles.split(",").map(r => r.trim()).filter(Boolean);
    setSaving(true);
    try {
      await apiClient.setUserRoles(userId, roles);
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

  if (loading) return <div style={{ padding: "2rem" }}>Loading...</div>;

  return (
    <div style={{ padding: "1rem 2rem", maxWidth: 900 }}>
      <SharedPageHeader title="Permissions" />

      {error && (
        <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", borderRadius: 6, padding: "0.75rem 1rem", marginBottom: "1rem", color: "#991b1b" }}>
          {error}
        </div>
      )}

      {/* ── Roles ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Roles</h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>
          Magic roles (<strong>public</strong>, <strong>authenticated</strong>, <strong>admin</strong>) are auto-granted and cannot be edited.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          {MAGIC_ROLES.map(r => (
            <span key={r} style={{ background: "#e0e7ff", padding: "0.25rem 0.75rem", borderRadius: 12, fontSize: "0.85rem" }}>{r}</span>
          ))}
          {(snapshot?.customRoles ?? []).map(r => (
            <span key={r} style={{ background: "#d1fae5", padding: "0.25rem 0.75rem", borderRadius: 12, fontSize: "0.85rem", display: "inline-flex", alignItems: "center", gap: 4 }}>
              {r}
              <button onClick={() => handleDeleteRole(r)} disabled={saving} style={{ background: "none", border: "none", cursor: "pointer", color: "#991b1b", fontWeight: "bold", fontSize: "0.9rem" }}>x</button>
            </span>
          ))}
        </div>
        <form onSubmit={handleCreateRole} style={{ display: "flex", gap: "0.5rem" }}>
          <input value={newRoleName} onChange={e => setNewRoleName(e.target.value)} placeholder="New role name" style={{ padding: "0.4rem 0.6rem", borderRadius: 4, border: "1px solid #ccc" }} />
          <button type="submit" disabled={saving || !newRoleName.trim()} style={{ padding: "0.4rem 0.8rem" }}>Create</button>
        </form>
      </section>

      {/* ── Defaults ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Default Permissions</h2>
        <p style={{ color: "#666", fontSize: "0.9rem" }}>Applied when no document-specific override exists.</p>
        <div style={{ display: "flex", gap: "2rem" }}>
          <label>
            Read:
            <select value={snapshot?.defaults.read ?? "authenticated"} onChange={e => handleUpdateDefaults("read", e.target.value)} disabled={saving} style={{ marginLeft: "0.5rem" }}>
              {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label>
            Write:
            <select value={snapshot?.defaults.write ?? "authenticated"} onChange={e => handleUpdateDefaults("write", e.target.value)} disabled={saving} style={{ marginLeft: "0.5rem" }}>
              {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
      </section>

      {/* ── Document overrides ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>Document Overrides</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.75rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Document Path</th>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Read</th>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Write</th>
              <th style={{ padding: "0.5rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(snapshot?.acl ?? {}).map(([path, perms]) => (
              <tr key={path} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <td style={{ padding: "0.5rem", fontFamily: "monospace", fontSize: "0.85rem" }}>{path}</td>
                <td style={{ padding: "0.5rem" }}>{perms.read ?? "-"}</td>
                <td style={{ padding: "0.5rem" }}>{perms.write ?? "-"}</td>
                <td style={{ padding: "0.5rem", textAlign: "right" }}>
                  <button onClick={() => handleRemoveDocOverride(path)} disabled={saving} style={{ color: "#991b1b", background: "none", border: "none", cursor: "pointer" }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={handleAddDocOverride} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input value={newDocPath} onChange={e => setNewDocPath(e.target.value)} placeholder="Document path" style={{ padding: "0.4rem 0.6rem", borderRadius: 4, border: "1px solid #ccc", flex: 1, minWidth: 200 }} />
          <select value={newDocRead} onChange={e => setNewDocRead(e.target.value)} style={{ padding: "0.4rem" }}>
            <option value="">Read: (default)</option>
            {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={newDocWrite} onChange={e => setNewDocWrite(e.target.value)} style={{ padding: "0.4rem" }}>
            <option value="">Write: (default)</option>
            {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="submit" disabled={saving || !newDocPath.trim()} style={{ padding: "0.4rem 0.8rem" }}>Add</button>
        </form>
      </section>

      {/* ── User roles ── */}
      <section style={{ marginBottom: "2rem" }}>
        <h2>User Roles</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "0.75rem" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>User ID</th>
              <th style={{ textAlign: "left", padding: "0.5rem" }}>Roles</th>
              <th style={{ padding: "0.5rem" }}></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(snapshot?.roles ?? {}).map(([userId, roles]) => (
              <tr key={userId} style={{ borderBottom: "1px solid #e5e7eb" }}>
                <td style={{ padding: "0.5rem", fontFamily: "monospace", fontSize: "0.85rem" }}>{userId}</td>
                <td style={{ padding: "0.5rem" }}>{roles.join(", ")}</td>
                <td style={{ padding: "0.5rem", textAlign: "right" }}>
                  <button onClick={() => handleRemoveUser(userId)} disabled={saving} style={{ color: "#991b1b", background: "none", border: "none", cursor: "pointer" }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form onSubmit={handleSetUserRoles} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <input value={newUserId} onChange={e => setNewUserId(e.target.value)} placeholder="User ID" style={{ padding: "0.4rem 0.6rem", borderRadius: 4, border: "1px solid #ccc", minWidth: 200 }} />
          <input value={newUserRoles} onChange={e => setNewUserRoles(e.target.value)} placeholder="Roles (comma-separated)" style={{ padding: "0.4rem 0.6rem", borderRadius: 4, border: "1px solid #ccc", flex: 1, minWidth: 200 }} />
          <button type="submit" disabled={saving || !newUserId.trim()} style={{ padding: "0.4rem 0.8rem" }}>Set</button>
        </form>
      </section>
    </div>
  );
}
