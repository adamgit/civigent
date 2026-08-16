import { HomeOverflowMenu } from "./HomeOverflowMenu";

interface HomeHeaderProps {
  title: string;
  hostLabel: string;
  onCreateDocument: () => void;
}

export function HomeHeader({ title, hostLabel, onCreateDocument }: HomeHeaderProps) {
  return (
    <div className="home-header">
      <div className="min-w-0">
        <h1 className="home-header__title">{title}</h1>
        <p className="home-header__meta">
          {hostLabel} {"\u00b7"} <span className="home-header__private">private</span>
        </p>
      </div>
      <HomeOverflowMenu onCreateDocument={onCreateDocument} />
    </div>
  );
}
