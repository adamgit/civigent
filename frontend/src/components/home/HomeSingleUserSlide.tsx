import { Link } from "react-router-dom";
import { SINGLE_USER_MODE_EXPLAINER } from "../../single-user-mode";

export function HomeSingleUserSlide() {
  return (
    <div
      className="home-slide home-slide--single-user"
      aria-label="Single-user mode"
      data-testid="single-user-home-banner"
    >
      <div className="home-slide__kicker">Security</div>
      <h2 className="home-slide__title">Single-user mode</h2>
      <p className="home-slide__body">{SINGLE_USER_MODE_EXPLAINER}</p>
      <div className="home-slide__links">
        <Link to="/admin">Configure login in Admin {"\u2192"}</Link>
      </div>
    </div>
  );
}
