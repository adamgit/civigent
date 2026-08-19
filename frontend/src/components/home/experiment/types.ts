/**
 * Experimental home pulse + task roster. Delete this folder (and the
 * `.home-experiment*` block in home.css) to revert the carousel swap.
 */

export interface HomeMcpPulseAction {
  agent_id: string;
  agent_display_name: string;
  method: string;
  ts: string;
  doc_path: string | null;
  heading_path: string[] | null;
}

export type HomeAgentTaskStatus = "running" | "waiting" | "finished" | "exploring";

export interface HomeAgentTaskDoc {
  path: string;
  title: string;
}

/** One document this task touched, with sections in first-seen order. */
export interface HomeAgentTaskTouch extends HomeAgentTaskDoc {
  sections: string[];
}

export interface HomeAgentTask {
  id: string;
  agentId: string;
  displayName: string;
  intent: string;
  status: HomeAgentTaskStatus;
  startedAt: string;
  endedAt: string | null;
  /** Documents read, in the order they were first read. */
  reads: HomeAgentTaskTouch[];
  /** Documents written, in the order they were first written. */
  writes: HomeAgentTaskTouch[];
}

export interface HomePulseHourBar {
  index: number;
  startMs: number;
  endMs: number;
  readCount: number;
  writeCount: number;
  label: string;
}
