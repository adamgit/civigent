import { Link } from "react-router-dom";

export function HomeSkillsSlide() {
  return (
    <div className="home-slide">
      <div className="home-slide__kicker">New {"\u00b7"} Claude Code skills</div>
      <h2 className="home-slide__title">Turn a folder into agent skills</h2>
      <p className="home-slide__body">
        Put markdown skills in the skills folder (default{" "}
        <code>/public_skills</code>
        ). Civigent exports them as a Claude Code plugin ZIP — install with{" "}
        <code>claude --plugin-url</code>
        {" "}and your agents can invoke those skills directly.
      </p>
      <div className="home-slide__links">
        <Link to="/skills">Skills &amp; launch command {"\u2192"}</Link>
        <Link to="/docs/public_skills">Open skills folder {"\u2192"}</Link>
      </div>
    </div>
  );
}
