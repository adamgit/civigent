import type { ReactNode } from "react";

interface PanelHeaderProps {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
  id?: string;
}

export function PanelHeader({ title, subtitle, children, id }: PanelHeaderProps) {
  return (
    <div className="panel-header">
      <h2 id={id} className="panel-header__title font-body">
        {title}
      </h2>
      {subtitle ? <span className="panel-header__subtitle">{subtitle}</span> : null}
      <span className="panel-header__spacer" />
      {children}
    </div>
  );
}
