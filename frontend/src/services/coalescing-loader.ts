export type CoalescedLoadMode = "foreground" | "background";
export type CoalescedLoadOutcome = "applied" | "not-applied";
export type CoalescedLoadRun = (mode: CoalescedLoadMode) => Promise<CoalescedLoadOutcome>;

interface TicketWaiter {
  ticket: number;
  resolve: () => void;
}

export class SingleFlightCoalescingLoader {
  private running = false;
  private askSeq = 0;
  private completedThrough = 0;
  private waiters: TicketWaiter[] = [];
  private appliedOnce = false;

  requestLoadStartedAfterNow(requestedMode: CoalescedLoadMode, runLoad: CoalescedLoadRun): Promise<void> {
    const ticket = ++this.askSeq;
    if (!this.running) {
      this.running = true;
      void this.pump(requestedMode, runLoad);
    }
    return new Promise<void>((resolve) => {
      if (ticket <= this.completedThrough) {
        resolve();
        return;
      }
      this.waiters.push({ ticket, resolve });
    });
  }

  private resolveCompletedWaiters(): void {
    const pending: TicketWaiter[] = [];
    for (const waiter of this.waiters) {
      if (waiter.ticket <= this.completedThrough) {
        waiter.resolve();
      } else {
        pending.push(waiter);
      }
    }
    this.waiters = pending;
  }

  private async pump(firstMode: CoalescedLoadMode, runLoad: CoalescedLoadRun): Promise<void> {
    let mode = firstMode;
    try {
      while (true) {
        const startedFor = this.askSeq;
        if (this.appliedOnce) {
          mode = "background";
        }
        const outcome = await runLoad(mode);
        if (outcome === "applied") {
          this.appliedOnce = true;
        }
        this.completedThrough = startedFor;
        this.resolveCompletedWaiters();
        if (this.askSeq === startedFor) {
          break;
        }
      }
    } finally {
      this.running = false;
      if (this.askSeq > this.completedThrough) {
        this.running = true;
        void this.pump(this.appliedOnce ? "background" : "foreground", runLoad);
      }
    }
  }
}
