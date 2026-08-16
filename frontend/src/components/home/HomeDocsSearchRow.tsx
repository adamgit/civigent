import { HomeDocsCard } from "./HomeDocsCard";
import { HomeSearchCard } from "./HomeSearchCard";
import type { DocLayoutMode } from "../../hooks/useDocLayoutMode";

interface HomeDocsSearchRowProps {
  folderCount: number;
  documentCount: number;
  layoutMode?: DocLayoutMode;
}

export function HomeDocsSearchRow({
  folderCount,
  documentCount,
  layoutMode = "narrow",
}: HomeDocsSearchRowProps) {
  return (
    <div className="home-nav-row">
      <HomeDocsCard folderCount={folderCount} documentCount={documentCount} layoutMode={layoutMode} />
      <HomeSearchCard layoutMode={layoutMode} />
    </div>
  );
}
