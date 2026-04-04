import path from "node:path";

export class InvalidDocPathError extends Error {}

/** Normalize a doc path: forward slashes, strip leading slashes. */
export function normalizeDocPath(docPath: string): string {
  return docPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function normalizeDocPathStrict(rawDocPath: string): string {
  const forwardSlash = rawDocPath.replaceAll("\\", "/").trim();
  const withoutLeadingSlash = forwardSlash.replace(/^\/+/, "");
  return path.posix.normalize(withoutLeadingSlash);
}

export function resolveDocPathUnderContent(contentRoot: string, rawDocPath: string): string {
  const normalized = normalizeDocPathStrict(rawDocPath);
  if (!normalized || normalized === "." || normalized === "..") {
    throw new InvalidDocPathError("Invalid doc path.");
  }
  if (normalized.startsWith("../") || normalized.includes("/../")) {
    throw new InvalidDocPathError("Path traversal is not allowed.");
  }
  if (!normalized.endsWith(".md")) {
    throw new InvalidDocPathError("Document path must end with .md");
  }

  const resolved = path.resolve(contentRoot, ...normalized.split("/"));
  const resolvedContentRoot = path.resolve(contentRoot);
  if (!resolved.startsWith(`${resolvedContentRoot}${path.sep}`) && resolved !== resolvedContentRoot) {
    throw new InvalidDocPathError("Path escapes content root.");
  }
  return resolved;
}

export function assertChildPath(parent: string, child: string): string {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (!resolvedChild.startsWith(`${resolvedParent}${path.sep}`) && resolvedChild !== resolvedParent) {
    throw new InvalidDocPathError("Resolved child path escapes parent.");
  }
  return resolvedChild;
}
