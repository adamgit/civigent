import { Component, type ReactNode } from "react";
import { SystemStartingError } from "../services/api-client";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  isStarting: boolean;
  retryAfter: number;
}

/**
 * React Error Boundary that catches SystemStartingError (503 system_starting).
 * Renders a fallback and auto-retries after the Retry-After interval.
 */
export class SystemStartingBoundary extends Component<Props, State> {
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { isStarting: false, retryAfter: 5 };
  }

  static getDerivedStateFromError(error: Error): Partial<State> | null {
    if (error instanceof SystemStartingError) {
      return { isStarting: true, retryAfter: error.retryAfter };
    }
    // Not our error — let it propagate
    throw error;
  }

  componentDidCatch(error: Error): void {
    if (error instanceof SystemStartingError) {
      this.scheduleRetry(error.retryAfter);
    }
  }

  componentWillUnmount(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
  }

  private scheduleRetry(seconds: number): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.setState({ isStarting: false });
    }, seconds * 1000);
  }

  render(): ReactNode {
    if (this.state.isStarting) {
      return this.props.fallback ?? (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          color: "#888",
          fontSize: "0.9rem",
        }}>
          The system is starting up. Your content will appear shortly.
        </div>
      );
    }
    return this.props.children;
  }
}
