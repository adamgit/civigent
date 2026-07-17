import type { DocumentSection } from "../pages/document-page-utils";

export interface SectionAuthorshipTarget {
  key: string;
  sectionFile: string;
  heading: string | null;
  bodyContent: string;
  revisionKey: string;
  validationError?: string;
}

export interface AuthorshipSourceOverrides {
  resolveSectionFile?: (fragmentKey: string) => string | undefined;
  resolveBody?: (fragmentKey: string) => string | undefined;
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

  const heading = section.heading_path[section.heading_path.length - 1] || "";
  const expectedHeadingLine = `${"#".repeat(Math.max(1, section.heading_path.length))} ${heading}`;
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

export function buildSectionAuthorshipTargets(
  sections: DocumentSection[],
  overrides: AuthorshipSourceOverrides = {},
): SectionAuthorshipTarget[] {
  return sections.map((section, index) => {
    const errors: string[] = [];
    const resolvedSectionFile = overrides.resolveSectionFile?.(section.fragment_key);
    const sectionFile = (resolvedSectionFile ?? section.section_file) || "";
    if (sectionFile.trim().length === 0) {
      errors.push(`Cannot show authorship for ${sectionLabel(section)}: section_file is missing.`);
    }
    if (section.fragment_key.trim().length === 0) {
      errors.push(`Cannot show authorship for ${sectionLabel(section)}: fragment_key is missing.`);
    }

    const resolvedBody = overrides.resolveBody?.(section.fragment_key);
    const bodySource: DocumentSection =
      resolvedBody !== undefined ? { ...section, content: resolvedBody } : section;
    const stripped = stripHeadingFromSectionFragment(bodySource);
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
