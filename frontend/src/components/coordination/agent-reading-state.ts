export interface AgentReadingState {
  actor_id: string;
  actor_display_name: string;
  sections: Map<string, { doc_path: string; heading_path: string[]; lastSeenAt: number }>;
  lastSeenAt: number;
}
