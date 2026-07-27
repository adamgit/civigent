import path from "node:path";

import { DocPath, InvalidDocPathError } from "../types/shared.js";

export { InvalidDocPathError };

export function docPathToContentRelativeFsPath(docPath: DocPath): string {
  return docPath.slice(1);
}

export function docPathFromContentRelativeFsPath(contentRelativeFsPath: string): DocPath {
  return DocPath.parse(`/${contentRelativeFsPath}`);
}

export function resolveDocPathUnderContent(contentRoot: string, docPath: string): string {
  const contentRelativeFsPath = docPathToContentRelativeFsPath(DocPath.parse(docPath));

  const resolved = path.resolve(contentRoot, ...contentRelativeFsPath.split("/"));
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
