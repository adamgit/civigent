import { Link } from "react-router-dom";

export function HomeSkillsSlide() {
  return (
    <>
      <p className="home-slide__body">
        Put docs in the skills folder, and I'll auto export them as a Claude plugin.
      </p>
      <div className="home-slide__links">
        <Link to="/skills">Skills {"\u2192"}</Link>
        <Link to="/docs/public_skills">Open skills folder {"\u2192"}</Link>
      </div>
    </>
  );
}
