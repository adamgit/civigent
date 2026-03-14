import type { DocPath, HeadingPath } from "../../types/shared.js";

export interface RecentlyChangedSectionState {
  headingPath: HeadingPath;
  changedBy: string;
  changedAt: string;
  concern?: "low" | "moderate" | "high";
}

export interface SectionAttributionOverlayState {
  headingPath: HeadingPath;
  agentDisplayName: string;
  message?: string;
  proposalId: string;
  visible: boolean;
}

export interface BlockedAgentPanelState {
  visible: boolean;
  agents: Array<{
    id: string;
    displayName: string;
    intent: string;
    sections: HeadingPath[];
  }>;
}

export interface DocumentViewState {
  docPath: DocPath;
  markdown: string;
  recentlyChangedSections: RecentlyChangedSectionState[];
  attributionOverlay?: SectionAttributionOverlayState;
  blockedAgents?: BlockedAgentPanelState;
}
