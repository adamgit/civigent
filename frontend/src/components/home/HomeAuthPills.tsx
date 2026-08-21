import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useCurrentUser } from "../../contexts/CurrentUserContext";
import type { LoginProvider } from "../../types/shared.js";
import { HomeAuthModeBadge } from "./HomeAuthModeBadge";

interface HomeAuthPillsProps {
  mode: LoginProvider | null;
  children?: ReactNode;
}

export function HomeAuthPills({ mode, children }: HomeAuthPillsProps) {
  const currentUser = useCurrentUser();
  const showAdmin = currentUser?.is_admin === true;
  if (!mode && !showAdmin && !children) return null;
  return (
    <div className="home-auth-pills">
      <HomeAuthModeBadge mode={mode} />
      {showAdmin ? (
        <Link to="/admin" className="home-auth-badge home-auth-badge--admin">
          Admin
        </Link>
      ) : null}
      {children}
    </div>
  );
}
