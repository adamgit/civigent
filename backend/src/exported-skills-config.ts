import path from "node:path";
import { readEnvVar } from "./env.js";

const DEFAULT_PLUGIN_NAME = "civ";
const DEFAULT_ZIP_NAME = "skills.zip";
const DEFAULT_FOLDER = "/public_skills";

const PLUGIN_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ZIP_NAME_RE = /^[A-Za-z0-9._-]+$/;

export interface ExportedSkillsConfig {
  pluginName: string;
  zipName: string;
  folder: string;
}

function parsePluginName(raw: string): string {
  if (!PLUGIN_NAME_RE.test(raw)) {
    throw new Error(
      `KS_EXPORTEDSKILLS_PLUGIN_NAME must be lowercase kebab-case with no spaces (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function parseZipName(raw: string): string {
  if (raw.includes("/") || !ZIP_NAME_RE.test(raw)) {
    throw new Error(
      `KS_EXPORTEDSKILLS_ZIP_NAME must be a single path segment matching [A-Za-z0-9._-]+ (got ${JSON.stringify(raw)})`,
    );
  }
  return raw;
}

function parseFolder(raw: string): string {
  const slashNormalized = raw.replaceAll("\\", "/").trim();
  if (slashNormalized.length === 0) {
    throw new Error(
      `KS_EXPORTEDSKILLS_FOLDER must be a normalized content-tree path with a leading / and no trailing / (got ${JSON.stringify(raw)})`,
    );
  }
  const withLeadingSlash = slashNormalized.startsWith("/") ? slashNormalized : `/${slashNormalized}`;
  const normalized = path.posix.normalize(withLeadingSlash);
  if (
    normalized === "/" ||
    normalized === "." ||
    normalized === "" ||
    !normalized.startsWith("/") ||
    normalized.includes("/../") ||
    normalized === "/.." ||
    normalized.endsWith("/")
  ) {
    throw new Error(
      `KS_EXPORTEDSKILLS_FOLDER must be a normalized content-tree path with a leading / and no trailing / (got ${JSON.stringify(raw)})`,
    );
  }
  return normalized;
}

let cached: ExportedSkillsConfig | null = null;

export function getExportedSkillsConfig(): ExportedSkillsConfig {
  if (cached) return cached;
  const pluginName = parsePluginName(readEnvVar("KS_EXPORTEDSKILLS_PLUGIN_NAME", DEFAULT_PLUGIN_NAME));
  const zipName = parseZipName(readEnvVar("KS_EXPORTEDSKILLS_ZIP_NAME", DEFAULT_ZIP_NAME));
  const folder = parseFolder(readEnvVar("KS_EXPORTEDSKILLS_FOLDER", DEFAULT_FOLDER));
  cached = { pluginName, zipName, folder };
  return cached;
}
