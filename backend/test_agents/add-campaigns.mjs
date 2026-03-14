#!/usr/bin/env node
/**
 * Agent: Add Campaign Ideas
 *
 * Registers as an agent, reads the existing marketing strategy,
 * then proposes new campaign ideas by modifying the Channels section
 * and adding budget details.
 *
 * Assumes the strategy document already exists (run create-strategy.mjs first).
 *
 * Usage:
 *   KS_BASE_URL=http://localhost:3000 node scripts/agents/add-campaigns.mjs
 */

import { registerAgent, mcpClient, log } from "./lib.mjs";

const PREFIX = "add-campaigns";
const DOC_PATH = "marketing/strategy.md";

async function main() {
  // 1. Register
  log(PREFIX, "Registering agent...");
  const { accessToken, identity } = await registerAgent("Campaign Ideas Agent");
  log(PREFIX, `Registered as ${identity.id} (${identity.displayName})`);

  const mcp = mcpClient(accessToken);

  // 2. Initialize MCP session
  log(PREFIX, "Initializing MCP session...");
  await mcp.initialize();

  // 3. Read the current document to understand context
  log(PREFIX, `Reading ${DOC_PATH}...`);
  const doc = await mcp.callTool("read_doc", { doc_path: DOC_PATH });
  const docContent = doc?.content?.[0]?.text ?? "";
  log(PREFIX, `Document length: ${docContent.length} chars`);

  // 4. Read current sections
  log(PREFIX, "Reading document structure...");
  const structure = await mcp.callTool("read_doc_structure", { doc_path: DOC_PATH });
  log(PREFIX, "Sections:", JSON.stringify(structure, null, 2));

  // 5. Read the Budget section to see current content
  log(PREFIX, "Reading Budget section...");
  let budgetContent;
  try {
    const budget = await mcp.callTool("read_section", {
      doc_path: DOC_PATH,
      heading_path: ["Budget"],
    });
    budgetContent = budget?.content?.[0]?.text ?? "";
    log(PREFIX, `Current Budget section: ${budgetContent.length} chars`);
  } catch {
    budgetContent = "";
    log(PREFIX, "Budget section empty or not found.");
  }

  // 6. Create proposal with campaign and budget updates
  log(PREFIX, "Creating proposal with campaign ideas and budget...");
  const proposal = await mcp.callTool("create_proposal", {
    intent: "Add Q1 campaign ideas and budget allocation",
    sections: [
      {
        doc_path: DOC_PATH,
        heading_path: ["Budget"],
        content:
          "### Total Q1 Budget: $150,000\n\n" +
          "| Channel | Allocation | Monthly Spend |\n" +
          "|---------|-----------|---------------|\n" +
          "| Content Marketing | 30% ($45,000) | $15,000 |\n" +
          "| Paid Search (SEM) | 25% ($37,500) | $12,500 |\n" +
          "| Events & Conferences | 20% ($30,000) | $10,000 |\n" +
          "| Social Media Ads | 15% ($22,500) | $7,500 |\n" +
          "| Tools & Analytics | 10% ($15,000) | $5,000 |\n\n" +
          "### Campaign Budgets\n\n" +
          "1. **\"Launch Week\" Campaign** — $25,000\n" +
          "   - Coordinated content blitz across all channels\n" +
          "   - Influencer partnerships and sponsored content\n\n" +
          "2. **Developer Workshop Series** — $15,000\n" +
          "   - Monthly hands-on workshops\n" +
          "   - Recording and repurposing as evergreen content\n\n" +
          "3. **Case Study Sprint** — $10,000\n" +
          "   - 5 customer case studies over 6 weeks\n" +
          "   - Video testimonials and written deep-dives\n",
      },
      {
        doc_path: DOC_PATH,
        heading_path: ["Timeline"],
        content:
          "### January\n\n" +
          "- Week 1-2: Campaign planning and asset preparation\n" +
          "- Week 3-4: Launch \"Launch Week\" campaign\n\n" +
          "### February\n\n" +
          "- Week 1: First Developer Workshop\n" +
          "- Week 2-3: Case Study Sprint begins (interviews)\n" +
          "- Week 4: Mid-quarter review and budget reallocation\n\n" +
          "### March\n\n" +
          "- Week 1-2: Second Developer Workshop + case study publication\n" +
          "- Week 3: Q1 wrap-up campaign\n" +
          "- Week 4: Q1 retrospective and Q2 planning\n",
      },
    ],
  });
  log(PREFIX, "Proposal result:", JSON.stringify(proposal, null, 2));

  // 7. Read the heatmap to see involvement scores
  log(PREFIX, "Checking heatmap...");
  const heatmap = await mcp.callTool("read_doc_structure", { doc_path: DOC_PATH });
  log(PREFIX, "Updated structure:", JSON.stringify(heatmap, null, 2));

  // 8. Clean up
  await mcp.close();
  log(PREFIX, "Done.");
}

main().catch((err) => {
  throw err;
});
