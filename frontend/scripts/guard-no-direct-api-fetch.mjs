import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const srcRoot = path.resolve(projectRoot, "src");
const allowlistedFiles = new Set(["src/services/api-client.ts"]);
const sourceExtensions = new Set([".ts", ".tsx"]);
const apiFetchPattern = /\bfetch\s*\(\s*([`'"])\s*\/api\//g;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!sourceExtensions.has(path.extname(entry.name))) {
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

async function main() {
  const files = await collectSourceFiles(srcRoot);
  const violations = [];
  for (const filePath of files) {
    const relativePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
    if (allowlistedFiles.has(relativePath)) {
      continue;
    }
    const content = await readFile(filePath, "utf8");
    apiFetchPattern.lastIndex = 0;
    if (apiFetchPattern.test(content)) {
      violations.push(relativePath);
    }
  }

  if (violations.length === 0) {
    return;
  }

  process.stderr.write("Direct /api fetch usage is restricted to src/services/api-client.ts.\n");
  process.stderr.write("Use apiClient methods instead of calling fetch('/api/...') in feature code.\n");
  for (const filePath of violations) {
    process.stderr.write(`- ${filePath}\n`);
  }
  process.exitCode = 1;
}

await main();
