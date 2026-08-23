import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTestServer, type TestServerContext } from "../helpers/test-server.js";
import {
  createSampleDocument,
  createSampleDocument2,
  SAMPLE_DOC_PATH,
  SAMPLE_DOC_PATH_2,
  SAMPLE_SECTIONS,
} from "../helpers/sample-content.js";
import { gitExec } from "../../storage/git-repo.js";
import { setDocAcl } from "../../auth/acl.js";
import { RoleName } from "../../types/shared.js";

interface McpCallResponse {
  result?: {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  error?: unknown;
}

interface ListedVersion {
  version: string;
  committed_at: string;
}

interface SectionHistoryList {
  doc_path: string;
  heading_path: string[];
  versions: ListedVersion[];
}

// A document name outside ASCII puts non-ASCII bytes in the `.sections`
// directory of every one of its body files, which is where git's default
// path quoting bites.
const NON_ASCII_DOC_PATH = "/ops/стратегия.md";

let activeContext: TestServerContext | null = null;

afterEach(async () => {
  if (activeContext) {
    await activeContext.cleanup();
    activeContext = null;
  }
});

async function createInitializedServer(): Promise<{
  ctx: TestServerContext;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    token?: string,
  ) => Promise<McpCallResponse>;
}> {
  const ctx = await createTestServer();
  activeContext = ctx;

  let sessionId = "";
  const initialized = await request(ctx.app)
    .post("/mcp/tier3")
    .set("Authorization", ctx.agentToken)
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "section-history-test", version: "1.0" },
      },
    });
  sessionId = initialized.headers["mcp-session-id"] ?? "";

  const callTool = async (
    name: string,
    args: Record<string, unknown>,
    token = ctx.agentToken,
  ): Promise<McpCallResponse> => {
    const response = await request(ctx.app)
      .post("/mcp/tier3")
      .set("Authorization", token)
      .set("Content-Type", "application/json")
      .set("Mcp-Session-Id", sessionId)
      .send({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name, arguments: args },
      });
    return response.body;
  };

  return { ctx, callTool };
}

function expectSuccessfulResult(response: McpCallResponse): string {
  expect(response.error, JSON.stringify(response)).toBeUndefined();
  expect(response.result, JSON.stringify(response)).toBeDefined();
  expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
  return response.result!.content[0]!.text;
}

async function commitSectionBody(
  dataRoot: string,
  docPath: string,
  sectionFile: string,
  body: string,
  message: string,
): Promise<void> {
  const bodyPath = path.join(
    dataRoot,
    "content",
    docPath.replace(/^\//, "") + ".sections",
    sectionFile,
  );
  await writeFile(bodyPath, body + "\n", "utf8");
  await gitExec(["add", "-A", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", message,
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

async function deleteSectionBodyAndCommit(
  dataRoot: string,
  docPath: string,
  sectionFile: string,
  message: string,
): Promise<void> {
  await rm(
    path.join(dataRoot, "content", docPath.replace(/^\//, "") + ".sections", sectionFile),
  );
  await gitExec(["add", "-A", "content/"], dataRoot);
  await gitExec(
    [
      "-c", "user.name=Test",
      "-c", "user.email=test@test.local",
      "commit",
      "-m", message,
      "--trailer", "Writer-Type: agent",
    ],
    dataRoot,
  );
}

async function listOverviewHistory(
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpCallResponse>,
  docPath = SAMPLE_DOC_PATH,
  headingPath: string[] = ["Overview"],
): Promise<SectionHistoryList> {
  const response = await callTool("list_section_history", {
    doc_path: docPath,
    heading_path: headingPath,
  });
  return JSON.parse(expectSuccessfulResult(response)) as SectionHistoryList;
}

describe("MCP section history product canaries", () => {
  it("lists exact versions and keeps existing handles stable across body-only publishes", async () => {
    const { ctx, callTool } = await createInitializedServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "First historical overview.",
      "first overview version",
    );
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Second historical overview.",
      "second overview version",
    );

    const firstList = await listOverviewHistory(callTool);
    expect(firstList.doc_path).toBe(SAMPLE_DOC_PATH);
    expect(firstList.heading_path).toEqual(["Overview"]);
    expect(firstList.versions).toHaveLength(3);

    for (const row of firstList.versions) {
      expect(Object.keys(row).sort()).toEqual(["committed_at", "version"]);
      expect(row.version).toMatch(/^[0-9a-f]{16}$/);
      expect(Number.isNaN(Date.parse(row.committed_at))).toBe(false);
    }

    const newestRead = await callTool("read_section_history", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
      version: firstList.versions[0]!.version,
    });
    expect(expectSuccessfulResult(newestRead)).toContain("Second historical overview.");

    const olderRead = await callTool("read_section_history", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Overview"],
      version: firstList.versions[1]!.version,
    });
    expect(expectSuccessfulResult(olderRead)).toContain("First historical overview.");

    const existingHandles = firstList.versions.map((row) => row.version);
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Third historical overview.",
      "third overview version",
    );

    const secondList = await listOverviewHistory(callTool);
    expect(secondList.versions.slice(1).map((row) => row.version)).toEqual(existingHandles);
  });

  it("stops the lineage at a deletion, so no advertised version is unreadable or from the previous file at that path", async () => {
    const { ctx, callTool } = await createInitializedServer();
    await createSampleDocument(ctx.dataCtx.rootDir);
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Content of the section that was later deleted.",
      "edit before deletion",
    );
    await deleteSectionBodyAndCommit(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "delete the overview body",
    );
    // A restore rewrites historical section files under their original names,
    // so the same body path comes back holding unrelated content.
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      SAMPLE_DOC_PATH,
      "overview.md",
      "Content of the section that lives at this path now.",
      "recreate the overview body",
    );

    const list = await listOverviewHistory(callTool);
    expect(list.versions).toHaveLength(1);

    // Every advertised handle must resolve to a stored body: a version whose
    // blob does not exist at its commit breaks the stable-or-dead contract.
    const bodies: string[] = [];
    for (const row of list.versions) {
      const read = await callTool("read_section_history", {
        doc_path: SAMPLE_DOC_PATH,
        heading_path: ["Overview"],
        version: row.version,
      });
      bodies.push(expectSuccessfulResult(read));
    }

    expect(bodies[0]).toContain("Content of the section that lives at this path now.");
    expect(bodies.join("\n")).not.toContain("Content of the section that was later deleted.");
    expect(bodies.join("\n")).not.toContain(SAMPLE_SECTIONS.overview);
  });

  it("serves history for a document whose name is not ASCII", async () => {
    const { ctx, callTool } = await createInitializedServer();
    await createSampleDocument(ctx.dataCtx.rootDir, NON_ASCII_DOC_PATH);
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      NON_ASCII_DOC_PATH,
      "overview.md",
      "Первая версия обзора.",
      "first overview version",
    );
    await commitSectionBody(
      ctx.dataCtx.rootDir,
      NON_ASCII_DOC_PATH,
      "overview.md",
      "Вторая версия обзора.",
      "second overview version",
    );

    const list = await listOverviewHistory(callTool, NON_ASCII_DOC_PATH, ["Overview"]);
    expect(list.versions).toHaveLength(3);

    const newest = await callTool("read_section_history", {
      doc_path: NON_ASCII_DOC_PATH,
      heading_path: ["Overview"],
      version: list.versions[0]!.version,
    });
    expect(expectSuccessfulResult(newest)).toContain("Вторая версия обзора.");

    const oldest = await callTool("read_section_history", {
      doc_path: NON_ASCII_DOC_PATH,
      heading_path: ["Overview"],
      version: list.versions[2]!.version,
    });
    expect(expectSuccessfulResult(oldest)).toContain(SAMPLE_SECTIONS.overview);
  });

  it("stops lineage at the current document boundary and rejects the old document handle", async () => {
    const { ctx, callTool } = await createInitializedServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    const sourceHistory = await listOverviewHistory(callTool);
    const sourceHandle = sourceHistory.versions[0]!.version;

    await createSampleDocument2(ctx.dataCtx.rootDir);
    const destinationSkeleton = path.join(
      ctx.dataCtx.rootDir,
      "content",
      SAMPLE_DOC_PATH_2.replace(/^\//, ""),
    );
    const destinationSections = destinationSkeleton + ".sections";
    const sourceBody = path.join(
      ctx.dataCtx.rootDir,
      "content",
      SAMPLE_DOC_PATH.replace(/^\//, "") + ".sections",
      "overview.md",
    );
    const destinationBody = path.join(destinationSections, "overview.md");

    await writeFile(
      destinationSkeleton,
      [
        "{{section: --before-first-heading--sample.md}}",
        "",
        "## Overview",
        "{{section: overview.md}}",
        "",
      ].join("\n"),
      "utf8",
    );
    await rm(path.join(destinationSections, "principles.md"));
    await rename(sourceBody, destinationBody);
    await gitExec(["add", "-A", "content/"], ctx.dataCtx.rootDir);
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit",
        "-m", "move overview across document boundary",
        "--trailer", "Writer-Type: agent",
      ],
      ctx.dataCtx.rootDir,
    );

    const destinationHistory = await listOverviewHistory(
      callTool,
      SAMPLE_DOC_PATH_2,
      ["Overview"],
    );
    expect(destinationHistory.versions).toHaveLength(1);

    const escapedRead = await callTool("read_section_history", {
      doc_path: SAMPLE_DOC_PATH_2,
      heading_path: ["Overview"],
      version: sourceHandle,
    });
    expect(escapedRead.result?.isError).toBe(true);
    expect(escapedRead.result?.content[0]?.text).toMatch(/not found|re-list/i);
  });

  it("uses the current heading, exposes only minimal inventory fields, and enforces current authorization", async () => {
    const { ctx, callTool } = await createInitializedServer();
    await createSampleDocument(ctx.dataCtx.rootDir);

    const skeletonPath = path.join(
      ctx.dataCtx.rootDir,
      "content",
      SAMPLE_DOC_PATH.replace(/^\//, ""),
    );
    const skeleton = await readFile(skeletonPath, "utf8");
    await writeFile(skeletonPath, skeleton.replace("## Overview", "## Summary"), "utf8");
    await gitExec(["add", "-A", "content/"], ctx.dataCtx.rootDir);
    await gitExec(
      [
        "-c", "user.name=Test",
        "-c", "user.email=test@test.local",
        "commit",
        "-m", "rename Overview to Summary",
        "--trailer", "Writer-Type: agent",
      ],
      ctx.dataCtx.rootDir,
    );

    const list = await listOverviewHistory(callTool, SAMPLE_DOC_PATH, ["Summary"]);
    expect(list.versions.length).toBeGreaterThan(0);
    expect(Object.keys(list.versions[0]!).sort()).toEqual(["committed_at", "version"]);

    const read = await callTool("read_section_history", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Summary"],
      version: list.versions[0]!.version,
    });
    const markdown = expectSuccessfulResult(read);
    expect(markdown.startsWith("## Summary")).toBe(true);
    expect(markdown).toContain(SAMPLE_SECTIONS.overview);
    expect(() => JSON.parse(markdown)).toThrow();

    await setDocAcl(SAMPLE_DOC_PATH, { read: RoleName.of("restricted-team") });
    const denied = await callTool("list_section_history", {
      doc_path: SAMPLE_DOC_PATH,
      heading_path: ["Summary"],
    });
    expect(denied.result?.isError).toBe(true);
    expect(denied.result?.content[0]?.text).toContain("Permission denied");
  });
});
