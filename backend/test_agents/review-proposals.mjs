#!/usr/bin/env node
/**
 * Agent: Review Proposals
 *
 * Registers as an agent, lists all proposals, reads each one,
 * and prints a summary report. Useful for monitoring agent activity.
 *
 * Usage:
 *   KS_BASE_URL=http://localhost:3000 node scripts/agents/review-proposals.mjs
 */

import { registerAgent, api, log } from "./lib.mjs";

const PREFIX = "review";

async function main() {
  // 1. Register
  log(PREFIX, "Registering agent...");
  const { accessToken, identity } = await registerAgent("Proposal Reviewer Agent");
  log(PREFIX, `Registered as ${identity.id} (${identity.displayName})`);

  const client = api(accessToken);

  // 2. List all proposals
  log(PREFIX, "Fetching proposals...");
  const { proposals } = await client.get("/api/proposals");
  log(PREFIX, `Found ${proposals.length} proposal(s).`);

  if (proposals.length === 0) {
    log(PREFIX, "No proposals to review. Run create-strategy.mjs and add-campaigns.mjs first.");
    return;
  }

  // 3. Summarize each proposal
  for (const p of proposals) {
    console.log("\n─────────────────────────────────────");
    console.log(`Proposal: ${p.id}`);
    console.log(`  Status:  ${p.status}`);
    console.log(`  Writer:  ${p.writer?.displayName ?? p.writer?.id ?? "unknown"} (${p.writer?.type ?? "?"})`);
    console.log(`  Intent:  ${p.intent}`);
    console.log(`  Created: ${p.created_at}`);

    if (p.sections) {
      console.log(`  Sections (${p.sections.length}):`);
      for (const s of p.sections) {
        const heading = s.heading_path?.length > 0 ? s.heading_path.join(" > ") : "(root)";
        console.log(`    - ${s.doc_path} → ${heading}`);
      }
    }

    if (p.committed_head) {
      console.log(`  Committed SHA: ${p.committed_head}`);
    }
  }

  // 4. Show activity
  console.log("\n─────────────────────────────────────");
  log(PREFIX, "Fetching recent activity...");
  const activity = await client.get("/api/activity?limit=10");
  const items = activity.items ?? activity;
  log(PREFIX, `Recent activity (${Array.isArray(items) ? items.length : 0} items):`);

  if (Array.isArray(items)) {
    for (const item of items) {
      console.log(`  [${item.timestamp}] ${item.author}: ${item.message}`);
    }
  }

  // 5. Show document tree
  console.log("\n─────────────────────────────────────");
  log(PREFIX, "Fetching document tree...");
  const { tree } = await client.get("/api/documents/tree");

  function printTree(entries, indent = 0) {
    for (const entry of entries) {
      const pad = "  ".repeat(indent);
      if (entry.type === "directory") {
        console.log(`${pad}📁 ${entry.name}/`);
        if (Array.isArray(entry.children)) {
          printTree(entry.children, indent + 1);
        }
      } else {
        console.log(`${pad}📄 ${entry.name}`);
      }
    }
  }

  printTree(tree);

  log(PREFIX, "Review complete.");
}

main().catch((err) => {
  throw err;
});
