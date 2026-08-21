import type { ReactNode } from "react";
import type { LoginProvider } from "../../types/shared.js";
import { HomeAuthPills } from "./HomeAuthPills";

interface HomeHeaderProps {
  title: string;
  hostLabel: string;
  authMode: LoginProvider | null;
  trailing?: ReactNode;
}

export function HomeHeader({ title, hostLabel, authMode, trailing }: HomeHeaderProps) {
  const showHost = hostLabel.length > 0 && hostLabel !== title;
  return (
    <div className="home-header">
      <div className="min-w-0">
        <h1 className="home-header__title">{title}</h1>
        {showHost ? <p className="home-header__meta">{hostLabel}</p> : null}
        <HomeAuthPills mode={authMode} />
      </div>
      {trailing ? <div className="home-header__end">{trailing}</div> : null}
    </div>
  );
}
