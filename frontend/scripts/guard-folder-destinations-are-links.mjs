import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function selfClosingUsages(source, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[\\s\\S]*?/>`, "g");
  return source.match(pattern) ?? [];
}

async function main() {
  const folderCardPath = path.join(projectRoot, "src/components/folder-details/FolderCard.tsx");
  const folderFileRowPath = path.join(projectRoot, "src/components/folder-details/FolderFileRow.tsx");
  const folderPagePath = path.join(projectRoot, "src/pages/FolderPage.tsx");

  const folderCard = await readFile(folderCardPath, "utf8");
  const folderFileRow = await readFile(folderFileRowPath, "utf8");
  const folderPage = await readFile(folderPagePath, "utf8");

  assert(
    folderCard.includes('from "react-router-dom"') && /\bLink\b/.test(folderCard),
    "FolderCard.tsx must import Link from react-router-dom.",
  );
  assert(
    /interface FolderCardProps \{[\s\S]*?\bto:\s*string;/.test(folderCard),
    "FolderCardProps must take `to: string` — a destination URL, not a click handler.",
  );
  assert(
    !/interface FolderCardProps \{[\s\S]*?\bonClick\s*:/.test(folderCard),
    "FolderCardProps must not take onClick. A folder card is a link.",
  );
  assert(
    /return \(\s*<Link\b/.test(folderCard),
    "FolderCard must render <Link> as its outer element (a real href). Do not use <button onClick={navigate}>.",
  );

  assert(
    folderFileRow.includes('from "react-router-dom"') && /\bLink\b/.test(folderFileRow),
    "FolderFileRow.tsx must import Link from react-router-dom.",
  );
  assert(
    /interface FolderFileRowProps \{[\s\S]*?\bto:\s*string;/.test(folderFileRow),
    "FolderFileRowProps must take `to: string` — a destination URL, not a click handler.",
  );
  assert(
    !/interface FolderFileRowProps \{[\s\S]*?\bonClick\s*:/.test(folderFileRow),
    "FolderFileRowProps must not take onClick. A file row is a link.",
  );
  assert(
    /return \(\s*<Link\b/.test(folderFileRow),
    "FolderFileRow must render <Link> as its outer element (a real href). Do not use <button onClick={navigate}>.",
  );

  const folderCardUsages = selfClosingUsages(folderPage, "FolderCard");
  assert(folderCardUsages.length > 0, "FolderPage.tsx must render FolderCard.");
  for (const usage of folderCardUsages) {
    assert(/\bto=\{/.test(usage), "FolderPage FolderCard usage must pass `to={...}`.");
    assert(!/\bonClick=/.test(usage), "FolderPage FolderCard usage must not pass onClick.");
  }

  const folderFileRowUsages = selfClosingUsages(folderPage, "FolderFileRow");
  assert(folderFileRowUsages.length > 0, "FolderPage.tsx must render FolderFileRow.");
  for (const usage of folderFileRowUsages) {
    assert(/\bto=\{/.test(usage), "FolderPage FolderFileRow usage must pass `to={...}`.");
    assert(!/\bonClick=/.test(usage), "FolderPage FolderFileRow usage must not pass onClick.");
  }

  assert(
    !/function FolderPathBreadcrumb\([\s\S]*?\bonNavigate\b/.test(folderPage),
    "FolderPathBreadcrumb must not take onNavigate. Ancestor segments are <Link to> elements.",
  );
  assert(
    /function FolderPathBreadcrumb[\s\S]*?<Link\b[\s\S]*?folderHref\(FolderPath\.root\)/.test(folderPage),
    "FolderPathBreadcrumb must use <Link> for the documents-root segment.",
  );

  if (process.exitCode === 1) {
    process.stderr.write(
      "Navigable folder/file destinations must be real <Link href> elements, not <button onClick={navigate}>.\n",
    );
  }
}

await main();
