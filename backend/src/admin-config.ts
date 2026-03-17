import type { AdminConfig, GovernanceMode, HumanHumanInvolvementPresetName } from "./types/shared.js";
import { HUMAN_INVOLVEMENT_PRESETS } from "./types/shared.js";

const DEFAULT_HUMAN_INVOLVEMENT_PRESET: HumanHumanInvolvementPresetName = "eager";
const DEFAULT_SNAPSHOT_ENABLED = true;
const DEFAULT_GOVERNANCE_MODE: GovernanceMode = "available";

export class AdminConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminConfigValidationError";
  }
}

function parsePreset(raw: string | undefined): HumanHumanInvolvementPresetName {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "yolo" || normalized === "aggressive" || normalized === "eager" || normalized === "conservative") {
    return normalized;
  }
  return DEFAULT_HUMAN_INVOLVEMENT_PRESET;
}

function parseGovernanceMode(raw: string | undefined): GovernanceMode {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (normalized === "available" || normalized === "forced") return normalized;
  return DEFAULT_GOVERNANCE_MODE;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim().length === 0) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off" && normalized !== "no";
}

interface RuntimeConfig {
  humanInvolvement_preset: HumanHumanInvolvementPresetName;
  snapshot_enabled: boolean;
}

const initialConfig: RuntimeConfig = {
  humanInvolvement_preset: parsePreset(process.env.KS_INVOLVEMENT_PRESET),
  snapshot_enabled: parseBoolean(process.env.KS_SNAPSHOT_ENABLED, DEFAULT_SNAPSHOT_ENABLED),
};

let runtimeConfig: RuntimeConfig = { ...initialConfig };

export function getAdminConfig(): AdminConfig {
  const preset = HUMAN_INVOLVEMENT_PRESETS[runtimeConfig.humanInvolvement_preset];
  return {
    humanInvolvement_preset: runtimeConfig.humanInvolvement_preset,
    humanInvolvement_midpoint_seconds: preset.midpoint_seconds,
    humanInvolvement_steepness: preset.steepness,
    snapshot_enabled: runtimeConfig.snapshot_enabled,
    governance_mode: parseGovernanceMode(process.env.KS_GOVERNANCE_MODE),
  };
}

export function getHumanHumanInvolvementPreset(): HumanHumanInvolvementPresetName {
  return runtimeConfig.humanInvolvement_preset;
}

export function updateAdminConfig(next: Partial<AdminConfig>): AdminConfig {
  if (next.humanInvolvement_preset != null) {
    const valid: HumanHumanInvolvementPresetName[] = ["yolo", "aggressive", "eager", "conservative"];
    if (!valid.includes(next.humanInvolvement_preset)) {
      throw new AdminConfigValidationError(
        `Invalid humanInvolvement_preset: ${next.humanInvolvement_preset}. Must be one of: ${valid.join(", ")}`,
      );
    }
    runtimeConfig.humanInvolvement_preset = next.humanInvolvement_preset;
  }

  if (next.snapshot_enabled != null) {
    if (typeof next.snapshot_enabled !== "boolean") {
      throw new AdminConfigValidationError("snapshot_enabled must be a boolean.");
    }
    runtimeConfig.snapshot_enabled = next.snapshot_enabled;
  }

  return getAdminConfig();
}

export function resetAdminConfig(): void {
  runtimeConfig = { ...initialConfig };
}
