import { forEachFlushedSession, getActivityLogFileInfo } from "./activity-log.js";
import type { ActionEntry, ActionResult, SessionRecord } from "./activity-log.js";
import type {
  AgentMcpLogFileInfo,
  InferredMcpTier,
  McpLogAgentRef,
  McpLogArgShapeCohort,
  McpLogErrorAgentRow,
  McpLogErrorCohort,
  McpLogErrorOutcome,
  McpLogOneToolSession,
  McpLogReadPattern,
  McpLogReadPatternKind,
  McpLogToolCount,
  McpLogWriteOutcome,
  McpLogWriteOutcomeKind,
  RunAdminMcpLogAnalysisResponse,
} from "../types/shared.js";

const TIER_1_2_METHODS = new Set([
  "read_file",
  "write_file",
  "write_files",
  "list_directory",
  "delete_file",
  "move_file",
  "apply_patch",
  "plan_changes",
]);

const TIER_3_METHODS = new Set([
  "list_documents",
  "list_sections",
  "search_text",
  "read_doc",
  "read_doc_structure",
  "read_published_section",
  "read_published_sections",
  "create_proposal",
  "write_proposal_section",
  "publish_proposal",
  "withdraw_proposal",
  "list_proposals",
  "my_proposals",
  "read_proposal",
  "read_proposal_section",
  "create_section",
  "delete_section",
  "move_section",
  "reorder_section",
  "rename_section",
  "delete_document",
  "rename_document",
  "list_section_history",
  "read_section_history",
]);

const STRUCTURAL_METHODS = new Set([
  "create_section",
  "delete_section",
  "move_section",
  "reorder_section",
  "rename_section",
  "delete_document",
  "rename_document",
]);

export const WRITE_OUTCOME_KINDS: McpLogWriteOutcomeKind[] = [
  "wrote_sections_published",
  "structural_only_published",
  "withdrew",
  "never_closed",
];

function actionSucceeded(action: ActionEntry): boolean {
  return action.result === undefined || action.result === "ok";
}

function createWroteSections(action: ActionEntry): boolean {
  if (action.method !== "create_proposal") return false;
  const count = action.metadata.sections_count;
  return typeof count === "number" && count > 0;
}

function fragmentWroteSections(actions: ActionEntry[]): boolean {
  return actions.some(
    (action) => action.method === "write_proposal_section" || createWroteSections(action),
  );
}

export const READ_PATTERN_KINDS: McpLogReadPatternKind[] = [
  "listed_documents_then_read_whole",
  "listed_sections_then_read_section",
  "searched_then_read_whole",
  "searched_then_read_section",
  "read_whole_document",
  "read_section",
];

export function inferMcpToolTier(method: string): InferredMcpTier {
  if (TIER_1_2_METHODS.has(method)) return "1_2";
  if (TIER_3_METHODS.has(method)) return "3";
  return "unmatched";
}

export function isOneToolSession(session: SessionRecord): boolean {
  if (session.actions.length === 0) return false;
  const method = session.actions[0].method;
  return session.actions.every((action) => action.method === method);
}

export function splitSittingIntoFragments(actions: ActionEntry[]): ActionEntry[][] {
  const fragments: ActionEntry[][] = [];
  let current: ActionEntry[] = [];
  for (const action of actions) {
    if (
      action.method === "create_proposal" &&
      current.length > 0 &&
      !current.some((entry) => entry.method === "create_proposal")
    ) {
      fragments.push(current);
      current = [];
    }
    current.push(action);
    if (
      (action.method === "publish_proposal" || action.method === "withdraw_proposal") &&
      actionSucceeded(action)
    ) {
      fragments.push(current);
      current = [];
    }
  }
  if (current.length > 0) fragments.push(current);
  return fragments;
}

function methodSet(actions: ActionEntry[]): Set<string> {
  return new Set(actions.map((action) => action.method));
}

export function classifyWriteOutcome(actions: ActionEntry[]): McpLogWriteOutcomeKind | null {
  const hasPublish = actions.some((action) => action.method === "publish_proposal" && actionSucceeded(action));
  const hasWithdraw = actions.some((action) => action.method === "withdraw_proposal" && actionSucceeded(action));
  const hasWrite = fragmentWroteSections(actions);
  const hasCreate = actions.some((action) => action.method === "create_proposal");
  const hasStructural = actions.some((action) => STRUCTURAL_METHODS.has(action.method));
  if (!hasCreate && !hasPublish && !hasWithdraw) return null;
  if (hasWithdraw) return "withdrew";
  if (hasPublish && hasStructural && !hasWrite) return "structural_only_published";
  if (hasPublish) return "wrote_sections_published";
  if (hasCreate) return "never_closed";
  return null;
}

export function classifyReadPattern(methods: Set<string>): McpLogReadPatternKind | null {
  const hasReadDoc = methods.has("read_doc");
  const hasReadSection = methods.has("read_published_section") || methods.has("read_published_sections");
  const hasListDocs = methods.has("list_documents");
  const hasListSections = methods.has("list_sections");
  const hasSearch = methods.has("search_text");
  if (hasListDocs && hasReadDoc) return "listed_documents_then_read_whole";
  if (hasListSections && hasReadSection) return "listed_sections_then_read_section";
  if (hasSearch && hasReadDoc) return "searched_then_read_whole";
  if (hasSearch && hasReadSection) return "searched_then_read_section";
  if (hasReadDoc) return "read_whole_document";
  if (hasReadSection) return "read_section";
  return null;
}

export function foldOneToolSessions(
  acc: Map<string, McpLogOneToolSession>,
  session: SessionRecord,
): void {
  if (!isOneToolSession(session)) return;
  const method = session.actions[0].method;
  const existing = acc.get(method);
  if (existing) {
    existing.session_count++;
  } else {
    acc.set(method, { method, session_count: 1 });
  }
}

export function foldLabeledOutcomes(
  writeAcc: Map<McpLogWriteOutcomeKind, number>,
  readAcc: Map<McpLogReadPatternKind, number>,
  session: SessionRecord,
): void {
  if (session.actions.length === 0) return;
  if (isOneToolSession(session)) return;
  for (const fragment of splitSittingIntoFragments(session.actions)) {
    const methods = methodSet(fragment);
    const writeKind = classifyWriteOutcome(fragment);
    if (writeKind) {
      writeAcc.set(writeKind, (writeAcc.get(writeKind) ?? 0) + 1);
      continue;
    }
    const readKind = classifyReadPattern(methods);
    if (readKind) {
      readAcc.set(readKind, (readAcc.get(readKind) ?? 0) + 1);
    }
  }
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const HEX_ID_RE = /\b[0-9a-fA-F]{16,}\b/g;
const DOC_PATH_RE = /\/[^\s"'<>]*/g;
const QUOTED_RE = /"[^"]*"/g;

export function normalizeMcpLogErrorMessage(message: string): string {
  return message
    .replace(UUID_RE, "<id>")
    .replace(HEX_ID_RE, "<id>")
    .replace(DOC_PATH_RE, "<doc_path>")
    .replace(QUOTED_RE, "<value>");
}

interface ErrorCohortBuilder {
  method: string;
  result: "error" | "blocked";
  cause_template: string;
  instance_count: number;
  sittings_once: number;
  sittings_repeated: number;
  recovered: number;
  unresolved: number;
  abandoned: number;
  agents: Map<string, McpLogErrorAgentRow>;
}

function errorCohortKey(method: string, result: ActionResult, cause: string): string {
  return `${method} ${result} ${cause}`;
}

export function foldErrors(acc: Map<string, ErrorCohortBuilder>, sitting: SessionRecord): void {
  const countInSitting = new Map<string, number>();
  for (let i = 0; i < sitting.actions.length; i++) {
    const action = sitting.actions[i];
    if (action.result !== "error" && action.result !== "blocked") continue;
    const cause = normalizeMcpLogErrorMessage(action.error_message ?? "");
    const key = errorCohortKey(action.method, action.result, cause);

    let outcome: McpLogErrorOutcome = "abandoned";
    for (let j = i + 1; j < sitting.actions.length; j++) {
      if (sitting.actions[j].method !== action.method) continue;
      outcome = sitting.actions[j].result === "ok" ? "recovered" : "unresolved";
    }

    let cohort = acc.get(key);
    if (!cohort) {
      cohort = {
        method: action.method,
        result: action.result,
        cause_template: cause,
        instance_count: 0,
        sittings_once: 0,
        sittings_repeated: 0,
        recovered: 0,
        unresolved: 0,
        abandoned: 0,
        agents: new Map(),
      };
      acc.set(key, cohort);
    }
    cohort.instance_count++;
    cohort[outcome]++;
    countInSitting.set(key, (countInSitting.get(key) ?? 0) + 1);

    let agentRow = cohort.agents.get(sitting.agent_id);
    if (!agentRow) {
      agentRow = {
        agent_id: sitting.agent_id,
        agent_display_name: sitting.agent_display_name,
        instance_count: 0,
        sittings_once: 0,
        sittings_repeated: 0,
        recovered: 0,
        unresolved: 0,
        abandoned: 0,
      };
      cohort.agents.set(sitting.agent_id, agentRow);
    }
    agentRow.agent_display_name = sitting.agent_display_name;
    agentRow.instance_count++;
    agentRow[outcome]++;
  }
  for (const [key, count] of countInSitting) {
    const cohort = acc.get(key);
    if (!cohort) continue;
    if (count === 1) cohort.sittings_once++;
    else cohort.sittings_repeated++;
    const agentRow = cohort.agents.get(sitting.agent_id);
    if (agentRow) {
      if (count === 1) agentRow.sittings_once++;
      else agentRow.sittings_repeated++;
    }
  }
}

function finalizeErrorCohort(builder: ErrorCohortBuilder): McpLogErrorCohort {
  return {
    method: builder.method,
    result: builder.result,
    cause_template: builder.cause_template,
    instance_count: builder.instance_count,
    sittings_once: builder.sittings_once,
    sittings_repeated: builder.sittings_repeated,
    recovered: builder.recovered,
    unresolved: builder.unresolved,
    abandoned: builder.abandoned,
    agents: [...builder.agents.values()].sort((a, b) => b.instance_count - a.instance_count),
  };
}

const ARG_SHAPE_PATTERNS: RegExp[] = [
  /^Refused: /,
  /^Unknown tool: /,
  /^Unknown arguments?: /,
  /has been renamed or removed\./,
  /^Invalid document path: /,
  /^Invalid folder path: /,
  /^Invalid heading level: /,
  /^Invalid path: /,
  /escapes content root/,
  /escapes parent path/,
  /^Document not found: /,
  /^Source document not found: /,
  /does not exist\.?/,
  /^No skeleton found for document: /,
  /is pending deletion in this proposal/,
  /^Missing required parameter/,
  /^Missing tool name in tools\/call params/,
  /^tools\/call arguments must be a JSON object/,
  /must be a non-negative integer/,
  /must be "before" or "after"/,
  /^Invalid status filter/,
];

export function isArgumentShapeFailure(message: string): boolean {
  return ARG_SHAPE_PATTERNS.some((pattern) => pattern.test(message));
}

function argShapeCohortKey(method: string, cause: string, docPath: string | null): string {
  return `${method} ${cause} ${docPath ?? ""}`;
}

export function foldArgShape(acc: Map<string, McpLogArgShapeCohort>, sitting: SessionRecord): void {
  for (const action of sitting.actions) {
    if (action.result !== "error" && action.result !== "blocked") continue;
    const message = action.error_message ?? "";
    if (!isArgumentShapeFailure(message)) continue;
    const cause = normalizeMcpLogErrorMessage(message);
    const docPath = typeof action.metadata.doc_path === "string" ? action.metadata.doc_path : null;
    const key = argShapeCohortKey(action.method, cause, docPath);
    const existing = acc.get(key);
    if (existing) {
      existing.instance_count++;
    } else {
      acc.set(key, {
        method: action.method,
        cause_template: cause,
        doc_path: docPath,
        instance_count: 1,
        sample_error_message: message,
      });
    }
  }
}

interface ToolCountBuilder {
  method: string;
  inferred_tier: InferredMcpTier;
  count: number;
  agents: Map<string, string>;
}

export function foldToolCounts(acc: Map<string, ToolCountBuilder>, sitting: SessionRecord): void {
  for (const action of sitting.actions) {
    let builder = acc.get(action.method);
    if (!builder) {
      builder = {
        method: action.method,
        inferred_tier: inferMcpToolTier(action.method),
        count: 0,
        agents: new Map(),
      };
      acc.set(action.method, builder);
    }
    builder.count++;
    builder.agents.set(sitting.agent_id, sitting.agent_display_name);
  }
}

function finalizeToolCount(builder: ToolCountBuilder): McpLogToolCount {
  const agents: McpLogAgentRef[] = [...builder.agents.entries()]
    .map(([agent_id, agent_display_name]) => ({ agent_id, agent_display_name }))
    .sort(
      (a, b) =>
        a.agent_display_name.localeCompare(b.agent_display_name) ||
        a.agent_id.localeCompare(b.agent_id),
    );
  return {
    method: builder.method,
    inferred_tier: builder.inferred_tier,
    count: builder.count,
    agents,
  };
}

function emptyWriteCounts(): Map<McpLogWriteOutcomeKind, number> {
  return new Map(WRITE_OUTCOME_KINDS.map((kind) => [kind, 0]));
}

function emptyReadCounts(): Map<McpLogReadPatternKind, number> {
  return new Map(READ_PATTERN_KINDS.map((kind) => [kind, 0]));
}

export async function runMcpLogAnalysis(): Promise<RunAdminMcpLogAnalysisResponse> {
  const started = Date.now();

  const writeAcc = emptyWriteCounts();
  const readAcc = emptyReadCounts();
  const oneToolAcc = new Map<string, McpLogOneToolSession>();
  const errorAcc = new Map<string, ErrorCohortBuilder>();
  const argShapeAcc = new Map<string, McpLogArgShapeCohort>();
  const toolCountAcc = new Map<string, ToolCountBuilder>();
  let sessionCount = 0;

  await forEachFlushedSession((session) => {
    if (session.actions.length > 0) sessionCount++;
    foldLabeledOutcomes(writeAcc, readAcc, session);
    foldOneToolSessions(oneToolAcc, session);
    foldErrors(errorAcc, session);
    foldArgShape(argShapeAcc, session);
    foldToolCounts(toolCountAcc, session);
  });

  const write_outcomes: McpLogWriteOutcome[] = WRITE_OUTCOME_KINDS.map((kind) => ({
    kind,
    count: writeAcc.get(kind) ?? 0,
  }));
  const read_patterns: McpLogReadPattern[] = READ_PATTERN_KINDS.map((kind) => ({
    kind,
    count: readAcc.get(kind) ?? 0,
  }));
  const one_tool_sessions = [...oneToolAcc.values()].sort(
    (a, b) => b.session_count - a.session_count,
  );
  const errors = [...errorAcc.values()]
    .map(finalizeErrorCohort)
    .sort((a, b) => b.instance_count - a.instance_count);
  const argShapes = [...argShapeAcc.values()].sort((a, b) => b.instance_count - a.instance_count);
  const toolCounts = [...toolCountAcc.values()]
    .map(finalizeToolCount)
    .sort((a, b) => b.count - a.count);
  const logFile: AgentMcpLogFileInfo = await getActivityLogFileInfo();

  return {
    session_count: sessionCount,
    duration_ms: Date.now() - started,
    write_outcomes,
    read_patterns,
    one_tool_sessions,
    errors,
    arg_shapes: argShapes,
    tool_counts: toolCounts,
    log_file: logFile,
  };
}
