import type { LiveDocumentSession } from "./live-document-session";

export function footerLinkLabel(session: LiveDocumentSession): string {
  switch (session.pipe.phase) {
    case "live":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Offline";
  }
}

export interface FooterSessionInputs {
  session: LiveDocumentSession;
  headingLabel: string | null;
  proposalMode: boolean;
}

export function footerSessionLabel({ session, headingLabel, proposalMode }: FooterSessionInputs): string {
  switch (session.kind) {
    case "editing":
      if (proposalMode) return "Editing proposal";
      if (headingLabel === null) return "Editing";
      return `Editing: ${headingLabel}`;
    case "superseded":
    case "socketStopped":
      return "Read-only";
    case "viewing":
      if (proposalMode) return "Editing proposal";
      return "Viewing";
  }
}
