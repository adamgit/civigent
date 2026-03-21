import { useCallback, useEffect, useState } from "react";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { apiClient } from "../services/api-client";

interface AgentEntry {
  agent_id: string;
  display_name: string;
}

export function AgentKeysPage() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [newSecret, setNewSecret] = useState<{ agentId: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.listAgentKeys();
      setAgents(data.agents);
      setParseErrors(data.errors);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    try {
      const result = await apiClient.addAgentKey(name);
      setNewSecret({ agentId: result.agent_id, secret: result.secret ?? "" });
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
    await navigator.clipboard.writeText(newSecret.secret);
    setCopied(true);
  };

  return (
    <>
      <SharedPageHeader title="Pre-Authenticated Agents" backTo="/admin" />

      <section style={{ maxWidth: 700, margin: "0 auto", padding: "1rem" }}>
        {error && (
          <div style={{ background: "#ffeaea", color: "#a00", padding: "0.5rem 1rem", borderRadius: 4, marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {parseErrors.length > 0 && (
          <div style={{ background: "#fff3e0", border: "1px solid #ff9800", color: "#e65100", padding: "0.75rem 1rem", borderRadius: 4, marginBottom: "1rem" }}>
            <strong>Warning: {parseErrors.length} malformed {parseErrors.length === 1 ? "entry" : "entries"} in agents.keys</strong>
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
              {parseErrors.map((err, i) => (
                <li key={i} style={{ fontSize: "0.85rem", marginBottom: "0.2rem" }}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {newSecret && (
          <div style={{ background: "#e8f5e9", border: "1px solid #4caf50", padding: "1rem", borderRadius: 6, marginBottom: "1rem" }}>
            <strong>New agent created: {newSecret.agentId}</strong>
            <p style={{ margin: "0.5rem 0", color: "#333" }}>
              Copy the secret below. It will not be shown again.
            </p>
            <code style={{ display: "block", background: "#fff", padding: "0.5rem", borderRadius: 4, wordBreak: "break-all", fontSize: "0.85rem" }}>
              {newSecret.secret}
            </code>
            <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
              <button onClick={copySecret} style={btnStyle}>
                {copied ? "Copied" : "Copy Secret"}
              </button>
              <button onClick={() => setNewSecret(null)} style={{ ...btnStyle, background: "#888" }}>
                Dismiss
              </button>
            </div>
          </div>
        )}

        <form onSubmit={handleAdd} style={{ display: "flex", gap: "0.5rem", marginBottom: "1.5rem" }}>
          <input
            type="text"
            placeholder="Agent display name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1, padding: "0.4rem 0.6rem", border: "1px solid #ccc", borderRadius: 4 }}
          />
          <button type="submit" disabled={adding || !newName.trim()} style={btnStyle}>
            {adding ? "Adding..." : "Add Agent"}
          </button>
        </form>

        {loading ? (
          <p style={{ color: "#888" }}>Loading...</p>
        ) : agents.length === 0 ? (
          <p style={{ color: "#888" }}>No pre-authenticated agents configured.</p>
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <label style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={selected.size === agents.length} onChange={toggleAll} />{" "}
                Select all ({agents.length})
              </label>
              {selected.size > 0 && (
                <button onClick={handleDeleteSelected} style={{ ...btnStyle, background: "#d32f2f" }}>
                  Delete {selected.size} selected
                </button>
              )}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #ddd", textAlign: "left" }}>
                  <th style={{ padding: "0.3rem" }}></th>
                  <th style={{ padding: "0.3rem" }}>Agent ID</th>
                  <th style={{ padding: "0.3rem" }}>Display Name</th>
                  <th style={{ padding: "0.3rem" }}></th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.agent_id} style={{ borderBottom: "1px solid #eee" }}>
                    <td style={{ padding: "0.3rem" }}>
                      <input
                        type="checkbox"
                        checked={selected.has(agent.agent_id)}
                        onChange={() => toggleSelect(agent.agent_id)}
                      />
                    </td>
                    <td style={{ padding: "0.3rem", fontFamily: "monospace", fontSize: "0.85rem" }}>
                      {agent.agent_id}
                    </td>
                    <td style={{ padding: "0.3rem" }}>{agent.display_name}</td>
                    <td style={{ padding: "0.3rem" }}>
                      <button
                        onClick={() => handleDelete(agent.agent_id)}
                        style={{ ...btnStyle, background: "#d32f2f", padding: "0.2rem 0.5rem", fontSize: "0.8rem" }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#2d7a8a",
  color: "white",
  border: "none",
  padding: "0.4rem 1rem",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: "0.9rem",
};
