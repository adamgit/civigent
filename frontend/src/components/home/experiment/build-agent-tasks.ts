import {
  proposalSectionDocPathForDisplay,
  proposalTargetDocPathForDisplay,
  type ActivityItem,
  type AgentActivitySummary,
  type AnyProposal,
  DocPath,
} from "../../../types/shared.js";
import { getDocDisplayName, headingPathToLabel } from "../../../pages/document-page-utils.js";
import { isReadTool, isWriteTool } from "./mcp-kind.js";
import type { HomeAgentTask, HomeAgentTaskDoc, HomeAgentTaskTouch, HomeMcpPulseAction } from "./types.js";

/** Committed proposals have no committed_at; cap the read-attribution window. */
const TERMINAL_CAP_MS = 4 * 60 * 60 * 1000;
const EXPLORE_GAP_MS = 30 * 60 * 1000;
const SHOW_FINISHED_MS = 7 * 24 * 60 * 60 * 1000;
const RUNNING_ACTION_MS = 5 * 60 * 1000;
export const HOME_AGENT_TASK_LIMIT = 48;

interface ProposalWindow {
  proposal: AnyProposal;
  startMs: number;
  endMs: number;
  terminal: boolean;
}

function asDoc(path: string): HomeAgentTaskDoc | null {
  if (!path) return null;
  const parsed = DocPath.tryParse(path);
  return { path, title: parsed ? getDocDisplayName(parsed) : path };
}

function sectionLabel(headingPath: string[] | null | undefined): string | null {
  if (!headingPath) return null;
  return headingPathToLabel(headingPath);
}

function collectTouches(
  actions: Iterable<HomeMcpPulseAction>,
  predicate: (method: string) => boolean,
): HomeAgentTaskTouch[] {
  const order: string[] = [];
  const sectionsByPath = new Map<string, string[]>();
  for (const action of actions) {
    if (!predicate(action.method) || !action.doc_path) continue;
    if (!sectionsByPath.has(action.doc_path)) {
      order.push(action.doc_path);
      sectionsByPath.set(action.doc_path, []);
    }
    const label = sectionLabel(action.heading_path);
    const sections = sectionsByPath.get(action.doc_path)!;
    if (label && !sections.includes(label)) sections.push(label);
  }
  return order.flatMap((path) => {
    const doc = asDoc(path);
    if (!doc) return [];
    return [{ path, title: doc.title, sections: sectionsByPath.get(path) ?? [] }];
  });
}

function addSection(
  touches: HomeAgentTaskTouch[],
  path: string,
  headingPath: string[] | undefined,
): HomeAgentTaskTouch[] {
  const doc = asDoc(path);
  if (!doc) return touches;
  const label = sectionLabel(headingPath);
  const existing = touches.find((touch) => touch.path === path);
  if (!existing) {
    return [...touches, { path, title: doc.title, sections: label ? [label] : [] }];
  }
  if (!label || existing.sections.includes(label)) return touches;
  return touches.map((touch) =>
    touch.path === path ? { ...touch, sections: [...touch.sections, label] } : touch,
  );
}

function writesFromProposal(
  proposal: AnyProposal,
  mcpWrites: HomeAgentTaskTouch[],
): HomeAgentTaskTouch[] {
  let writes = mcpWrites;
  for (const section of proposal.sections) {
    writes = addSection(writes, proposalSectionDocPathForDisplay(section), section.heading_path);
  }
  for (const target of proposal.targets) {
    writes = addSection(
      writes,
      proposalTargetDocPathForDisplay(target),
      target.kind === "section" ? target.heading_path : undefined,
    );
  }
  return writes;
}

function windowsForAgent(proposals: AnyProposal[], nowMs: number): ProposalWindow[] {
  const sorted = [...proposals].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  return sorted.map((proposal, index) => {
    const startMs = Date.parse(proposal.created_at);
    const next = sorted[index + 1];
    const nextStart = next ? Date.parse(next.created_at) : Number.POSITIVE_INFINITY;
    const terminal = proposal.status === "committed" || proposal.status === "withdrawn";
    const cap = terminal ? startMs + TERMINAL_CAP_MS : nowMs;
    const endMs = Math.max(startMs, Math.min(cap, nextStart, nowMs));
    return { proposal, startMs, endMs, terminal };
  });
}

function coveringWindow(windows: ProposalWindow[], ts: number): ProposalWindow | null {
  for (let i = windows.length - 1; i >= 0; i--) {
    const window = windows[i]!;
    if (ts >= window.startMs && ts <= window.endMs) return window;
  }
  return null;
}

function draftStatus(
  agent: AgentActivitySummary | undefined,
  lastActionMs: number,
  nowMs: number,
): "running" | "waiting" {
  if (agent?.connection_status === "active" || agent?.connection_status === "idle") {
    return "running";
  }
  if (nowMs - lastActionMs < RUNNING_ACTION_MS) return "running";
  return "waiting";
}

function intentOf(proposal: AnyProposal): string {
  const intent = proposal.intent.trim();
  return intent.length > 0 ? intent : "Untitled proposal";
}

export function buildAgentTasks(
  proposals: readonly AnyProposal[],
  actions: readonly HomeMcpPulseAction[],
  agents: readonly AgentActivitySummary[],
  activity: readonly ActivityItem[],
  nowMs: number = Date.now(),
  limit: number = HOME_AGENT_TASK_LIMIT,
): HomeAgentTask[] {
  const byAgent = new Map<string, AnyProposal[]>();
  for (const proposal of proposals) {
    if (proposal.writer.type !== "agent") continue;
    if (proposal.status === "withdrawn") continue;
    const list = byAgent.get(proposal.writer.id) ?? [];
    list.push(proposal);
    byAgent.set(proposal.writer.id, list);
  }

  const agentById = new Map(agents.map((agent) => [agent.agent_id, agent]));
  const windowsByAgent = new Map<string, ProposalWindow[]>();
  for (const [agentId, list] of byAgent) {
    windowsByAgent.set(agentId, windowsForAgent(list, nowMs));
  }

  const actionsByWindow = new Map<AnyProposal, HomeMcpPulseAction[]>();
  const lastActionByWindow = new Map<AnyProposal, number>();
  const coveredActionKeys = new Set<number>();

  actions.forEach((action, actionIndex) => {
    const ts = Date.parse(action.ts);
    if (Number.isNaN(ts)) return;
    const windows = windowsByAgent.get(action.agent_id);
    if (!windows) return;
    const window = coveringWindow(windows, ts);
    if (!window) return;
    coveredActionKeys.add(actionIndex);
    lastActionByWindow.set(
      window.proposal,
      Math.max(lastActionByWindow.get(window.proposal) ?? window.startMs, ts),
    );
    const list = actionsByWindow.get(window.proposal) ?? [];
    list.push(action);
    actionsByWindow.set(window.proposal, list);
  });

  const tasks: HomeAgentTask[] = [];

  for (const [agentId, windows] of windowsByAgent) {
    const agent = agentById.get(agentId);
    for (const window of windows) {
      const proposal = window.proposal;
      const lastActionMs = lastActionByWindow.get(proposal) ?? window.startMs;
      const isOpen =
        proposal.status === "draft" ||
        proposal.status === "pending" ||
        proposal.status === "inprogress" ||
        proposal.status === "committing";

      if (!isOpen && nowMs - lastActionMs > SHOW_FINISHED_MS && nowMs - window.startMs > SHOW_FINISHED_MS) {
        continue;
      }

      const windowActions = actionsByWindow.get(proposal) ?? [];
      const endedAt = isOpen ? null : new Date(lastActionMs).toISOString();
      tasks.push({
        id: proposal.id,
        agentId,
        displayName: proposal.writer.displayName,
        intent: intentOf(proposal),
        status: isOpen ? draftStatus(agent, lastActionMs, nowMs) : "finished",
        startedAt: proposal.created_at,
        endedAt,
        reads: collectTouches(windowActions, isReadTool),
        writes: writesFromProposal(proposal, collectTouches(windowActions, isWriteTool)),
      });
    }
  }

  const uncoveredReads = actions.filter((action, index) => {
    if (coveredActionKeys.has(index)) return false;
    return isReadTool(action.method);
  });

  const exploringByAgent = new Map<string, HomeMcpPulseAction[]>();
  for (const action of uncoveredReads) {
    const list = exploringByAgent.get(action.agent_id) ?? [];
    list.push(action);
    exploringByAgent.set(action.agent_id, list);
  }

  for (const [agentId, list] of exploringByAgent) {
    const sorted = [...list].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    let cluster: HomeMcpPulseAction[] = [];
    const flush = () => {
      if (cluster.length === 0) return;
      const first = cluster[0]!;
      const last = cluster[cluster.length - 1]!;
      const lastMs = Date.parse(last.ts);
      const searched = cluster.some((action) => action.method === "search_text");
      const reads = collectTouches(cluster, isReadTool);
      tasks.push({
        id: `explore-${agentId}-${first.ts}`,
        agentId,
        displayName: first.agent_display_name,
        intent: searched
          ? reads.length > 0
            ? "Searching"
            : "Searching the store"
          : reads.length === 1
            ? `Reading ${reads[0]!.title}`
            : `Reading ${reads.length} documents`,
        status: nowMs - lastMs < RUNNING_ACTION_MS ? "running" : "exploring",
        startedAt: first.ts,
        endedAt: last.ts,
        reads,
        writes: [],
      });
      cluster = [];
    };

    for (const action of sorted) {
      const prev = cluster[cluster.length - 1];
      if (prev && Date.parse(action.ts) - Date.parse(prev.ts) > EXPLORE_GAP_MS) flush();
      cluster.push(action);
    }
    flush();
  }

  // Activity-only commits with no matching proposal task still belong on the pulse.
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const item of activity) {
    if (item.writer_type !== "agent") continue;
    if (taskIds.has(item.id)) continue;
    const ts = Date.parse(item.timestamp);
    if (Number.isNaN(ts) || nowMs - ts > SHOW_FINISHED_MS) continue;
    let writes: HomeAgentTaskTouch[] = [];
    for (const section of item.sections) {
      writes = addSection(writes, section.doc_path, section.heading_path);
    }
    tasks.push({
      id: item.id,
      agentId: item.writer_id,
      displayName: item.writer_display_name,
      intent: item.intent?.trim() || "Committed changes",
      status: "finished",
      startedAt: item.timestamp,
      endedAt: item.timestamp,
      reads: [],
      writes,
    });
  }

  const statusRank: Record<HomeAgentTask["status"], number> = {
    running: 0,
    waiting: 1,
    exploring: 2,
    finished: 3,
  };
  tasks.sort((a, b) => {
    const rank = statusRank[a.status] - statusRank[b.status];
    if (rank !== 0) return rank;
    const aAt = Date.parse(a.endedAt ?? a.startedAt);
    const bAt = Date.parse(b.endedAt ?? b.startedAt);
    return bAt - aAt;
  });
  return tasks.slice(0, limit);
}

export function taskOverlapsRange(task: HomeAgentTask, startMs: number, endMs: number): boolean {
  const t0 = Date.parse(task.startedAt);
  const t1 = Date.parse(task.endedAt ?? new Date().toISOString());
  if (Number.isNaN(t0) || Number.isNaN(t1)) return false;
  return t0 < endMs && t1 >= startMs;
}
