import { useCallback, useEffect, useState } from "react";
import type { DocStructureNode, Proposal } from "../types/shared.js";
import { apiClient } from "../services/api-client.js";
import { SharedPageHeader } from "../components/SharedPageHeader";

// ─── Agent fetch helper (bypasses human cookie auth) ────────────────────────

interface AgentResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  raw: string;
  method: string;
  url: string;
  requestBody?: string;
}

async function agentFetch<T = unknown>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<AgentResponse<T>> {
  const method = init?.method ?? "GET";
  const requestBody = typeof init?.body === "string" ? init.body : undefined;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  const raw = await response.text();
  let body: T;
  try {
    body = JSON.parse(raw) as T;
  } catch {
    body = raw as unknown as T;
  }
  return { status: response.status, ok: response.ok, body, raw, method, url, requestBody };
}

// ─── Response display ───────────────────────────────────────────────────────

function ResponseBlock({ response, label }: { response: AgentResponse | null; label: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!response) return null;

  const statusColor = response.ok
    ? "text-green-700 bg-green-50 border-green-200"
    : "text-red-700 bg-red-50 border-red-200";

  return (
    <div className={`mt-2 border rounded-lg overflow-hidden ${response.ok ? "border-green-200" : "border-red-200"}`}>
      <div className={`px-3 py-1.5 text-xs font-medium flex items-center justify-between ${statusColor}`}>
        <span>{label}: {response.status} {response.ok ? "OK" : "Error"}</span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs bg-transparent border-none cursor-pointer underline opacity-70"
        >
          {expanded ? "Hide raw" : "Show raw"}
        </button>
      </div>
      {expanded && (
        <pre className="text-[11px] p-3 m-0 bg-gray-50 overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto">
          <span className="text-gray-400">{`${response.method} ${response.url}`}</span>
          {response.requestBody ? (
            <>
              {"\n"}
              <span className="text-gray-400">Body: </span>
              {response.requestBody}
            </>
          ) : null}
          {"\n\n"}
          <span className="text-gray-400">{`← ${response.status}`}</span>
          {"\n"}
          {JSON.stringify(response.body, null, 2)}
        </pre>
      )}
    </div>
  );
}

// ─── Add Section Form (for adding sections to a blocked proposal) ──────────

interface EvalSectionShape {
  doc_path: string;
  heading_path: string[];
  humanInvolvement_score: number;
  blocked: boolean;
  content: string;
  justification?: string;
}

function AddSectionForm({
  docTree,
  onAdd,
}: {
  docTree: Array<{ path: string }>;
  onAdd: (section: EvalSectionShape) => void;
}) {
  const [open, setOpen] = useState(false);
  const [addDocPath, setAddDocPath] = useState("");
  const [addHeadingStr, setAddHeadingStr] = useState("");
  const [addContent, setAddContent] = useState("");
  const [addJustification, setAddJustification] = useState("");
  const [addHeadings, setAddHeadings] = useState<Array<{ path: string[]; label: string }>>([]);

  // Load headings when doc changes
  useEffect(() => {
    if (!addDocPath) { setAddHeadings([]); return; }
    apiClient.getDocumentStructure(addDocPath)
      .then((data) => {
        if (data.structure) setAddHeadings(flattenHeadings(data.structure));
      })
      .catch(() => setAddHeadings([]));
  }, [addDocPath]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-blue-700 bg-transparent border border-dashed border-blue-300 rounded px-2 py-1 cursor-pointer mb-3"
      >
        + Add section
      </button>
    );
  }

  const handleAdd = () => {
    const headingPath = addHeadingStr.trim()
      ? addHeadingStr.split(">").map((s) => s.trim()).filter(Boolean)
      : [];
    onAdd({
      doc_path: addDocPath,
      heading_path: headingPath,
      humanInvolvement_score: -1, // unknown until re-evaluated
      blocked: false,
      content: addContent,
      ...(addJustification.trim() ? { justification: addJustification.trim() } : {}),
    });
    // Reset form
    setAddDocPath("");
    setAddHeadingStr("");
    setAddContent("");
    setAddJustification("");
    setOpen(false);
  };

  return (
    <div className="mb-3 border border-dashed border-blue-300 rounded p-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-blue-700">Add new section</span>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-gray-400 bg-transparent border-none cursor-pointer">cancel</button>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        Document path
        <select
          value={addDocPath}
          onChange={(e) => { setAddDocPath(e.target.value); setAddHeadingStr(""); }}
          className="text-xs px-2 py-1.5 border border-gray-300 rounded"
        >
          <option value="">-- select document --</option>
          {docTree.map((d) => (
            <option key={d.path} value={d.path}>{d.path}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Heading path
        {addHeadings.length > 0 ? (
          <select
            value={addHeadingStr}
            onChange={(e) => setAddHeadingStr(e.target.value)}
            className="text-xs px-2 py-1.5 border border-gray-300 rounded font-mono"
          >
            <option value="">-- select heading --</option>
            {addHeadings.map((h) => (
              <option key={h.path.join(">")} value={h.path.join(">")}>{h.label}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={addHeadingStr}
            onChange={(e) => setAddHeadingStr(e.target.value)}
            placeholder="Heading > Subheading"
            className="text-xs px-2 py-1.5 border border-gray-300 rounded"
          />
        )}
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Content (markdown)
        <textarea
          value={addContent}
          onChange={(e) => setAddContent(e.target.value)}
          rows={3}
          className="text-xs px-2 py-1.5 border border-gray-300 rounded font-mono"
          placeholder="New section content..."
        />
      </label>
      <label className="flex flex-col gap-1 text-xs">
        Justification (optional)
        <input
          type="text"
          value={addJustification}
          onChange={(e) => setAddJustification(e.target.value)}
          className="text-xs px-2 py-1.5 border border-gray-300 rounded"
        />
      </label>
      <button
        type="button"
        onClick={handleAdd}
        disabled={!addDocPath.trim() || !addContent.trim()}
        className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded border-none cursor-pointer disabled:opacity-50"
      >
        Add to proposal
      </button>
    </div>
  );
}

// ─── Section target picker helpers ──────────────────────────────────────────

function flattenHeadings(nodes: DocStructureNode[], prefix: string[] = []): Array<{ path: string[]; label: string }> {
  const result: Array<{ path: string[]; label: string }> = [];
  for (const node of nodes) {
    const currentPath = [...prefix, node.heading];
    const indent = "  ".repeat(prefix.length);
    result.push({ path: currentPath, label: `${indent}${node.heading}` });
    if (node.children && node.children.length > 0) {
      result.push(...flattenHeadings(node.children, currentPath));
    }
  }
  return result;
}

// ─── Main page ──────────────────────────────────────────────────────────────

interface AgentIdentity {
  id: string;
  token: string;
  displayName: string;
}

export function AgentSimulatorPage() {
  // Agent identity
  const [agent, setAgent] = useState<AgentIdentity | null>(null);
  const [agentName, setAgentName] = useState("test-agent");
  const [registerResponse, setRegisterResponse] = useState<AgentResponse | null>(null);
  const [registering, setRegistering] = useState(false);

  // Proposal state
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [proposalOutcome, setProposalOutcome] = useState<string | null>(null); // "accepted" | "blocked" | null
  const [proposalStatus, setProposalStatus] = useState<string | null>(null); // "committed" | "pending" | null

  // Step inputs
  const [intent, setIntent] = useState("Agent test edit");
  const [docPath, setDocPath] = useState("");
  const [headingPathStr, setHeadingPathStr] = useState("");
  const [newContent, setNewContent] = useState("Test content from agent simulator.");
  const [justification, setJustification] = useState("");

  // Edit inputs (for PUT /proposals/:id when blocked)
  const [editContent, setEditContent] = useState("");
  const [editJustification, setEditJustification] = useState("");

  // Evaluated sections from propose response (for section-level management)
  const [evalSections, setEvalSections] = useState<EvalSectionShape[]>([]);
  const [includedSections, setIncludedSections] = useState<Set<number>>(new Set());

  // Step responses
  const [proposeResponse, setProposeResponse] = useState<AgentResponse | null>(null);
  const [updateResponse, setUpdateResponse] = useState<AgentResponse | null>(null);
  const [commitResponse, setCommitResponse] = useState<AgentResponse | null>(null);

  // Loading states
  const [proposing, setProposing] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [committing, setCommitting] = useState(false);

  // Cancel
  const [cancelReason, setCancelReason] = useState("Testing cancellation");

  // Existing pending proposals
  const [pendingProposals, setPendingProposals] = useState<Proposal[]>([]);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);

  // Document tree for picker
  const [docTree, setDocTree] = useState<Array<{ path: string }>>([]);
  const [headings, setHeadings] = useState<Array<{ path: string[]; label: string }>>([]);

  // Load document tree on mount
  useEffect(() => {
    apiClient.getDocumentsTree()
      .then((data) => {
        const docs = (data.tree ?? []).filter((e: { type: string }) => e.type === "file");
        setDocTree(docs);
      })
      .catch(() => { /* non-fatal background fetch */ });
  }, []);

  // Load headings when doc_path changes
  useEffect(() => {
    if (!docPath) {
      setHeadings([]);
      return;
    }
    apiClient.getDocumentStructure(docPath)
      .then((data) => {
        if (data.structure) {
          setHeadings(flattenHeadings(data.structure));
        }
      })
      .catch(() => { setHeadings([]); });
  }, [docPath]);

  // ── Fetch pending proposals ─────────────────────────────────────────────

  const fetchPendingProposals = useCallback(async () => {
    const resp = await agentFetch<{ proposals?: Proposal[] }>(
      "/api/proposals?status=pending",
      agent?.token ?? "",
    );
    if (resp.ok && Array.isArray(resp.body.proposals)) {
      setPendingProposals(resp.body.proposals);
    }
  }, [agent?.token]);

  // Auto-fetch pending proposals when agent is registered
  useEffect(() => {
    if (agent) {
      void fetchPendingProposals();
    } else {
      setPendingProposals([]);
    }
  }, [agent, fetchPendingProposals]);

  const handleWithdraw = async (id: string) => {
    if (!agent) return;
    setWithdrawingId(id);
    await agentFetch(
      `/api/proposals/${encodeURIComponent(id)}/cancel`,
      agent.token,
      { method: "POST", body: JSON.stringify({ reason: "Withdrawn via Agent Simulator" }) },
    );
    await fetchPendingProposals();
    setWithdrawingId(null);
  };

  // ── Step 0: Register ──────────────────────────────────────────────────────

  const handleRegister = async () => {
    setRegistering(true);
    const resp = await agentFetch<{ identity?: { id: string }; access_token?: string }>(
      "/api/auth/agent/register",
      "",
      {
        method: "POST",
        body: JSON.stringify({ display_name: agentName }),
        headers: { "Content-Type": "application/json" },
      },
    );
    setRegisterResponse(resp);
    if (resp.ok && resp.body.identity?.id && resp.body.access_token) {
      setAgent({
        id: resp.body.identity.id,
        token: resp.body.access_token,
        displayName: agentName,
      });
    }
    setRegistering(false);
  };

  const handleReset = () => {
    setAgent(null);
    setProposalId(null);
    setProposalOutcome(null);
    setProposalStatus(null);
    setRegisterResponse(null);
    setProposeResponse(null);
    setUpdateResponse(null);
    setCommitResponse(null);
    setPendingProposals([]);
  };

  const handleNewProposal = () => {
    setProposalId(null);
    setProposalOutcome(null);
    setProposalStatus(null);
    setProposeResponse(null);
    setUpdateResponse(null);
    setCommitResponse(null);
    setEditContent("");
    setEditJustification("");
    setEvalSections([]);
    setIncludedSections(new Set());
  };

  // ── Step 1: Create Proposal ─────────────────────────────────────────────

  const handlePropose = async () => {
    if (!agent) return;
    setProposing(true);
    setProposeResponse(null);
    setUpdateResponse(null);
    setCommitResponse(null);
    setProposalId(null);
    setProposalOutcome(null);
    setProposalStatus(null);

    const headingPath = headingPathStr.trim()
      ? headingPathStr.split(">").map((s) => s.trim()).filter(Boolean)
      : [];

    const sections = [{
      doc_path: docPath,
      heading_path: headingPath,
      content: newContent,
      ...(justification.trim() ? { justification: justification.trim() } : {}),
    }];

    const resp = await agentFetch<{
      proposal_id?: string;
      status?: string;
      outcome?: string;
      committed_head?: string;
      evaluation?: unknown;
      sections?: unknown[];
    }>(
      "/api/proposals",
      agent.token,
      {
        method: "POST",
        body: JSON.stringify({ intent, sections }),
      },
    );
    setProposeResponse(resp);
    if (resp.ok && resp.body.proposal_id) {
      setProposalId(resp.body.proposal_id);
      setProposalStatus(resp.body.status ?? null);
      setProposalOutcome(resp.body.outcome ?? null);
      setEditContent(newContent);

      // Store evaluated sections for section-level management
      const respSections = (resp.body.sections ?? []) as Array<{
        doc_path: string;
        heading_path: string[];
        humanInvolvement_score: number;
        blocked: boolean;
        justification?: string;
      }>;
      if (respSections.length > 0) {
        const merged = respSections.map((es) => ({
          ...es,
          content: sections.find(
            (s) => s.doc_path === es.doc_path &&
              JSON.stringify(s.heading_path) === JSON.stringify(es.heading_path)
          )?.content ?? newContent,
        }));
        setEvalSections(merged);
        // Include all sections by default
        setIncludedSections(new Set(merged.map((_, i) => i)));
      }

      void fetchPendingProposals();
    }
    setProposing(false);
  };

  // ── Step 2: Update Proposal (when blocked) ──────────────────────────────

  const handleUpdate = async () => {
    if (!agent || !proposalId) return;
    setUpdating(true);

    // Build sections from evalSections, only including checked ones
    let sections: Array<{ doc_path: string; heading_path: string[]; content: string; justification?: string }>;

    if (evalSections.length > 0) {
      sections = evalSections
        .filter((_, i) => includedSections.has(i))
        .map((es) => ({
          doc_path: es.doc_path,
          heading_path: es.heading_path,
          content: es.content,
          ...(es.justification ? { justification: es.justification } : {}),
        }));
    } else {
      // Fallback: single section from text inputs
      const headingPath = headingPathStr.trim()
        ? headingPathStr.split(">").map((s) => s.trim()).filter(Boolean)
        : [];
      sections = [{
        doc_path: docPath,
        heading_path: headingPath,
        content: editContent,
        ...(editJustification.trim() ? { justification: editJustification.trim() } : {}),
      }];
    }

    if (sections.length === 0) {
      setUpdateResponse({
        status: 0, ok: false, body: { error: "No sections selected. Remove all blocked sections and cancel, or keep at least one." },
        raw: "", method: "PUT", url: `/api/proposals/${proposalId}`,
      });
      setUpdating(false);
      return;
    }

    const resp = await agentFetch<{ proposal?: unknown; sections?: unknown[] }>(
      `/api/proposals/${encodeURIComponent(proposalId)}`,
      agent.token,
      {
        method: "PUT",
        body: JSON.stringify({ sections }),
      },
    );
    setUpdateResponse(resp);
    setUpdating(false);
  };

  // ── Step 3: Commit / Cancel ─────────────────────────────────────────────

  const handleCommit = async () => {
    if (!agent || !proposalId) return;
    setCommitting(true);
    const resp = await agentFetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/commit`,
      agent.token,
      { method: "POST", body: "{}" },
    );
    setCommitResponse(resp);
    if (resp.ok) {
      setProposalStatus("committed");
      void fetchPendingProposals();
    }
    setCommitting(false);
  };

  const handleCancel = async () => {
    if (!agent || !proposalId) return;
    setCommitting(true);
    const resp = await agentFetch(
      `/api/proposals/${encodeURIComponent(proposalId)}/cancel`,
      agent.token,
      { method: "POST", body: JSON.stringify({ reason: cancelReason }) },
    );
    setCommitResponse(resp);
    if (resp.ok) {
      setProposalStatus("cancelled");
      void fetchPendingProposals();
    }
    setCommitting(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const isAutoCommitted = proposalStatus === "committed" && proposalOutcome === "accepted" && !commitResponse;
  const isBlocked = proposalOutcome === "blocked" && proposalStatus === "pending";
  const isTerminal = proposalStatus === "committed" || proposalStatus === "cancelled";

  return (
    <section className="max-w-[720px] mx-auto px-6 py-8">
      <SharedPageHeader title="Agent Simulator" backTo="/" />
      <p className="text-xs text-text-secondary mb-6">
        Drive agent API calls step-by-step from the browser. Open the editor in another tab to test coordination.
      </p>

      {/* ── Step 0: Register ─────────────────────────────────────────── */}
      <div className="mb-6 border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold m-0">Step 0: Agent Identity</h2>
          {agent && (
            <button type="button" onClick={handleReset} className="text-xs text-red-600 bg-transparent border-none cursor-pointer underline">
              Reset
            </button>
          )}
        </div>
        {!agent ? (
          <div className="flex gap-2 items-end">
            <label className="flex flex-col gap-1 text-xs flex-1">
              Agent name
              <input
                type="text"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleRegister()}
              disabled={registering || !agentName.trim()}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded border-none cursor-pointer disabled:opacity-50"
            >
              {registering ? "Registering..." : "Register Agent"}
            </button>
          </div>
        ) : (
          <div className="text-xs space-y-1">
            <div><span className="text-gray-500">Agent ID:</span> <code className="bg-gray-100 px-1 rounded">{agent.id}</code></div>
            <div><span className="text-gray-500">Display name:</span> {agent.displayName}</div>
            <div>
              <span className="text-gray-500">Token:</span>{" "}
              <code className="bg-gray-100 px-1 rounded text-[10px]">{agent.token.slice(0, 30)}...</code>
            </div>
          </div>
        )}
        <ResponseBlock response={registerResponse} label="Register" />
      </div>

      {/* ── Pending Proposals ────────────────────────────────────────── */}
      {agent && pendingProposals.length > 0 && (
        <div className="mb-6 border border-yellow-300 rounded-lg p-4 bg-yellow-50/30">
          <h2 className="text-sm font-semibold text-yellow-800 mb-2">
            Pending Proposals ({pendingProposals.length})
          </h2>
          <p className="text-[11px] text-yellow-700 mb-3">
            These proposals are currently pending. Proposals owned by this agent can be withdrawn.
          </p>
          <div className="space-y-2">
            {pendingProposals.map((p) => {
              const isOwn = p.writer.id === agent.id;
              const sections = p.sections.map((s) =>
                `${s.doc_path} > ${s.heading_path.join(" > ")}`
              ).join(", ");
              return (
                <div key={p.id} className="flex items-start gap-2 text-xs p-2 bg-white border border-yellow-200 rounded">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{p.intent}</div>
                    <div className="text-gray-500 truncate">{sections}</div>
                    <div className="text-gray-400 mt-0.5">
                      by {p.writer.displayName ?? p.writer.id}
                      {isOwn && <span className="ml-1 text-blue-600 font-medium">(this agent)</span>}
                      {" "}&middot; <code className="text-[10px]">{p.id.slice(0, 8)}...</code>
                    </div>
                  </div>
                  {isOwn && (
                    <button
                      type="button"
                      onClick={() => void handleWithdraw(p.id)}
                      disabled={withdrawingId === p.id}
                      className="text-xs px-2 py-1 bg-red-600 text-white rounded border-none cursor-pointer disabled:opacity-50 whitespace-nowrap"
                    >
                      {withdrawingId === p.id ? "..." : "Withdraw"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void fetchPendingProposals()}
            className="text-xs mt-2 px-2 py-1 bg-transparent border border-yellow-400 text-yellow-800 rounded cursor-pointer"
          >
            Refresh
          </button>
        </div>
      )}

      {/* ── Step 1: Create Proposal ──────────────────────────────────── */}
      {agent && !proposalId && (
        <div className="mb-6 border border-blue-300 bg-blue-50/30 rounded-lg p-4">
          <h2 className="text-sm font-semibold mb-2">Step 1: Create Proposal</h2>
          <p className="text-[11px] text-gray-500 mb-3">
            Submit a proposal with content. It starts as pending — use commit_proposal to commit it.
          </p>
          <div className="space-y-2">
            <label className="flex flex-col gap-1 text-xs">
              Intent
              <input
                type="text"
                value={intent}
                onChange={(e) => setIntent(e.target.value)}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Document path
              <select
                value={docPath}
                onChange={(e) => { setDocPath(e.target.value); setHeadingPathStr(""); }}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded"
              >
                <option value="">-- select document --</option>
                {docTree.map((d) => (
                  <option key={d.path} value={d.path}>{d.path}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Heading path
              {headings.length > 0 ? (
                <select
                  value={headingPathStr}
                  onChange={(e) => setHeadingPathStr(e.target.value)}
                  className="text-xs px-2 py-1.5 border border-gray-300 rounded font-mono"
                >
                  <option value="">-- select heading --</option>
                  {headings.map((h) => (
                    <option key={h.path.join(">")} value={h.path.join(">")}>{h.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={headingPathStr}
                  onChange={(e) => setHeadingPathStr(e.target.value)}
                  placeholder="Heading > Subheading"
                  className="text-xs px-2 py-1.5 border border-gray-300 rounded"
                />
              )}
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Content (markdown)
              <textarea
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                rows={4}
                className="text-xs px-2 py-1.5 border border-gray-300 rounded font-mono"
                placeholder="Enter the new section content..."
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Justification (optional)
              <input
                type="text"
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Why this change?"
                className="text-xs px-2 py-1.5 border border-gray-300 rounded"
              />
            </label>
            <button
              type="button"
              onClick={() => void handlePropose()}
              disabled={proposing || !docPath.trim() || !newContent.trim()}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded border-none cursor-pointer disabled:opacity-50"
            >
              {proposing ? "Submitting..." : "Create Proposal"}
            </button>
          </div>
          <ResponseBlock response={proposeResponse} label="Propose" />
        </div>
      )}

      {/* ── Auto-committed result ────────────────────────────────────── */}
      {proposalId && isAutoCommitted && (
        <div className="mb-6 border border-green-300 rounded-lg p-4 bg-green-50/50">
          <h2 className="text-sm font-semibold text-green-700 mb-1">Proposal auto-committed</h2>
          <p className="text-xs text-green-600 mb-2">
            All sections passed human-involvement evaluation. Proposal <code>{proposalId}</code> was committed immediately.
          </p>
          <ResponseBlock response={proposeResponse} label="Propose" />
          <button
            type="button"
            onClick={handleNewProposal}
            className="text-xs mt-2 px-3 py-1.5 bg-blue-600 text-white rounded border-none cursor-pointer"
          >
            Start new proposal
          </button>
        </div>
      )}

      {/* ── Blocked / Pending — Update or Commit ─────────────────────── */}
      {proposalId && isBlocked && (
        <>
          <div className="mb-6 border border-yellow-300 rounded-lg p-4 bg-yellow-50/30">
            <h2 className="text-sm font-semibold text-yellow-800 mb-1">Proposal blocked</h2>
            <p className="text-xs text-yellow-700 mb-2">
              Some sections were blocked by human-involvement thresholds. Proposal <code>{proposalId}</code> is pending review.
            </p>
            <ResponseBlock response={proposeResponse} label="Propose" />
          </div>

          {/* Step 2: Update sections */}
          <div className="mb-6 border border-blue-300 bg-blue-50/30 rounded-lg p-4">
            <h2 className="text-sm font-semibold mb-2">Step 2: Update Proposal (optional)</h2>
            <p className="text-[11px] text-gray-500 mb-3">
              Remove blocked sections or modify content before committing. Uses PUT /api/proposals/:id.
            </p>

            {evalSections.length > 0 ? (
              <div className="space-y-2 mb-3">
                {evalSections.map((es, i) => {
                  const included = includedSections.has(i);
                  return (
                    <div
                      key={`${es.doc_path}-${es.heading_path.join("/")}`}
                      className={`border rounded p-2 ${es.blocked ? "border-red-300 bg-red-50/40" : es.humanInvolvement_score < 0 ? "border-blue-300 bg-blue-50/40" : "border-green-300 bg-green-50/40"} ${!included ? "opacity-40" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={() => {
                            setIncludedSections((prev) => {
                              const next = new Set(prev);
                              if (next.has(i)) next.delete(i);
                              else next.add(i);
                              return next;
                            });
                          }}
                          className="mt-0.5"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-xs mb-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${es.blocked ? "bg-red-200 text-red-800" : es.humanInvolvement_score < 0 ? "bg-blue-200 text-blue-800" : "bg-green-200 text-green-800"}`}>
                              {es.blocked ? "BLOCKED" : es.humanInvolvement_score < 0 ? "NEW" : "PASSED"}
                            </span>
                            {es.humanInvolvement_score >= 0 && (
                              <span className="text-gray-500">score: {es.humanInvolvement_score.toFixed(2)}</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-700 font-mono truncate mb-1">
                            {es.doc_path} &gt; {es.heading_path.join(" > ")}
                          </div>
                          {included && (
                            <>
                              <textarea
                                value={es.content}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setEvalSections((prev) =>
                                    prev.map((s, j) => j === i ? { ...s, content: val } : s)
                                  );
                                }}
                                rows={3}
                                className="text-xs px-2 py-1.5 border border-gray-300 rounded font-mono w-full"
                              />
                              <input
                                type="text"
                                value={es.justification ?? ""}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setEvalSections((prev) =>
                                    prev.map((s, j) => j === i ? { ...s, justification: val || undefined } : s)
                                  );
                                }}
                                placeholder="Justification (optional)"
                                className="text-xs px-2 py-1.5 border border-gray-300 rounded w-full mt-1"
                              />
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="text-[11px] text-gray-500">
                  {includedSections.size} of {evalSections.length} sections included
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-gray-400 mb-3">No evaluated sections available.</p>
            )}

            {/* Add new section */}
            <AddSectionForm
              docTree={docTree}
              onAdd={(section) => {
                setEvalSections((prev) => {
                  const next = [...prev, section];
                  setIncludedSections((prevInc) => new Set([...prevInc, next.length - 1]));
                  return next;
                });
              }}
            />
            <button
              type="button"
              onClick={() => void handleUpdate()}
              disabled={updating || (evalSections.length > 0 ? includedSections.size === 0 : !editContent.trim())}
              className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded border-none cursor-pointer disabled:opacity-50"
            >
              {updating ? "Updating..." : `Update Sections${evalSections.length > 0 ? ` (${includedSections.size})` : ""}`}
            </button>
            <ResponseBlock response={updateResponse} label="Update" />
          </div>

          {/* Step 3: Commit or Cancel */}
          <div className={`mb-6 border rounded-lg p-4 ${!commitResponse ? "border-gray-200" : commitResponse.ok ? "border-green-300 bg-green-50/30" : "border-red-300 bg-red-50/30"}`}>
            <h2 className="text-sm font-semibold mb-2">Step 3: Commit or Cancel</h2>
            <div className="flex gap-2 items-center">
              <button
                type="button"
                onClick={() => void handleCommit()}
                disabled={committing}
                className="text-xs px-3 py-1.5 bg-green-600 text-white rounded border-none cursor-pointer disabled:opacity-50"
              >
                {committing ? "..." : "Commit"}
              </button>
              <input
                type="text"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Cancel reason"
                className="text-xs px-2 py-1.5 border border-gray-300 rounded flex-1"
              />
              <button
                type="button"
                onClick={() => void handleCancel()}
                disabled={committing}
                className="text-xs px-3 py-1.5 bg-red-600 text-white rounded border-none cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
            <ResponseBlock response={commitResponse} label="Commit/Cancel" />
          </div>
        </>
      )}

      {/* ── Terminal states ───────────────────────────────────────────── */}
      {isTerminal && !isAutoCommitted && (
        <div className={`mb-6 border rounded-lg p-4 ${proposalStatus === "committed" ? "border-green-300 bg-green-50/50" : "border-gray-300 bg-gray-50"}`}>
          <div className={`text-sm font-semibold mb-1 ${proposalStatus === "committed" ? "text-green-700" : "text-gray-600"}`}>
            Proposal {proposalStatus === "committed" ? "committed" : "cancelled"}
          </div>
          <div className={`text-xs ${proposalStatus === "committed" ? "text-green-600" : "text-gray-500"}`}>
            Proposal {proposalId} is now {proposalStatus}.
          </div>
          <ResponseBlock response={commitResponse} label="Commit/Cancel" />
          <button
            type="button"
            onClick={handleNewProposal}
            className="text-xs mt-2 px-3 py-1.5 bg-blue-600 text-white rounded border-none cursor-pointer"
          >
            Start new proposal
          </button>
        </div>
      )}
    </section>
  );
}
