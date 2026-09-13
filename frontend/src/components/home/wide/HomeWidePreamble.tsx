export function HomeWidePreamble() {
  return (
    <p className="home-wide-preamble__copy">
      Recent activity by{" "}
      <span className="home-wide-preamble__swatch home-wide-preamble__swatch--agent">AI agents</span>
      {" "}and{" "}
      <span className="home-wide-preamble__swatch home-wide-preamble__swatch--human">Human users</span>
    </p>
  );
}
