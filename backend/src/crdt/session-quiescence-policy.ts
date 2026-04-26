import type { DocSession } from "./ydoc-lifecycle.js";

export interface SessionQuiescencePolicyConfig {
  idleTimeoutMs: number;
}

export class SessionQuiescencePolicy {
  constructor(
    private readonly session: DocSession,
    private readonly config: SessionQuiescencePolicyConfig,
  ) {}

  shouldTriggerIdleTimeout(nowMs = Date.now()): boolean {
    return nowMs - this.getIdleBaseline() >= this.config.idleTimeoutMs;
  }

  isFragmentQuiescent(fragmentKey: string, nowMs = Date.now()): boolean {
    const lastActivity = this.session.fragmentLastActivity.get(fragmentKey) ?? this.session.lastActivityAt;
    return nowMs - lastActivity >= this.config.idleTimeoutMs;
  }

  shouldTearDownDoc(nowMs = Date.now()): boolean {
    if (this.session.state !== "active") return false;
    if (this.session.holders.size > 0) return false;
    if (this.session.liveFragments.getAheadOfStagedKeys().size > 0) return false;
    if (nowMs - this.getIdleBaseline() < this.config.idleTimeoutMs) return false;
    return this.allKnownFragmentsQuiet(nowMs);
  }

  private getLatestPulse(): number | null {
    if (this.session.lastEditPulse.size === 0) return null;
    let latest = 0;
    for (const ts of this.session.lastEditPulse.values()) {
      if (ts > latest) latest = ts;
    }
    return latest > 0 ? latest : null;
  }

  private getIdleBaseline(): number {
    return this.getLatestPulse() ?? this.session.lastActivityAt;
  }

  private allKnownFragmentsQuiet(nowMs: number): boolean {
    for (const ts of this.session.fragmentLastActivity.values()) {
      if (nowMs - ts < this.config.idleTimeoutMs) {
        return false;
      }
    }
    return true;
  }
}
