import { Link } from "react-router-dom";

interface HomeAdminBadgeProps {
  displayName: string;
}

export function HomeAdminBadge({ displayName }: HomeAdminBadgeProps) {
  return (
    <span className="home-auth-mode">
      <Link to="/admin" className="home-auth-badge home-auth-badge--admin">
        Admin
      </Link>
      <div className="home-auth-popup home-auth-popup--compact" role="tooltip" aria-label="Admin">
        <div className="home-auth-popup__kicker">Admin</div>
        <p className="home-auth-popup__detail">You are logged in as admin.</p>
        <p className="home-auth-popup__username">{displayName}</p>
        <p className="home-auth-popup__detail">Click to go to the admin page.</p>
      </div>
    </span>
  );
}
