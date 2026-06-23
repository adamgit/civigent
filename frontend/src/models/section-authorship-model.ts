import type { DocumentSection } from "../pages/document-page-utils";

export interface SectionAuthorshipTarget {
  /** UI lookup key. Uses fragment identity because several UI maps are section-instance keyed. */
  key: string;
  /** Backend-owned canonical section file id, used only as the blame API target. */
  sectionFile: string;
  /** Heading rendered outside the body-only attribution overlay. */
  heading: string | null;
  /** Body-only markdown whose lines must align 1:1 with section-file blame. */
  bodyContent: string;
  /** Re-fetch blame when the rendered body changes under the same section file. */
  revisionKey: string;
  validationError?: string;
}

function trimTrailingNewlines(raw: string): string {
  return raw.replace(/\n+$/, "");
}

function sectionLabel(section: DocumentSection): string {
  return section.heading_path.length > 0
    ? section.heading_path.join(" > ")
    : "(before first heading)";
}

function stripHeadingFromSectionFragment(
  section: DocumentSection,
): { bodyContent: string; validationError?: string } {
  const fragment = trimTrailingNewlines(section.content);
  if (section.heading_path.length === 0) {
    return { bodyContent: fragment };
  }

  const heading = section.heading || section.heading_path[section.heading_path.length - 1] || "";
  const expectedHeadingLine = `${"#".repeat(section.depth)} ${heading}`;
  const lines = fragment.length > 0 ? fragment.split("\n") : [];

  if (lines[0] !== expectedHeadingLine) {
    const actual = lines[0] ?? "(empty)";
    return {
      bodyContent: "",
      validationError:
        `Cannot show authorship for ${sectionLabel(section)}: section fragment heading did not match its metadata ` +
        `(expected "${expectedHeadingLine}", got "${actual}").`,
    };
  }

  let bodyStart = 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === "") {
    bodyStart += 1;
  }

  return { bodyContent: trimTrailingNewlines(lines.slice(bodyStart).join("\n")) };
}

export function buildSectionAuthorshipTargets(sections: DocumentSection[]): SectionAuthorshipTarget[] {
  return sections.map((section, index) => {
    const errors: string[] = [];
    const sectionFile = section.section_file;
    if (sectionFile.trim().length === 0) {
      errors.push(`Cannot show authorship for ${sectionLabel(section)}: section_file is missing.`);
    }
    if (section.fragment_key.trim().length === 0) {
      errors.push(`Cannot show authorship for ${sectionLabel(section)}: fragment_key is missing.`);
    }

    const stripped = stripHeadingFromSectionFragment(section);
    if (stripped.validationError) {
      errors.push(stripped.validationError);
    }

    const key = section.fragment_key.trim().length > 0
      ? section.fragment_key
      : `invalid-section-${index}`;

    return {
      key,
      sectionFile,
      heading: section.heading_path.length > 0
        ? section.heading_path[section.heading_path.length - 1]
        : null,
      bodyContent: stripped.bodyContent,
      revisionKey: stripped.bodyContent,
      ...(errors.length > 0 ? { validationError: errors.join(" ") } : {}),
    };
  });
}
