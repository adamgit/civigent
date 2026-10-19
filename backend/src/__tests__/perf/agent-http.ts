import http from "node:http";
import { DOC_PATH, agentId, mcpSessionId, pad2, sectionHeading } from "./constants.js";
import { HARNESS_DEADLINE_MS } from "./progress.js";
import type { AgentPublishRecord, HttpErrorRecord } from "./transcript.js";

export interface AgentRunResult {
  record: AgentPublishRecord;
  httpError: HttpErrorRecord | null;
  gitError: string | null;
  throwMessage: string | null;
}

function looksLikeGitFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("index.lock") || lower.includes("index lock") || lower.includes("unable to create");
}

async function postTool(
  agent: http.Agent,
  port: number,
  token: string,
  sessionId: string,
  rpcId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/mcp/tier3",
        method: "POST",
        agent,
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as unknown });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function toolText(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const result = (body as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text;
  return typeof text === "string" ? text : null;
}

function jsonRpcErrorMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: { message?: string } }).error;
  return typeof error?.message === "string" ? error.message : null;
}

export async function runAgentPublish(
  port: number,
  token: string,
  agentIndex: number,
  seed: number,
): Promise<AgentRunResult> {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      agent.destroy();
      reject(new Error(`a${pad2(agentIndex)}: ${HARNESS_DEADLINE_MS}ms exceeded`));
    }, HARNESS_DEADLINE_MS);
  });
  const work = runAgentPublishInner(agent, port, token, agentIndex, seed);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    agent.destroy();
  }
}

async function runAgentPublishInner(
  agent: http.Agent,
  port: number,
  token: string,
  agentIndex: number,
  seed: number,
): Promise<AgentRunResult> {
  const id = agentId(agentIndex);
  const sessionId = mcpSessionId(agentIndex);
  const heading = sectionHeading(20 + agentIndex);
  const headingPath = [heading];
  const docPath = DOC_PATH;
  const record: AgentPublishRecord = { agentIndex, publishMs: 0, outcome: "" };
  try {
    const readId = `a${pad2(agentIndex)}-read`;
    const readRes = await postTool(agent, port, token, sessionId, readId, "read_published_sections", {
      sections: [{ doc_path: docPath, heading_path: headingPath }],
    });
    if (readRes.status >= 500) {
      return {
        record,
        httpError: { agentIndex, status: readRes.status, rpcId: readId },
        gitError: null,
        throwMessage: `read_published_sections HTTP ${readRes.status}`,
      };
    }
    const readErr = jsonRpcErrorMessage(readRes.body);
    if (readErr) {
      return { record, httpError: null, gitError: looksLikeGitFailure(readErr) ? readErr : null, throwMessage: readErr };
    }

    const createId = `a${pad2(agentIndex)}-create`;
    const createRes = await postTool(agent, port, token, sessionId, createId, "create_proposal", {
      intent: `AGENT ${id} i${seed}`,
      sections: [{ doc_path: docPath, heading_path: headingPath, content: `AGENT ${id} m${seed}.\n` }],
    });
    if (createRes.status >= 500) {
      return {
        record,
        httpError: { agentIndex, status: createRes.status, rpcId: createId },
        gitError: null,
        throwMessage: `create_proposal HTTP ${createRes.status}`,
      };
    }
    const createErr = jsonRpcErrorMessage(createRes.body);
    if (createErr) {
      return { record, httpError: null, gitError: looksLikeGitFailure(createErr) ? createErr : null, throwMessage: createErr };
    }
    const createText = toolText(createRes.body);
    if (createText === null) {
      return { record, httpError: null, gitError: null, throwMessage: "create_proposal missing text" };
    }
    const created = JSON.parse(createText) as { proposal_id?: string; outcome?: string };
    if (typeof created.proposal_id !== "string") {
      return {
        record: { ...record, outcome: typeof created.outcome === "string" ? created.outcome : "no-proposal-id" },
        httpError: null,
        gitError: null,
        throwMessage: `create_proposal missing proposal_id: ${createText}`,
      };
    }

    const publishId = `a${pad2(agentIndex)}-publish`;
    const t0 = Date.now();
    const publishRes = await postTool(agent, port, token, sessionId, publishId, "publish_proposal", {
      proposal_id: created.proposal_id,
    });
    record.publishMs = Date.now() - t0;
    if (publishRes.status >= 500) {
      return {
        record,
        httpError: { agentIndex, status: publishRes.status, rpcId: publishId },
        gitError: null,
        throwMessage: `publish_proposal HTTP ${publishRes.status}`,
      };
    }
    const publishErr = jsonRpcErrorMessage(publishRes.body);
    if (publishErr) {
      return {
        record,
        httpError: null,
        gitError: looksLikeGitFailure(publishErr) ? publishErr : null,
        throwMessage: publishErr,
      };
    }
    const publishText = toolText(publishRes.body);
    if (publishText === null) {
      return { record, httpError: null, gitError: null, throwMessage: "publish_proposal missing text" };
    }
    if (looksLikeGitFailure(publishText)) {
      return { record, httpError: null, gitError: publishText, throwMessage: publishText };
    }
    const published = JSON.parse(publishText) as { outcome?: string };
    record.outcome = typeof published.outcome === "string" ? published.outcome : publishText;
    return { record, httpError: null, gitError: null, throwMessage: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      record,
      httpError: null,
      gitError: looksLikeGitFailure(message) ? message : null,
      throwMessage: message,
    };
  }
}
