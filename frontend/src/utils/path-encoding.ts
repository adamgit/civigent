/**
 * Encode a doc path for use in URL paths — encodes each segment
 * individually so slashes are preserved as path separators.
 *
 * Use this instead of raw encodeURIComponent on doc paths, which
 * would encode `/` as `%2F` and break route matching.
 */
export function encodeDocPath(docPath: string): string {
  return docPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Encode a doc path for WebSocket URLs — like encodeDocPath but also
 * strips empty segments from leading slashes (doc paths start with `/`,
 * but the WS URL already has a path prefix).
 */
export function encodeDocPathForWs(docPath: string): string {
  return docPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
