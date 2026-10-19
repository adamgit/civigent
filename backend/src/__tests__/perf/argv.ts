import {
  SCENARIOS,
  type BfhFlag,
  type HumanEditKind,
  type RunIdentity,
  type ScenarioName,
} from "./constants.js";

const SCENARIO_SET = new Set<string>(SCENARIOS);
const BFH_SET = new Set<string>(["bfh", "no-bfh"]);
const KIND_SET = new Set<string>(["body", "split", "mix"]);
const SEED_RE = /^(0|[1-9]\d*)$/;

function positionalFromArgv(argv: readonly string[]): string[] | null {
  const sep = argv.indexOf("--");
  if (sep === -1) return null;
  return argv.slice(sep + 1);
}

function positionalFromWorkerEnv(env: NodeJS.ProcessEnv): string[] | null {
  const raw = env.CIVIGENT_20X20_ARGV;
  if (raw === undefined || raw === "") return null;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`concurrency-20x20: CIVIGENT_20X20_ARGV is not a JSON string array: ${raw}`);
  }
  return parsed;
}

export function parseHarnessArgv(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): RunIdentity {
  const positional = positionalFromArgv(argv) ?? positionalFromWorkerEnv(env);
  if (positional === null) {
    throw new Error("concurrency-20x20: missing `--` followed by scenario seed bfh kind");
  }
  if (positional.length !== 4) {
    throw new Error(
      `concurrency-20x20: expected 4 args after -- (scenario seed bfh kind), got ${positional.length}: ${JSON.stringify(positional)}`,
    );
  }
  const [scenarioRaw, seedRaw, bfhRaw, kindRaw] = positional;
  if (!SCENARIO_SET.has(scenarioRaw)) {
    throw new Error(`concurrency-20x20: invalid scenario ${JSON.stringify(scenarioRaw)}`);
  }
  if (!SEED_RE.test(seedRaw)) {
    throw new Error(`concurrency-20x20: seed must be a non-negative decimal integer, got ${JSON.stringify(seedRaw)}`);
  }
  const seed = Number.parseInt(seedRaw, 10);
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new Error(`concurrency-20x20: seed is not a safe non-negative integer: ${JSON.stringify(seedRaw)}`);
  }
  if (!BFH_SET.has(bfhRaw)) {
    throw new Error(`concurrency-20x20: BFH flag must be bfh or no-bfh, got ${JSON.stringify(bfhRaw)}`);
  }
  if (!KIND_SET.has(kindRaw)) {
    throw new Error(`concurrency-20x20: kind must be body, split, or mix, got ${JSON.stringify(kindRaw)}`);
  }
  return {
    scenario: scenarioRaw as ScenarioName,
    seed,
    bfh: bfhRaw as BfhFlag,
    kind: kindRaw as HumanEditKind,
  };
}
