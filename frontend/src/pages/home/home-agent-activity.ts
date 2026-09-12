import {
  proposalSectionDocPathForDisplay,
  type ActivityItem,
  type AgentProposalSnapshot,
  type AgentRosterEntry,
  type AnyProposal,
} from "../../types/shared.js";
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

function firstDoc(snapshot: AgentProposalSnapshot | null): { path: string; title: string } | null {
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

function draftSnapshot(proposal: AnyProposal): AgentProposalSnapshot {
  return {
    id: proposal.id,
    intent: proposal.intent,
    status: proposal.status,
    created_at: proposal.created_at,
    doc_paths: [...new Set(proposal.sections.map((s) => proposalSectionDocPathForDisplay(s)))],
    section_count: proposal.sections.length,
  };
}

function latestDraft(agentId: string, proposals: readonly AnyProposal[]): AgentProposalSnapshot | null {
  let latest: AnyProposal | null = null;
  for (const proposal of proposals) {
    if (proposal.writer.id !== agentId || proposal.status !== "draft") continue;
    if (!latest || Date.parse(proposal.created_at) > Date.parse(latest.created_at)) latest = proposal;
  }
  return latest ? draftSnapshot(latest) : null;
}

function landingSnapshot(item: ActivityItem): AgentProposalSnapshot {
  return {
    id: item.id,
    intent: item.intent ?? "",
    status: "committed",
    created_at: item.opened_at,
    doc_paths: [
      ...new Set([...item.sections.map((s) => s.doc_path), ...item.document_paths]),
    ],
    section_count: item.sections.length,
  };
}

function latestLanding(agentId: string, activity: readonly ActivityItem[]): AgentProposalSnapshot | null {
  let latest: ActivityItem | null = null;
  for (const item of activity) {
    if (item.writer_id !== agentId) continue;
    if (!latest || Date.parse(item.opened_at) > Date.parse(latest.opened_at)) latest = item;
  }
  return latest ? landingSnapshot(latest) : null;
}

/**
 * Home agent rows are built from the agent roster, live proposals, and
 * activity: connection heuristic (active / idle / offline), last seen, MCP
 * tool counts come from the roster; the latest draft comes from live
 * proposals; the latest landing comes from activity.
 *
 * We do not have live "currently rewriting heading X" or "last read N docs in
 * /folder/" events. Draft `intent` + first `doc_path` stand in for in-flight
 * work; a recent committed proposal stands in for a finished turn; idle copy
 * falls back to last-seen and read-tool totals.
 */
export function buildAgentActivityRows(
  agents: readonly AgentRosterEntry[],
  proposals: readonly AnyProposal[],
  activity: readonly ActivityItem[],
  formatTime: (iso: string, style: "long") => string,
  limit: number = HOME_AGENT_ROW_LIMIT,
): HomeAgentActivityRowModel[] {
  const rows: HomeAgentActivityRowModel[] = [];

  for (const agent of agents) {
    const draft = latestDraft(agent.agent_id, proposals);
    const committed = latestLanding(agent.agent_id, activity);
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
      subtext = `running · started ${formatTime(draft.created_at, "long")}`;
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
        headline = `idle — last ${reads} read${reads === 1 ? "" : "s"} via MCP`;
      } else if (lastSeen) {
        headline = "idle";
      } else {
        headline = "idle — no MCP activity yet";
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
