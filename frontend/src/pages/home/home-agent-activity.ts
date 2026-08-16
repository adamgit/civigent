import type { AgentActivitySummary, AgentProposalSnapshot } from "../../types/shared.js";
import { HOME_AGENT_ROW_LIMIT } from "./home-constants.js";
import { getDocDisplayName } from "../document-page-utils.js";
import { DocPath } from "../../types/shared.js";

export type HomeAgentRowTone = "running" | "finished" | "idle";

export interface HomeAgentActivityRowModel {
  agentId: string;
  displayName: string;
  tone: HomeAgentRowTone;
  headline: string;
  linkedDocPath: string | null;
  linkedDocTitle: string | null;
  subtext: string;
  sortAt: string;
}

const READ_TOOLS = new Set([
  "read_doc",
  "read_file",
  "read_published_section",
  "read_doc_structure",
  "read_proposal",
  "read_proposal_section",
  "list_documents",
  "list_directory",
  "list_sections",
  "search_text",
]);

function firstDoc(snapshot: AgentProposalSnapshot | undefined): { path: string; title: string } | null {
  const raw = snapshot?.doc_paths[0];
  if (!raw) return null;
  const parsed = DocPath.tryParse(raw);
  return { path: raw, title: parsed ? getDocDisplayName(parsed) : raw };
}

function readCallCount(usage: Readonly<Record<string, number>>): number {
  let n = 0;
  for (const [tool, count] of Object.entries(usage)) {
    if (READ_TOOLS.has(tool)) n += count;
  }
  return n;
}

function latestDraft(agent: AgentActivitySummary): AgentProposalSnapshot | null {
  if (agent.draft_proposals.length === 0) return null;
  return [...agent.draft_proposals].sort(
    (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  )[0] ?? null;
}

function latestCommitted(agent: AgentActivitySummary): AgentProposalSnapshot | null {
  const committed = agent.recent_proposals.filter((p) => p.status === "committed");
  if (committed.length === 0) return null;
  return [...committed].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
}

/**
 * Home agent rows are built from `/api/agents/summary` — the data we actually
 * track per agent: connection heuristic (active / idle / offline), last seen,
 * MCP tool counts, draft proposals, and recent committed/withdrawn proposals.
 *
 * We do not have live "currently rewriting heading X" or "last read N docs in
 * /folder/" events on that summary. Draft `intent` + first `doc_path` stand in
 * for in-flight work; a recent committed proposal stands in for a finished
 * turn; idle copy falls back to last-seen and read-tool totals.
 */
export function buildAgentActivityRows(
  agents: readonly AgentActivitySummary[],
  formatTime: (iso: string, style: "long") => string,
  limit: number = HOME_AGENT_ROW_LIMIT,
): HomeAgentActivityRowModel[] {
  const rows: HomeAgentActivityRowModel[] = [];

  for (const agent of agents) {
    const draft = latestDraft(agent);
    const committed = latestCommitted(agent);
    const lastSeen = agent.last_seen_at;

    let tone: HomeAgentRowTone;
    let headline: string;
    let linked: { path: string; title: string } | null = null;
    let subtext: string;
    let sortAt: string;

    if (draft && (agent.connection_status === "active" || agent.connection_status === "idle")) {
      tone = "running";
      linked = firstDoc(draft);
      headline = draft.intent.trim() || (linked ? `editing ${linked.title}` : "working");
      subtext = `running \u00b7 started ${formatTime(draft.created_at, "long")}`;
      sortAt = draft.created_at;
    } else if (committed) {
      tone = "finished";
      linked = firstDoc(committed);
      headline = committed.intent.trim() || (linked ? `updated ${linked.title}` : "finished a proposal");
      subtext = `finished ${formatTime(committed.created_at, "long")}`;
      sortAt = committed.created_at;
    } else {
      tone = "idle";
      const reads = readCallCount(agent.mcp_tool_usage);
      if (reads > 0) {
        headline = `idle \u2014 last ${reads} read${reads === 1 ? "" : "s"} via MCP`;
      } else if (lastSeen) {
        headline = "idle";
      } else {
        headline = "idle \u2014 no MCP activity yet";
      }
      subtext = lastSeen ? formatTime(lastSeen, "long") : "never seen";
      sortAt = lastSeen ?? "1970-01-01T00:00:00.000Z";
    }

    rows.push({
      agentId: agent.agent_id,
      displayName: agent.display_name,
      tone,
      headline,
      linkedDocPath: linked?.path ?? null,
      linkedDocTitle: linked?.title ?? null,
      subtext,
      sortAt,
    });
  }

  const toneRank: Record<HomeAgentRowTone, number> = { running: 0, finished: 1, idle: 2 };
  rows.sort((a, b) => {
    const rank = toneRank[a.tone] - toneRank[b.tone];
    if (rank !== 0) return rank;
    return Date.parse(b.sortAt) - Date.parse(a.sortAt);
  });
  return rows.slice(0, limit);
}
