import { useCallback, useEffect, useState, type FormEvent } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";
import type { AgentAuthPolicy } from "../types/shared";
import { copyTextToClipboard } from "../utils/copy-text";

interface AgentEntry {
  agent_id: string;
  display_name: string;
}

function AgentAuthStatus({ policy }: { policy: AgentAuthPolicy }) {
  const anonEnabled = policy === "open" || policy === "approve";
  const preAuthEnabled = true; // pre-auth agents work in all modes
  const secretRequired = policy === "confidential";

  return (
    <div className="border border-card-border rounded-lg bg-canvas-bg px-4 py-3 mb-4">
      <div className="flex flex-wrap gap-6">
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${anonEnabled ? "bg-status-green" : "bg-text-faint"}`} />
          <span className={`text-[13px] ${anonEnabled ? "text-status-green" : "text-text-muted"}`}>
            Anonymous agents {anonEnabled ? "enabled" : "disabled"}
            {policy === "approve" ? " (human approves first connection)" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-block w-2 h-2 rounded-full ${preAuthEnabled ? "bg-status-green" : "bg-text-faint"}`} />
          <span className={`text-[13px] ${preAuthEnabled ? "text-status-green" : "text-text-muted"}`}>
            Pre-authenticated agents {preAuthEnabled ? "enabled" : "disabled"}
            {secretRequired ? " (secret required)" : ""}
          </span>
        </div>
      </div>
      <div className="text-[12px] text-text-muted mt-1.5">
        Policy: <strong className="text-text-primary">{policy}</strong> — configured via <code className="font-mono">KS_AGENT_AUTH_POLICY</code>
      </div>
      <div className="text-[12px] text-text-muted mt-0.5">
        Anonymous agent identities are signed with an HMAC salt (<code className="font-mono">KS_AGENT_ANON_SALT</code>).
        Auto-generated if unset; anonymous agents will not survive a restart unless this is set explicitly.
      </div>
    </div>
  );
}

export function AgentKeysPage() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [newSecret, setNewSecret] = useState<{ agentId: string; secret: string; kind: "created" | "rotated" } | null>(null);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [authPolicy, setAuthPolicy] = useState<AgentAuthPolicy | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, config] = await Promise.all([
        apiClient.listAgentKeys(),
        apiClient.getAdminConfig(),
      ]);
      setAgents(data.agents);
      setParseErrors(data.errors);
      setAuthPolicy(config.agent_auth_policy);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      const result = await apiClient.addAgentKey(name);
      setNewSecret({ agentId: result.agent_id, secret: result.secret ?? "", kind: "created" });
      setNewName("");
      setCopied(false);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (agentId: string) => {
    setError(null);
    try {
      await apiClient.deleteAgentKey(agentId);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleRotate = async (agentId: string) => {
    const ok = window.confirm(
      `Rotate secret for agent "${agentId}"?\n\n` +
      "The agent's currently-cached access token will keep working until expiry, " +
      "but its next refresh will fail — the agent must be reconfigured with the new secret.",
    );
    if (!ok) return;
    setError(null);
    try {
      const result = await apiClient.rotateAgentSecret(agentId);
      setNewSecret({ agentId: result.agent_id, secret: result.secret, kind: "rotated" });
      setCopied(false);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDeleteSelected = async () => {
    for (const id of selected) {
      await handleDelete(id);
    }
  };

  const toggleSelect = (agentId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === agents.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(agents.map((a) => a.agent_id)));
    }
  };

  const copySecret = async () => {
    if (!newSecret) return;
    const didCopy = await copyTextToClipboard(newSecret.secret);
    if (!didCopy) return;
    setCopied(true);
  };

  return (
    <div className="flex flex-col">
      <SharedPageHeader title="Pre-Authenticated Agents" backTo="/admin" />

      <section className="max-w-[700px] mx-auto p-4 font-ui w-full">
        {authPolicy && <AgentAuthStatus policy={authPolicy} />}

        {error && (
          <div className="mb-4 p-3 bg-status-red-light border border-status-red/25 text-status-red rounded text-[13px]">
            {error}
          </div>
        )}

        {parseErrors.length > 0 && (
          <div className="mb-4 p-3 bg-status-yellow-light border border-status-yellow/30 text-status-yellow rounded">
            <strong>Warning: {parseErrors.length} malformed {parseErrors.length === 1 ? "entry" : "entries"} in agents.keys</strong>
            <ul className="mt-2 mb-0 pl-5">
              {parseErrors.map((err, i) => (
                <li key={i} className="text-[13px] mb-0.5">{err}</li>
              ))}
            </ul>
          </div>
        )}

        {newSecret && (
          <div className="mb-4 p-4 bg-status-green-light border border-status-green/30 rounded-lg">
            <strong className="text-status-green">
              {newSecret.kind === "rotated"
                ? `Secret rotated for: ${newSecret.agentId}`
                : `New agent created: ${newSecret.agentId}`}
            </strong>
            <p className="my-2 text-[13px] text-text-primary">
              Copy the secret below. It will not be shown again.
            </p>
            <code className="block bg-canvas-bg border border-card-border p-2 rounded break-all text-[13px] font-mono text-text-primary">
              {newSecret.secret}
            </code>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void copySecret()} className="btn-primary">
                {copied ? "Copied" : "Copy Secret"}
              </button>
              <button type="button" onClick={() => setNewSecret(null)} className="btn-secondary">
                Dismiss
              </button>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleAdd(e)} className="flex gap-2 mb-6">
          <input
            type="text"
            placeholder="Agent display name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="input-field flex-1"
          />
          <button type="submit" disabled={adding || !newName.trim()} className="btn-primary disabled:opacity-50">
            {adding ? "Adding..." : "Add Agent"}
          </button>
        </form>

        {loading ? (
          <p className="text-xs text-text-muted">Loading...</p>
        ) : agents.length === 0 ? (
          <p className="text-xs text-text-muted">No pre-authenticated agents configured.</p>
        ) : (
          <>
            <div className="flex justify-between items-center mb-2">
              <label className="cursor-pointer text-[13px] text-text-primary">
                <input type="checkbox" checked={selected.size === agents.length} onChange={toggleAll} />{" "}
                Select all ({agents.length})
              </label>
              {selected.size > 0 && (
                <button type="button" onClick={() => void handleDeleteSelected()} className="btn-danger">
                  Delete {selected.size} selected
                </button>
              )}
            </div>
            <div className="border border-card-border rounded-lg overflow-hidden bg-canvas-bg">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="bg-section-hover border-b border-footer-border">
                    <th className="px-3 py-2"></th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Agent ID</th>
                    <th className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Display Name</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((agent) => (
                    <tr key={agent.agent_id} className="border-b border-footer-border last:border-0">
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected.has(agent.agent_id)}
                          onChange={() => toggleSelect(agent.agent_id)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-[12px] text-text-primary">
                        {agent.agent_id}
                      </td>
                      <td className="px-3 py-2 text-text-primary">{agent.display_name}</td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1.5 justify-end">
                          <button
                            type="button"
                            onClick={() => void handleRotate(agent.agent_id)}
                            className="btn-small"
                          >
                            Rotate secret
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(agent.agent_id)}
                            className="btn-danger"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
