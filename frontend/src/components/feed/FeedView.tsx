import type { ReactNode } from "react";
import { CombinedFeedError, type Feed, type OptionalFeedShortfall } from "../../utils/feed-state";
import "./feed-view.css";

type FeedTone = "neutral" | "agent";

interface FeedViewProps<T> {
  feed: Feed<T>;
  subject: string;
  tone?: FeedTone;
  extrasShortfalls?: readonly OptionalFeedShortfall[];
  children: (data: T) => ReactNode;
}

export function FeedView<T>({ feed, subject, tone = "neutral", extrasShortfalls = [], children }: FeedViewProps<T>) {
  const showRefreshFailed = feed.status === "loaded" && feed.refreshError != null;
  const showShortfalls = feed.status === "loaded" && extrasShortfalls.length > 0;
  return (
    <div className="feed-view" data-feed-tone={tone} data-feed-status={feed.status}>
      {showRefreshFailed || showShortfalls ? (
        <div className="feed-view__corner">
          {showShortfalls ? <FeedExtrasShortfallBadge shortfalls={extrasShortfalls} /> : null}
          {feed.status === "loaded" && feed.refreshError ? (
            <FeedRefreshFailedBadge subject={subject} error={feed.refreshError} />
          ) : null}
        </div>
      ) : null}
      {feed.status === "loading" ? (
        <FeedLoadingNotice subject={subject} />
      ) : feed.status === "failed" ? (
        <FeedFailedNotice subject={subject} error={feed.error} />
      ) : (
        children(feed.data)
      )}
    </div>
  );
}

function FeedLoadingNotice({ subject }: { subject: string }) {
  return (
    <div className="feed-view__loading" role="status">
      <span className="feed-view__dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      Loading {subject}…
    </div>
  );
}

function FeedFailedNotice({ subject, error }: { subject: string; error: Error }) {
  return (
    <div className="feed-view__failed" role="alert">
      <p className="feed-view__failed-title">
        <span className="feed-view__failed-icon" aria-hidden="true">!</span>
        Couldn’t load {subject}
      </p>
      <p className="feed-view__failed-message">{error.message}</p>
      <FeedErrorDetails error={error} />
    </div>
  );
}

function FeedRefreshFailedBadge({ subject, error }: { subject: string; error: Error }) {
  return (
    <details className="feed-view__stale" role="alert">
      <summary className="feed-view__stale-badge" title={error.message}>
        <span aria-hidden="true">⚠</span> not updating
      </summary>
      <div className="feed-view__stale-popover">
        <p className="feed-view__failed-title">Couldn’t refresh {subject} — showing earlier data</p>
        <p className="feed-view__failed-message">{error.message}</p>
        <FeedErrorDetails error={error} />
      </div>
    </details>
  );
}

function FeedExtrasShortfallBadge({ shortfalls }: { shortfalls: readonly OptionalFeedShortfall[] }) {
  const failed = shortfalls.filter(
    (shortfall): shortfall is Extract<OptionalFeedShortfall, { state: "failed" }> => shortfall.state === "failed",
  );
  const loading = shortfalls.filter((shortfall) => shortfall.state === "loading");
  if (failed.length === 0) {
    return (
      <span className="feed-view__pending-badge" role="status">
        <span className="feed-view__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        loading {loading.map((shortfall) => shortfall.subject).join(", ")}
      </span>
    );
  }
  return (
    <details className="feed-view__stale" role="alert">
      <summary className="feed-view__stale-badge" title={failed.map((shortfall) => shortfall.error.message).join("\n")}>
        <span aria-hidden="true">⚠</span> partial
      </summary>
      <div className="feed-view__stale-popover">
        <p className="feed-view__failed-title">
          Showing what loaded — couldn’t load {failed.map((shortfall) => shortfall.subject).join(", ")}
        </p>
        {loading.length > 0 ? (
          <p className="feed-view__failed-message">
            Still loading {loading.map((shortfall) => shortfall.subject).join(", ")}
          </p>
        ) : null}
        {failed.map((shortfall) => (
          <div key={shortfall.subject}>
            <p className="feed-view__failed-message">{shortfall.error.message}</p>
            <FeedErrorDetails error={shortfall.error} />
          </div>
        ))}
      </div>
    </details>
  );
}

function FeedErrorDetails({ error }: { error: Error }) {
  const errors = error instanceof CombinedFeedError ? error.errors : [error];
  return (
    <details className="feed-view__details">
      <summary>Technical details</summary>
      {errors.map((each, index) => (
        <pre key={index} className="feed-view__stack">
          {each.stack ?? `${each.name}: ${each.message}`}
        </pre>
      ))}
    </details>
  );
}
