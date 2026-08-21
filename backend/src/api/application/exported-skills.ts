import path from "node:path";
import { getExportedSkillsConfig } from "../../exported-skills-config.js";
import { getPublicUrl } from "../../auth/oauth-config.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import { authorizeDocRead } from "../../auth/authorized-read.js";
import { DocPath } from "../../types/shared.js";
import {
  DocumentsTreePathNotFoundError,
  browseFolderExistsOnDisk,
  readDocumentsTreeUnfiltered,
} from "../../storage/documents-tree.js";
import { getContentGitPrefix, getDataRoot } from "../../storage/data-root.js";
import { getTreeShaAtHead } from "../../storage/git-repo.js";
import { directoryExists } from "../../storage/fs-primitives.js";
import { assertChildPath } from "../../storage/path-utils.js";

export class ExportedSkillsFolderAbsentError extends Error {
  constructor(folder: string) {
    super(`Exported skills folder is absent: ${folder}`);
    this.name = "ExportedSkillsFolderAbsentError";
  }
}

export interface ExportedSkillCommand {
  commandName: string;
  body: string;
}

export interface ExportedSkillEntry {
  dirName: string;
  body: string;
}

export interface ExportedSkillsListing {
  commands: ExportedSkillCommand[];
  skills: ExportedSkillEntry[];
}

const COMMAND_DESCRIPTION_MAX_LENGTH = 200;

function sanitizeCommandName(basenameSansMd: string): string {
  const lowered = basenameSansMd.trim().toLowerCase();
  const kebab = lowered
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return kebab.length > 0 ? kebab : "command";
}

function uniquifyNames(rawNames: string[]): string[] {
  const used = new Map<string, number>();
  return rawNames.map((name) => {
    const count = used.get(name) ?? 0;
    used.set(name, count + 1);
    if (count === 0) return name;
    return `${name}-${count + 1}`;
  });
}

function folderGitPath(folder: string): string {
  const relative = folder.replace(/^\/+/, "");
  return `${getContentGitPrefix()}/${relative}`;
}

function commandTriggerDescription(commandName: string, pluginName: string): string {
  const spokenName = commandName.replace(/[-_]+/g, " ");
  const nameTriggers = spokenName === commandName
    ? `"${commandName}"`
    : `"${commandName}" or "${spokenName}"`;
  const candidates = [
    `Use when the user says ${nameTriggers}, invokes "/${pluginName}:${commandName}", or asks to run the ${spokenName} command. A bare "${commandName}" always means run this skill.`,
    `Use when the user says ${nameTriggers} or asks to run the ${spokenName} command. A bare "${commandName}" always means run this skill.`,
    `Use when the user says "${commandName}" or explicitly asks to run this command.`,
    "Use when the user explicitly asks to run this command.",
  ];
  return candidates.find((candidate) => candidate.length <= COMMAND_DESCRIPTION_MAX_LENGTH)!;
}

function commandBodyWithDescription(body: string, commandName: string, pluginName: string): string {
  const descriptionLine = `description: ${JSON.stringify(commandTriggerDescription(commandName, pluginName))}`;
  const lines = body.split(/\r?\n/);

  if (lines[0]?.trim() === "---") {
    const closingIndex = lines.findIndex(
      (line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."),
    );
    if (closingIndex > 0) {
      const hasDescription = lines
        .slice(1, closingIndex)
        .some((line) => /^description\s*:/i.test(line));
      if (hasDescription) return body;

      lines.splice(1, 0, descriptionLine);
      return lines.join("\n");
    }
  }

  return `---\n${descriptionLine}\n---\n\n${body}`;
}

export async function folderExistsOnDisk(folder?: string): Promise<boolean> {
  const target = folder ?? getExportedSkillsConfig().folder;
  return browseFolderExistsOnDisk(target);
}

export async function getExportedSkillsTreeSha(folder?: string): Promise<string | null> {
  const target = folder ?? getExportedSkillsConfig().folder;
  return getTreeShaAtHead(getDataRoot(), folderGitPath(target));
}

export async function listExportedSkillsContent(): Promise<ExportedSkillsListing> {
  const { folder } = getExportedSkillsConfig();

  if (!(await folderExistsOnDisk(folder))) {
    throw new ExportedSkillsFolderAbsentError(folder);
  }

  let topLevel;
  try {
    topLevel = await readDocumentsTreeUnfiltered(folder, false);
  } catch (error) {
    if (error instanceof DocumentsTreePathNotFoundError) {
      throw new ExportedSkillsFolderAbsentError(folder);
    }
    throw error;
  }

  const mdFiles = topLevel.filter((entry) => entry.type === "file" && entry.name.endsWith(".md"));
  const commandNames = uniquifyNames(
    mdFiles.map((entry) => sanitizeCommandName(entry.name.slice(0, -".md".length))),
  );
  const commands: ExportedSkillCommand[] = [];
  for (let i = 0; i < mdFiles.length; i++) {
    const entry = mdFiles[i]!;
    const body = await readAssembledDocument(await authorizeDocRead(null, DocPath.parse(entry.path)));
    commands.push({ commandName: commandNames[i]!, body });
  }

  const childDirs = topLevel.filter((entry) => entry.type === "directory");
  const skills: ExportedSkillEntry[] = [];
  for (const dir of childDirs) {
    const skillPath = `${dir.path}/SKILL.md`;
    try {
      const body = await readAssembledDocument(await authorizeDocRead(null, DocPath.parse(skillPath)));
      skills.push({ dirName: dir.name, body });
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        continue;
      }
      throw error;
    }
  }

  return { commands, skills };
}

export interface ExportedSkillsZipResult {
  stream: NodeJS.ReadableStream;
  version: string;
}

export async function buildExportedSkillsZip(): Promise<ExportedSkillsZipResult> {
  const config = getExportedSkillsConfig();
  const version = await getExportedSkillsTreeSha(config.folder);
  if (version == null) {
    throw new ExportedSkillsFolderAbsentError(config.folder);
  }

  const listing = await listExportedSkillsContent();
  const { ZipFile } = await import("yazl");
  const zipFile = new ZipFile();

  const host = new URL(getPublicUrl()).host;
  const pluginJson = {
    name: config.pluginName,
    description: `Civigent exported skills (${host})`,
    version,
    author: { name: "Civigent" },
  };
  zipFile.addBuffer(Buffer.from(`${JSON.stringify(pluginJson, null, 2)}\n`, "utf8"), ".claude-plugin/plugin.json");

  for (const command of listing.commands) {
    const body = commandBodyWithDescription(command.body, command.commandName, config.pluginName);
    zipFile.addBuffer(Buffer.from(body, "utf8"), `commands/${command.commandName}.md`);
  }
  for (const skill of listing.skills) {
    zipFile.addBuffer(Buffer.from(skill.body, "utf8"), `skills/${skill.dirName}/SKILL.md`);
  }

  zipFile.end();
  return { stream: zipFile.outputStream, version };
}
