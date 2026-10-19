import { DocPath } from "../../types/shared.js";

export const DOC_PATH = DocPath.parse("/ops/concurrency-20x20.md");
export const HUMAN_COUNT = 20;
export const AGENT_COUNT = 20;
export const HUMAN_TXN_COUNT = 50;

export const SCENARIOS = [
  "humans-disjoint",
  "humans-one-section",
  "agents-disjoint",
  "join-storm",
  "awareness-flood",
  "edit-flood-then-pause",
  "humans-and-agents",
  "join-and-agents",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];
export type BfhFlag = "bfh" | "no-bfh";
export type HumanEditKind = "body" | "split" | "mix";

export interface RunIdentity {
  scenario: ScenarioName;
  seed: number;
  bfh: BfhFlag;
  kind: HumanEditKind;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function sectionHeading(index: number): string {
  return `S${pad2(index)}`;
}

export function sectionFile(index: number): string {
  return `s${pad2(index)}.md`;
}

export function sectionFragmentKey(index: number): string {
  return `section::s${pad2(index)}`;
}

export function humanId(index: number): string {
  return `h${pad2(index)}`;
}

export function agentId(index: number): string {
  return `a${pad2(index)}`;
}

export function mcpSessionId(index: number): string {
  return `mcp-a${pad2(index)}`;
}

export function startingFragmentKey(scenario: ScenarioName, humanIndex: number): string {
  if (scenario === "humans-one-section" || scenario === "edit-flood-then-pause") {
    return sectionFragmentKey(0);
  }
  return sectionFragmentKey(humanIndex);
}

export function scenarioHasHumans(scenario: ScenarioName): boolean {
  return scenario !== "agents-disjoint";
}

export function scenarioHasFlood(scenario: ScenarioName): boolean {
  return (
    scenario === "humans-disjoint" ||
    scenario === "humans-one-section" ||
    scenario === "awareness-flood" ||
    scenario === "edit-flood-then-pause" ||
    scenario === "humans-and-agents"
  );
}

export function scenarioHasAgents(scenario: ScenarioName): boolean {
  return (
    scenario === "agents-disjoint" ||
    scenario === "humans-and-agents" ||
    scenario === "join-and-agents"
  );
}

export function scenarioHasPause(scenario: ScenarioName): boolean {
  return scenarioHasFlood(scenario);
}

export function scenarioSendsAwareness(scenario: ScenarioName): boolean {
  return scenario === "awareness-flood";
}

export function fixtureSectionHeadings(): Set<string> {
  const headings = new Set<string>();
  for (let i = 0; i < 40; i += 1) headings.add(sectionHeading(i));
  return headings;
}
