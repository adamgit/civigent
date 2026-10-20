import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient, type LocalUserAccount } from "../services/api-client";
import type { AuthMethod } from "../types/shared";

export function LocalUsersPage() {
  const [methods, setMethods] = useState<AuthMethod[] | null>(null);
  const [accounts, setAccounts] = useState<LocalUserAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editUsername, setEditUsername] = useState("");
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPassword, setEditPassword] = useState("");

  const localUsersMode = methods !== null && methods.some((m) => m.type === "local_users");

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getAuthMethods()
      .then((response) => {
        if (!cancelled) setMethods(Array.isArray(response.methods) ? response.methods as AuthMethod[] : []);
      })
      .catch(() => {
        if (!cancelled) setMethods([]);
      });
    return () => { cancelled = true; };
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setAccounts(await apiClient.listLocalUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (localUsersMode) void reload();
  }, [localUsersMode, reload]);

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const username = newUsername.trim();
    const displayName = newDisplayName.trim() || username;
    if (!username || !newPassword) return;
    setWorking(true);
    setError(null);
    try {
      await apiClient.addLocalUser({ username, displayName, password: newPassword });
      setNewUsername("");
      setNewDisplayName("");
      setNewPassword("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const startEditing = (account: LocalUserAccount) => {
    setEditingId(account.id);
    setEditUsername(account.username);
    setEditDisplayName(account.displayName);
    setEditPassword("");
    setError(null);
  };

  const handleSaveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (editingId === null) return;
    const current = accounts?.find((candidate) => candidate.id === editingId);
    if (!current) return;
    const username = editUsername.trim();
    const displayName = editDisplayName.trim();
    setWorking(true);
    setError(null);
    try {
      await apiClient.updateLocalUser(editingId, {
        ...(username && username !== current.username ? { username } : {}),
        ...(displayName && displayName !== current.displayName ? { displayName } : {}),
        ...(editPassword ? { password: editPassword } : {}),
      });
      setEditingId(null);
      setEditPassword("");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const handleDelete = async (account: LocalUserAccount) => {
    const ok = window.confirm(
      `Delete the account "${account.username}"?\n\n` +
      "Their current access token stays valid until it expires, and their next refresh fails.",
    );
    if (!ok) return;
    setWorking(true);
    setError(null);
    try {
      await apiClient.deleteLocalUser(account.id);
      if (editingId === account.id) setEditingId(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Accounts" backTo="/admin" />
      <div className="p-4 font-ui max-w-[900px]">
        {methods === null ? (
          <p className="text-text-muted text-[13px]">Loading...</p>
        ) : !localUsersMode ? (
          <p className="text-text-muted text-[13px]" data-testid="local-users-wrong-mode">
            This server is not running <code className="font-mono">KS_AUTH_MODE=local_users</code>, so there are no
            local accounts to manage.
          </p>
        ) : (
          <>
            <p className="text-text-muted text-[13px] mb-2">
              Every username and password account in{" "}
              <code className="font-mono">auth/local-users.json</code> under the data directory. That file remains the
              store; this page writes to it. These are ordinary accounts — this install's admin is the env-configured
              identity, which is separate from every account listed here.
            </p>
            <p className="text-text-muted text-[13px] mb-4">
              Deleting an account leaves that person's current access token valid until it expires, and their next
              refresh fails. Setting a password does not end their current sessions either.
            </p>

            {error && (
              <div
                data-testid="local-users-error"
                className="mb-4 p-3 bg-status-red-light border border-status-red/25 text-status-red rounded text-[13px]"
              >
                {error}
              </div>
            )}

            <form
              data-testid="local-users-add-form"
              onSubmit={(event) => void handleAdd(event)}
              className="border border-card-border rounded-lg bg-canvas-bg px-4 py-3 mb-4"
            >
              <div className="text-[13px] font-semibold text-text-primary mb-2">Add an account</div>
              <div className="flex flex-wrap gap-2 items-center">
                <input
                  data-testid="local-users-new-username"
                  value={newUsername}
                  onChange={(event) => setNewUsername(event.target.value)}
                  placeholder="Username"
                  className="border border-card-border rounded px-2 py-1 text-[13px]"
                />
                <input
                  data-testid="local-users-new-display-name"
                  value={newDisplayName}
                  onChange={(event) => setNewDisplayName(event.target.value)}
                  placeholder="Display name"
                  className="border border-card-border rounded px-2 py-1 text-[13px]"
                />
                <input
                  data-testid="local-users-new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Password"
                  className="border border-card-border rounded px-2 py-1 text-[13px]"
                />
                <button data-testid="local-users-add" type="submit" disabled={working} className="btn-secondary">
                  Add
                </button>
              </div>
            </form>

            {accounts === null ? (
              <p className="text-text-muted text-[13px]">Loading accounts...</p>
            ) : (
              <div className="border border-card-border rounded-lg overflow-hidden bg-canvas-bg">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="bg-section-hover border-b border-footer-border">
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Username</th>
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Display name</th>
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Id</th>
                      <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted" />
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => (
                      <tr key={account.id} data-testid={`local-user-row-${account.id}`} className="border-b border-footer-border last:border-0">
                        <td className="px-3 py-2 text-text-primary">{account.username}</td>
                        <td className="px-3 py-2 text-text-primary">{account.displayName}</td>
                        <td className="px-3 py-2 font-mono text-[12px] text-text-muted">{account.id}</td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button
                            data-testid={`local-user-edit-${account.id}`}
                            onClick={() => startEditing(account)}
                            disabled={working}
                            className="btn-secondary mr-2"
                          >
                            Edit
                          </button>
                          <button
                            data-testid={`local-user-delete-${account.id}`}
                            onClick={() => void handleDelete(account)}
                            disabled={working}
                            className="btn-secondary"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {editingId !== null && (
              <form
                data-testid="local-users-edit-form"
                onSubmit={(event) => void handleSaveEdit(event)}
                className="border border-card-border rounded-lg bg-canvas-bg px-4 py-3 mt-4"
              >
                <div className="text-[13px] font-semibold text-text-primary mb-2">
                  Edit account <span className="font-mono text-[12px] text-text-muted">{editingId}</span>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <input
                    data-testid="local-users-edit-username"
                    value={editUsername}
                    onChange={(event) => setEditUsername(event.target.value)}
                    placeholder="Username"
                    className="border border-card-border rounded px-2 py-1 text-[13px]"
                  />
                  <input
                    data-testid="local-users-edit-display-name"
                    value={editDisplayName}
                    onChange={(event) => setEditDisplayName(event.target.value)}
                    placeholder="Display name"
                    className="border border-card-border rounded px-2 py-1 text-[13px]"
                  />
                  <input
                    data-testid="local-users-edit-password"
                    value={editPassword}
                    onChange={(event) => setEditPassword(event.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="New password (leave blank to keep)"
                    className="border border-card-border rounded px-2 py-1 text-[13px]"
                  />
                  <button data-testid="local-users-save" type="submit" disabled={working} className="btn-secondary">
                    Save
                  </button>
                  <button
                    data-testid="local-users-cancel-edit"
                    type="button"
                    onClick={() => setEditingId(null)}
                    disabled={working}
                    className="btn-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
