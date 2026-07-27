/**
 * Encode a doc path for use in URL paths — encodes each segment
 * individually so slashes are preserved as path separators.
 *
 * Strips empty segments from a leading `/` (canonical DocPaths start with `/`,
 * but REST routes already have a path prefix). Leaving the empty segment used
 * to produce `//folder/doc.md` URLs; combined with the old `"/" + param`
 * normalizer that created stored paths like `//folder/doc.md`.
 *
 * Use this instead of raw encodeURIComponent on doc paths, which
 * would encode `/` as `%2F` and break route matching.
 */
export function encodeDocPath(docPath: string): string {
  return docPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/**
 * Encode a doc path for WebSocket URLs — same segment encoding as encodeDocPath
 * (slash-stripped for a path prefix that already exists on the WS URL).
 */
export function encodeDocPathForWs(docPath: string): string {
  return encodeDocPath(docPath);
}
