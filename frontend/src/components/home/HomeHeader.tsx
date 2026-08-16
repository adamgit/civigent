import type { ReactNode } from "react";

interface HomeHeaderProps {
  title: string;
  hostLabel: string;
  trailing?: ReactNode;
}

export function HomeHeader({ title, hostLabel, trailing }: HomeHeaderProps) {
  return (
    <div className="home-header">
      <div className="min-w-0">
        <h1 className="home-header__title">{title}</h1>
        <p className="home-header__meta">
          {hostLabel} {"\u00b7"} <span className="home-header__private">private</span>
        </p>
      </div>
      {trailing ? <div className="home-header__end">{trailing}</div> : null}
    </div>
  );
}
