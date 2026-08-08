/**
 * Visual tokens for the four search hit kinds.
 *
 * The kinds answer different questions — "which FOLDER", "which DOCUMENT",
 * "which SECTION", "what TEXT" — so each gets its own hue rather than a shade of
 * one accent: on a results page the hue is what lets you skim past the wrong
 * project folder without reading anything. All four palettes are existing
 * `--color-*` tokens (orange / teal / green / purple), not new colors.
 *
 * Pure presentation: no fetching, no routing, no forest knowledge.
 */
import type { ReactElement } from "react";
import type { SearchHitKind } from "../../services/api-client";

export interface SearchHitKindIconProps {
  /** Square icon edge in px. Cards use a large icon; the legend uses a small one. */
  size?: number;
}

export interface SearchHitKindTokens {
  kind: SearchHitKind;
  /** Full label for legends and inspector headers. */
  label: string;
  /** Compact label for badges where horizontal room is scarce. */
  shortLabel: string;
  /** One line describing what this kind actually located. */
  description: string;
  Icon: (props: SearchHitKindIconProps) => ReactElement;
  /** `var(--color-*)` strings, ready to drop into `style`. */
  foreground: string;
  background: string;
  border: string;
}

function FolderIcon({ size = 16 }: SearchHitKindIconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.75 4.25C1.75 3.56 2.31 3 3 3h3.09c.33 0 .65.13.88.37l.91.91h4.37c.69 0 1.25.56 1.25 1.25v6.22c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25V4.25Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DocumentIcon({ size = 16 }: SearchHitKindIconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.75h4.19c.33 0 .65.13.88.37l2.81 2.81c.24.23.37.55.37.88v8.44c0 .69-.56 1.25-1.25 1.25H4c-.69 0-1.25-.56-1.25-1.25V3c0-.69.56-1.25 1.25-1.25Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.5 1.9v3.35h3.35" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function HeadingIcon({ size = 16 }: SearchHitKindIconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M3.5 3v10M9.5 3v10M3.5 8h6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M12 13V7.4l-1.4.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BodyTextIcon({ size = 16 }: SearchHitKindIconProps): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.5 3.5h11M2.5 6.75h11M2.5 10h8M2.5 13.25h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export const SEARCH_HIT_KIND_TOKENS: Record<SearchHitKind, SearchHitKindTokens> = {
  path_segment: {
    kind: "path_segment",
    label: "Folder name",
    shortLabel: "Folder",
    description: "A folder in the path matched — the document itself may not contain the term.",
    Icon: FolderIcon,
    foreground: "var(--color-agent2)",
    background: "var(--color-agent2-light)",
    border: "var(--color-agent2)",
  },
  filename: {
    kind: "filename",
    label: "Document name",
    shortLabel: "Filename",
    description: "The document's own name matched (extension excluded).",
    Icon: DocumentIcon,
    foreground: "var(--color-accent-text)",
    background: "var(--color-accent-light)",
    border: "var(--color-accent-border)",
  },
  heading: {
    kind: "heading",
    label: "Section heading",
    shortLabel: "Heading",
    description: "A section heading matched — the section body may not contain the term.",
    Icon: HeadingIcon,
    foreground: "var(--color-status-green)",
    background: "var(--color-status-green-light)",
    border: "var(--color-status-green)",
  },
  body: {
    kind: "body",
    label: "Body text",
    shortLabel: "Body",
    description: "Text inside a section body matched.",
    Icon: BodyTextIcon,
    foreground: "var(--color-agent-text)",
    background: "var(--color-agent-light)",
    border: "var(--color-agent-border)",
  },
};

/**
 * Fixed display order, broadest locator → narrowest → body. Mirrors the order
 * the backend merges hits in, so legend, counts, and card list all agree.
 */
export const SEARCH_HIT_KIND_ORDER: readonly SearchHitKind[] = [
  "path_segment",
  "filename",
  "heading",
  "body",
];
