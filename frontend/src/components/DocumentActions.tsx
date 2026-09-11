import { Fragment, type JSX } from "react";

export interface DocumentAction {
  id: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface DocumentActionsProps {
  actions: readonly DocumentAction[];
  variant: "inline" | "menu";
  /** Called after an item is chosen (narrow overflow closes the menu). */
  onItemChosen?: () => void;
}

export function DocumentActions({
  actions,
  variant,
  onItemChosen,
}: DocumentActionsProps): JSX.Element | null {
  if (actions.length === 0) return null;

  if (variant === "inline") {
    return (
      <div className="flex items-center gap-2 shrink-0 pt-2">
        {actions.map((action, index) => (
          <Fragment key={action.id}>
            {index > 0 ? "|" : null}
            <button
              type="button"
              className={
                action.danger
                  ? "text-xs text-red-600 hover:underline"
                  : "text-xs text-accent-primary hover:underline"
              }
              onClick={action.onClick}
            >
              {action.label}
            </button>
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={() => {
            action.onClick();
            onItemChosen?.();
          }}
          className={
            action.danger
              ? "w-full text-left text-[11px] px-3 py-1.5 text-red-600 hover:bg-section-hover"
              : "w-full text-left text-[11px] px-3 py-1.5 text-text-muted hover:bg-section-hover hover:text-text-primary"
          }
        >
          {action.label}
        </button>
      ))}
    </>
  );
}
