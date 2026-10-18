import type { CrdtConnectionState } from "./crdt-provider";
import type { LiveDocumentSession } from "../status/live-document-session";

export type CrdtConnectionPhase = "live" | "connecting" | "reconnecting" | "offline";

export function crdtConnectionPhase(state: CrdtConnectionState): CrdtConnectionPhase {
  switch (state) {
    case "connected":
      return "live";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    case "error":
    case "disconnected":
      return "offline";
  }
}

export interface CrdtBannerInfo {
  tone: "amber" | "red";
  message: string;
  sectionLabel: string;
}

export function crdtBannerInfo(state: CrdtConnectionState): CrdtBannerInfo | null {
  switch (crdtConnectionPhase(state)) {
    case "live":
      return null;
    case "connecting":
      return {
        tone: "amber",
        message: "Connecting to server…",
        sectionLabel: "Connecting — editing paused",
      };
    case "reconnecting":
      return {
        tone: "amber",
        message: "Connection lost — reconnecting…",
        sectionLabel: "Reconnecting — editing paused",
      };
    case "offline":
      return {
        tone: "red",
        message: "Offline — changes won’t be saved",
        sectionLabel: "Offline — editing paused",
      };
  }
}

function lostEditingBannerInfo(session: LiveDocumentSession): CrdtBannerInfo | null {
  switch (session.kind) {
    case "superseded":
      return {
        tone: "amber",
        message: "Editing moved to another tab — this tab can no longer change the document",
        sectionLabel: "Editing moved to another tab",
      };
    case "socketStopped":
      return {
        tone: "amber",
        message: "This tab's editing session ended — click a section to start editing again",
        sectionLabel: "Editing session ended",
      };
    case "viewing":
    case "editing":
      return null;
  }
}

export function connectionBannerInfo(session: LiveDocumentSession): CrdtBannerInfo | null {
  if (session.kind === "editing") {
    switch (session.pipe.phase) {
      case "live":
        return null;
      case "connecting":
        return crdtBannerInfo("connecting");
      case "reconnecting":
        return crdtBannerInfo("reconnecting");
      case "error":
        return crdtBannerInfo("error");
    }
  }
  switch (session.pipe.phase) {
    case "connecting":
      return {
        tone: "amber",
        message: "Connecting to server…",
        sectionLabel: "Connecting…",
      };
    case "reconnecting":
      return {
        tone: "amber",
        message: "Connection lost — live updates paused, reconnecting…",
        sectionLabel: "Reconnecting…",
      };
    case "live":
      return lostEditingBannerInfo(session);
  }
}
