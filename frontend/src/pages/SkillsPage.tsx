import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { SharedPageHeader } from "../components/SharedPageHeader";
import { ContentPanel } from "../components/ContentPanel";
import type { AppLayoutOutletContext } from "../app/AppLayout";
import { docHref, folderHref } from "../app/docs-location";
import { apiClient } from "../services/api-client";
import { copyTextToClipboard } from "../utils/copy-text";
import type { AdminConfig, DocumentTreeEntry } from "../types/shared.js";
import { DocPath, FolderPath } from "../types/shared.js";

type SkillKind = "slash-command" | "agent-skill";
type InstallClient = "claude-code" | "claude-ai";

interface CatalogEntry {
  kind: SkillKind;
  name: string;
  docPath: string;
}

const BARE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function findFolderEntry(entries: DocumentTreeEntry[], folderPath: string): DocumentTreeEntry | null {
  const stack = [...entries];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.path === folderPath && node.type === "directory") {
      return node;
    }
    if (node.type === "directory" && Array.isArray(node.children)) {
      stack.push(...node.children);
    }
  }
  return null;
}

function buildCatalog(folder: DocumentTreeEntry | null): CatalogEntry[] {
  if (!folder || !Array.isArray(folder.children)) return [];
  const entries: CatalogEntry[] = [];

  for (const child of folder.children) {
    if (child.type === "file" && child.name.toLowerCase().endsWith(".md")) {
      entries.push({
        kind: "slash-command",
        name: child.name.slice(0, -".md".length),
        docPath: child.path,
      });
      continue;
    }
    if (child.type === "directory") {
      const skillMd = (child.children ?? []).find(
        (c) => c.type === "file" && c.name === "SKILL.md",
      );
      if (skillMd) {
        entries.push({
          kind: "agent-skill",
          name: child.name,
          docPath: skillMd.path,
        });
      }
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function agentSkillTemplate(name: string): string {
  return `---
name: ${name}
description: Describe what this skill does and when Claude should use it
---

`;
}

function slashCommandTemplate(name: string): string {
  const spokenName = name.replace(/[-_]+/g, " ");
  const nameTriggers = spokenName === name
    ? `"${name}"`
    : `"${name}" or "${spokenName}"`;
  const detailedDescription = `Use when the user says ${nameTriggers} or asks to run the ${spokenName} command.`;
  const description = detailedDescription.length <= 200
    ? detailedDescription
    : `Use when the user explicitly asks to run the "${name.slice(0, 140)}" command.`;
  return `---
description: ${description}
---

`;
}

function validateBareName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "Enter a skill name.";
  if (name.includes("/") || name.includes("\\")) {
    return "Use a bare name only — no slashes.";
  }
  if (!BARE_NAME_RE.test(name)) {
    return "Name must start with a letter or digit and contain only letters, digits, hyphens, or underscores.";
  }
  return null;
}

export function SkillsPage() {
  const navigate = useNavigate();
  const { entries, treeLoading, refreshTree } = useOutletContext<AppLayoutOutletContext>();
  const [adminConfig, setAdminConfig] = useState<AdminConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [installCopied, setInstallCopied] = useState(false);
  const [installClient, setInstallClient] = useState<InstallClient>("claude-code");
  const [skillName, setSkillName] = useState("");
  const [skillKind, setSkillKind] = useState<SkillKind>("slash-command");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .getAdminConfig()
      .then((cfg) => {
        setAdminConfig(cfg);
        setConfigError(null);
      })
      .catch((err) => {
        setConfigError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const folder = adminConfig?.exportedSkills.folder ?? "/public_skills";
  const folderEntry = useMemo(() => findFolderEntry(entries, folder), [entries, folder]);
  const catalog = useMemo(() => buildCatalog(folderEntry), [folderEntry]);
  const installCommand = adminConfig
    ? `claude --plugin-url ${adminConfig.exportedSkills.plugin_url}`
    : null;
  const zipPath = adminConfig?.exportedSkills.zip_path ?? null;

  const handleCopyInstall = async () => {
    if (!installCommand) return;
    const didCopy = await copyTextToClipboard(installCommand);
    if (!didCopy) return;
    setInstallCopied(true);
    setTimeout(() => setInstallCopied(false), 2000);
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (creating) return;

    const validationError = validateBareName(skillName);
    if (validationError) {
      setCreateError(validationError);
      return;
    }

    const name = skillName.trim();
    const baseFolder = folder.replace(/\/+$/, "");
    const docPath =
      skillKind === "slash-command"
        ? DocPath.parse(`${baseFolder}/${name}.md`)
        : DocPath.parse(`${baseFolder}/${name}/SKILL.md`);

    setCreating(true);
    setCreateError(null);
    try {
      if (skillKind === "agent-skill") {
        await apiClient.createDocument(docPath, agentSkillTemplate(name));
      } else {
        await apiClient.createDocument(docPath, slashCommandTemplate(name));
      }
      await refreshTree();
      navigate(docHref(docPath));
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const createForm = (prominent: boolean) => (
    <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-3">
      {prominent ? (
        <div>
          <h2 className="font-[family-name:var(--font-body)] text-lg font-medium text-text-primary m-0 mb-1">
            Create your first skill
          </h2>
          <p className="text-[13px] text-text-secondary m-0 leading-relaxed">
            Choose a short name, then pick whether this is a slash command or an agent skill.
          </p>
        </div>
      ) : (
        <h3 className="text-[13px] font-semibold text-text-primary m-0">Add a skill</h3>
      )}

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
        <input
          type="text"
          value={skillName}
          onChange={(e) => setSkillName(e.target.value)}
          placeholder="skill-name"
          className="input-field min-w-0 flex-1"
          disabled={creating}
          aria-label="Skill name"
          autoComplete="off"
          spellCheck={false}
        />
        <select
          value={skillKind}
          onChange={(e) => setSkillKind(e.target.value as SkillKind)}
          className="input-field sm:w-[11rem]"
          disabled={creating}
          aria-label="Skill type"
        >
          <option value="slash-command">Slash command</option>
          <option value="agent-skill">Agent skill</option>
        </select>
        <button type="submit" className="btn-primary shrink-0" disabled={creating}>
          {creating ? "Creating…" : "Create"}
        </button>
      </div>

      <p className="text-[11px] text-text-muted m-0 leading-relaxed">
        {skillKind === "slash-command" ? (
          <>
            Creates <code className="font-mono text-accent-text">{folder}/{skillName.trim() || "name"}.md</code>{" "}
            with a trigger description for Claude (customize it with aliases; maximum 200 characters)
          </>
        ) : (
          <>
            Creates{" "}
            <code className="font-mono text-accent-text">
              {folder}/{skillName.trim() || "name"}/SKILL.md
            </code>{" "}
            with a standard agent-skill header
          </>
        )}
      </p>

      {createError ? <p className="text-error m-0">{createError}</p> : null}
    </form>
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <SharedPageHeader title="Skills" />
      <div
        className="flex-1 min-h-0 overflow-auto p-4 md:px-6"
        style={{ fontFamily: "var(--font-ui)" }}
      >
        <div className="max-w-[720px] mx-auto flex flex-col gap-4">
          <ContentPanel>
            <ContentPanel.Body>
              <p className="text-[14px] text-text-primary leading-relaxed m-0">
                Documents in{" "}
                <code className="font-mono text-[13px] px-1.5 py-0.5 rounded bg-accent-light text-accent-text">
                  {folder}
                </code>{" "}
                are exported as a Claude plugin. Top-level markdown files become slash commands; folders that
                contain a <code className="font-mono text-[12px]">SKILL.md</code> become agent skills.
              </p>
            </ContentPanel.Body>
          </ContentPanel>

          <ContentPanel>
            <ContentPanel.Header className="flex-wrap gap-2">
              <div>
                {installClient === "claude-code" ? (
                  <>
                    <ContentPanel.Title>Start Claude Code with these skills</ContentPanel.Title>
                    <ContentPanel.Subtitle>
                      Use this instead of plain <code className="font-mono">claude</code> whenever you want
                      the skills loaded. Claude fetches the plugin for that session only.
                    </ContentPanel.Subtitle>
                  </>
                ) : (
                  <>
                    <ContentPanel.Title>Upload this as a plugin on Claude.ai</ContentPanel.Title>
                    <ContentPanel.Subtitle>Customize → Plugins.</ContentPanel.Subtitle>
                  </>
                )}
              </div>
              <div
                role="tablist"
                aria-label="Install client"
                className="flex gap-1 shrink-0"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={installClient === "claude-code"}
                  className={`px-2.5 py-1.5 text-[13px] bg-transparent border-0 border-b-2 cursor-pointer whitespace-nowrap ${
                    installClient === "claude-code"
                      ? "border-accent text-accent font-semibold"
                      : "border-transparent text-text-secondary font-normal"
                  }`}
                  onClick={() => setInstallClient("claude-code")}
                >
                  Claude Code
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={installClient === "claude-ai"}
                  className={`px-2.5 py-1.5 text-[13px] bg-transparent border-0 border-b-2 cursor-pointer whitespace-nowrap ${
                    installClient === "claude-ai"
                      ? "border-accent text-accent font-semibold"
                      : "border-transparent text-text-secondary font-normal"
                  }`}
                  onClick={() => setInstallClient("claude-ai")}
                >
                  Claude.ai
                </button>
              </div>
            </ContentPanel.Header>
            <ContentPanel.Body>
              {configError ? (
                <p className="text-error m-0">{configError}</p>
              ) : installClient === "claude-code" ? (
                !installCommand ? (
                  <p className="text-[13px] text-text-muted m-0">Loading launch command…</p>
                ) : (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <code className="font-mono text-[12px] sm:text-[13px] text-text-primary bg-section-hover border border-footer-border rounded-md px-3 py-2.5 flex-1 min-w-0 break-all">
                      {installCommand}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyInstall()}
                      className="btn-secondary shrink-0"
                    >
                      {installCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                )
              ) : !zipPath ? (
                <p className="text-[13px] text-text-muted m-0">Loading…</p>
              ) : (
                <div className="flex flex-col gap-3">
                  <a href={zipPath} download className="btn-secondary no-underline self-start">
                    Download zip
                  </a>
                  <p className="text-[13px] text-text-secondary m-0 leading-relaxed">
                    Re-upload after you publish changes.
                  </p>
                </div>
              )}
            </ContentPanel.Body>
          </ContentPanel>

          {treeLoading && !folderEntry ? (
            <p className="text-[13px] text-text-muted px-1">Loading skills…</p>
          ) : catalog.length === 0 ? (
            <ContentPanel>
              <ContentPanel.Body>{createForm(true)}</ContentPanel.Body>
            </ContentPanel>
          ) : (
            <>
              <ContentPanel>
                <ContentPanel.Header>
                  <div className="flex items-start justify-between gap-3 w-full flex-wrap">
                    <div>
                      <ContentPanel.Title>Skills catalog</ContentPanel.Title>
                      <ContentPanel.Subtitle>
                        {catalog.length} skill{catalog.length === 1 ? "" : "s"} in {folder}
                      </ContentPanel.Subtitle>
                    </div>
                    <Link
                      to={folderHref(FolderPath.parse(folder))}
                      className="text-[12px] text-accent hover:underline shrink-0"
                    >
                      Open folder →
                    </Link>
                  </div>
                </ContentPanel.Header>
                <ul className="list-none m-0 p-0">
                  {catalog.map((entry) => (
                    <li
                      key={entry.docPath}
                      className="border-b border-footer-border last:border-0"
                    >
                      <Link
                        to={docHref(DocPath.parse(entry.docPath))}
                        className="flex items-center gap-3 px-4 py-3 no-underline hover:bg-section-hover transition-colors"
                      >
                        <span
                          className={`text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded shrink-0 ${
                            entry.kind === "slash-command"
                              ? "bg-accent-light text-accent-text"
                              : "bg-agent-light text-agent-text"
                          }`}
                        >
                          {entry.kind === "slash-command" ? "slash" : "agent"}
                        </span>
                        <span className="text-[14px] font-medium text-text-primary min-w-0 truncate">
                          {entry.name}
                        </span>
                        <span className="ml-auto text-[11px] text-text-muted font-mono truncate hidden sm:inline">
                          {entry.docPath}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </ContentPanel>

              <ContentPanel>
                <ContentPanel.Body>{createForm(false)}</ContentPanel.Body>
              </ContentPanel>
            </>
          )}

          <ContentPanel>
            <ContentPanel.Body>
              <p className="text-[13px] text-text-secondary leading-relaxed m-0">
                Publish a skill before it appears in the zip. For Claude Code, start a new session or run{" "}
                <code className="font-mono text-[12px]">/reload-plugins</code>. For Claude.ai, upload the zip again.
              </p>
            </ContentPanel.Body>
          </ContentPanel>
        </div>
      </div>
    </div>
  );
}
