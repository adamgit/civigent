import path from "node:path";
import { getExportedSkillsConfig } from "../../exported-skills-config.js";
import { getPublicUrl } from "../../auth/oauth-config.js";
import { readAssembledDocument, DocumentNotFoundError } from "../../storage/document-reader.js";
import {
  DocumentsTreePathNotFoundError,
  browseFolderPathToContentRelativeFsPath,
  readDocumentsTree,
} from "../../storage/documents-tree.js";
import { getContentGitPrefix, getContentRoot, getDataRoot } from "../../storage/data-root.js";
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

export async function folderExistsOnDisk(folder?: string): Promise<boolean> {
  const target = folder ?? getExportedSkillsConfig().folder;
  const relative = browseFolderPathToContentRelativeFsPath(target);
  const absolute = assertChildPath(getContentRoot(), path.join(getContentRoot(), relative));
  return directoryExists(absolute);
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
    topLevel = await readDocumentsTree(folder, false);
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
    const body = await readAssembledDocument(entry.path);
    commands.push({ commandName: commandNames[i]!, body });
  }

  const childDirs = topLevel.filter((entry) => entry.type === "directory");
  const skills: ExportedSkillEntry[] = [];
  for (const dir of childDirs) {
    const skillPath = `${dir.path}/SKILL.md`;
    try {
      const body = await readAssembledDocument(skillPath);
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
    zipFile.addBuffer(Buffer.from(command.body, "utf8"), `commands/${command.commandName}.md`);
  }
  for (const skill of listing.skills) {
    zipFile.addBuffer(Buffer.from(skill.body, "utf8"), `skills/${skill.dirName}/SKILL.md`);
  }

  zipFile.end();
  return { stream: zipFile.outputStream, version };
}
