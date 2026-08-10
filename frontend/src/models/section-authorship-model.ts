import { SectionId, type RenderSectionRef } from "../types/live-sections";
import type { HeadingLevel } from "../types/shared";

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

function sectionLabel(headingPath: readonly string[]): string {
  return headingPath.length > 0
    ? headingPath.join(" > ")
    : "(before first heading)";
}

function stripHeadingFromSectionFragment(
  headingPath: readonly string[],
  headingLevel: HeadingLevel,
  content: string,
): { bodyContent: string; validationError?: string } {
  const fragment = trimTrailingNewlines(content);
  if (headingPath.length === 0) {
    return { bodyContent: fragment };
  }

  const heading = headingPath[headingPath.length - 1] || "";
  const expectedHeadingLine = `${"#".repeat(Math.max(1, headingLevel))} ${heading}`;
  const lines = fragment.length > 0 ? fragment.split("\n") : [];

  if (lines[0] !== expectedHeadingLine) {
    const actual = lines[0] ?? "(empty)";
    return {
      bodyContent: "",
      validationError:
        `Cannot show authorship for ${sectionLabel(headingPath)}: section fragment heading did not match its metadata ` +
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
  sections: readonly RenderSectionRef[],
  overrides: AuthorshipSourceOverrides = {},
): SectionAuthorshipTarget[] {
  return sections.map((section, index) => {
    const headingPath = [...section.headingPath];
    const fragmentKey = SectionId.text(section.id);
    const errors: string[] = [];
    const sectionFile = overrides.resolveSectionFile?.(fragmentKey) ?? "";
    if (sectionFile.trim().length === 0) {
      errors.push(`Cannot show authorship for ${sectionLabel(headingPath)}: section_file is missing.`);
    }
    if (fragmentKey.trim().length === 0) {
      errors.push(`Cannot show authorship for ${sectionLabel(headingPath)}: fragment_key is missing.`);
    }

    const body = overrides.resolveBody?.(fragmentKey) ?? "";
    const stripped = stripHeadingFromSectionFragment(headingPath, section.headingLevel, body);
    if (stripped.validationError) {
      errors.push(stripped.validationError);
    }

    const key = fragmentKey.trim().length > 0
      ? fragmentKey
      : `invalid-section-${index}`;

    return {
      key,
      sectionFile,
      heading: headingPath.length > 0
        ? headingPath[headingPath.length - 1]
        : null,
      bodyContent: stripped.bodyContent,
      revisionKey: stripped.bodyContent,
      ...(errors.length > 0 ? { validationError: errors.join(" ") } : {}),
    };
  });
}
