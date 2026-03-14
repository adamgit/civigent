#!/usr/bin/env node
/**
 * Agent: Create Marketing Strategy
 *
 * Registers as an agent, creates a new marketing strategy document,
 * then adds content to several sections via a proposal.
 *
 * Usage:
 *   KS_BASE_URL=http://localhost:3000 node scripts/agents/create-strategy.mjs
 */

import { registerAgent, api, mcpClient, log } from "./lib.mjs";

const PREFIX = "create-strategy";

async function main() {
  // 1. Register
  log(PREFIX, "Registering agent...");
  const { accessToken, identity } = await registerAgent("Strategy Creator Agent");
  log(PREFIX, `Registered as ${identity.id} (${identity.displayName})`);

  const client = api(accessToken);
  const mcp = mcpClient(accessToken);

  // 2. Initialize MCP session
  log(PREFIX, "Initializing MCP session...");
  await mcp.initialize();

  // 3. Create the document via MCP
  const docPath = "marketing/strategy.md";
  log(PREFIX, `Creating document: ${docPath}`);
  try {
    await mcp.callTool("write_file", {
      path: docPath,
      content: [
        "# Marketing Strategy",
        "",
        "## Overview",
        "",
        "This document outlines our marketing strategy for the current quarter.",
        "",
        "## Target Audience",
        "",
        "Our primary audience segments and their characteristics.",
        "",
        "## Channels",
        "",
        "The marketing channels we plan to use.",
        "",
        "## Budget",
        "",
        "Budget allocation across channels and campaigns.",
        "",
        "## Timeline",
        "",
        "Key milestones and delivery dates.",
        "",
      ].join("\n"),
    });
    log(PREFIX, "Document created successfully.");
  } catch (err) {
    if (err.code === -32000 || String(err.message).includes("exists")) {
      log(PREFIX, "Document already exists, continuing...");
    } else {
      throw err;
    }
  }

  // 4. Read back the document structure
  log(PREFIX, "Reading document structure...");
  const structure = await mcp.callTool("read_doc_structure", { doc_path: docPath });
  log(PREFIX, "Structure:", JSON.stringify(structure, null, 2));

  // 5. Create a proposal to add detailed content
  log(PREFIX, "Creating proposal to add detailed content...");
  const proposal = await mcp.callTool("create_proposal", {
    intent: "Add detailed marketing strategy content for Q1",
    sections: [
      {
        doc_path: docPath,
        heading_path: ["Overview"],
        content:
          "Our Q1 marketing strategy focuses on three pillars:\n" +
          "1. **Brand awareness** — Increase visibility in key markets\n" +
          "2. **Lead generation** — Drive qualified leads through content marketing\n" +
          "3. **Customer retention** — Strengthen relationships with existing customers\n\n" +
          "Success will be measured by a 20% increase in qualified leads and 15% improvement in retention rates.\n",
      },
      {
        doc_path: docPath,
        heading_path: ["Target Audience"],
        content:
          "### Primary Segments\n\n" +
          "- **Enterprise (500+ employees)**: Decision-makers in IT and operations\n" +
          "- **Mid-market (50-500 employees)**: Founders, CTOs, and technical leads\n" +
          "- **Developer community**: Individual contributors evaluating tools\n\n" +
          "### Key Personas\n\n" +
          "- **The Evaluator**: Researches options, creates shortlists, values documentation\n" +
          "- **The Champion**: Internal advocate who pushes for adoption\n" +
          "- **The Decision Maker**: Signs off on budget, wants ROI clarity\n",
      },
      {
        doc_path: docPath,
        heading_path: ["Channels"],
        content:
          "### Digital\n\n" +
          "- Content marketing (blog, whitepapers, case studies)\n" +
          "- Search (SEO + targeted SEM campaigns)\n" +
          "- Social media (LinkedIn, Twitter/X, developer forums)\n\n" +
          "### Events\n\n" +
          "- Industry conferences (2 major, 4 regional)\n" +
          "- Webinar series (monthly deep-dives)\n" +
          "- Community meetups\n\n" +
          "### Partnerships\n\n" +
          "- Technology partner co-marketing\n" +
          "- Analyst relations program\n",
      },
    ],
  });
  log(PREFIX, "Proposal result:", JSON.stringify(proposal, null, 2));

  // 6. Read the final document
  log(PREFIX, "Reading final document...");
  const doc = await mcp.callTool("read_doc", { doc_path: docPath });
  log(PREFIX, "Final document preview (first 500 chars):");
  const content = doc?.content?.[0]?.text ?? JSON.stringify(doc);
  console.log(content.slice(0, 500));

  // 7. Clean up MCP session
  await mcp.close();
  log(PREFIX, "Done.");
}

main().catch((err) => {
  throw err;
});
