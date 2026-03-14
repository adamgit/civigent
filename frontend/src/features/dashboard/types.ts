import type { ActivityItem, DocPath, HeadingPath } from "../../types/shared.js";

export interface WhatsNewSettings {
  limit: number;
  days: number;
}

export type UserLastEditMap = Map<DocPath, string>;

export type TrustIndicator = "amber" | "green";

export interface EditsToYourDocsItem {
  docPath: DocPath;
  changedSections: Array<{
    headingPath: HeadingPath;
    indicator: TrustIndicator;
    activities: ActivityItem[];
  }>;
  totalAgentChanges: number;
}

export interface OtherActivityItem {
  docPath: DocPath;
  activity: ActivityItem;
}
