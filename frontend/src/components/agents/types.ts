import type { AgentConnectionStatus, AgentProposalSnapshot } from "../../types/shared.js";

export interface AgentDocumentActivity {
  docPath: string;
  displayName: string;
  sectionDiffs: string[];
}

export interface AgentCardViewModel {
  id: string;
  displayName: string;
  avatarLetter: string;
  avatarHue: number;
  connectionStatus: AgentConnectionStatus;
  lastSeenAt: string | null;
  currentActivityHtml: string;
  activeDocuments: AgentDocumentActivity[];
  mcpToolUsage: Record<string, number>;
  pendingProposals: readonly AgentProposalSnapshot[];
  recentProposals: readonly AgentProposalSnapshot[];
  stats: {
    proposals_committed: number;
    proposals_blocked: number;
    proposals_withdrawn: number;
    total_tool_calls: number;
  };
}

export interface ActivityFeedEvent {
  id: string;
  agentId: string;
  agentDisplayName: string;
  agentAvatarLetter: string;
  agentAvatarHue: number;
  action: string;
  targetDescription: string;
  timestamp: string;
  documentPreview?: string;
}
