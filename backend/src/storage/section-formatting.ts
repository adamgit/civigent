/**
 * Format a single section with its heading prepended.
 * Trims leading/trailing newlines from the body, then produces:
 *   "## Heading\n\nbody\n"  (non-empty body)
 *   "## Heading\n"          (empty body)
 */
export function prependHeading(body: string, level: number, heading: string): string {
  const trimmed = body.replace(/^\n+/, "").replace(/\n+$/, "");
  const h = "#".repeat(level) + " " + heading;
  return trimmed ? h + "\n\n" + trimmed + "\n" : h + "\n";
}
