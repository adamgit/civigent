import { useCallback, useEffect, useRef, useState } from "react";
import {
  SingleFlightCoalescingLoader,
  type CoalescedLoadOutcome,
} from "../services/coalescing-loader";
import { toError, type Feed } from "../utils/feed-state";

export function useRefreshableFeed<T>(stableFetchFeed: () => Promise<T>): {
  feed: Feed<T>;
  refreshKeepingShownData: () => void;
} {
  const [feed, setFeed] = useState<Feed<T>>({ status: "loading" });
  const [loader] = useState(() => new SingleFlightCoalescingLoader());
  const mountedRef = useRef(false);

  const runFetch = useCallback(
    (): Promise<CoalescedLoadOutcome> =>
      Promise.resolve()
        .then(stableFetchFeed)
        .then(
          (data): CoalescedLoadOutcome => {
            if (!mountedRef.current) return "not-applied";
            setFeed({ status: "loaded", data, refreshError: null });
            return "applied";
          },
          (thrown: unknown): CoalescedLoadOutcome => {
            if (!mountedRef.current) return "not-applied";
            const error = toError(thrown);
            setFeed((previous) =>
              previous.status === "loaded"
                ? { status: "loaded", data: previous.data, refreshError: error }
                : { status: "failed", error },
            );
            return "not-applied";
          },
        ),
    [stableFetchFeed],
  );

  const refreshKeepingShownData = useCallback(() => {
    void loader.requestLoadStartedAfterNow("background", runFetch);
  }, [loader, runFetch]);

  useEffect(() => {
    mountedRef.current = true;
    void loader.requestLoadStartedAfterNow("foreground", runFetch);
    return () => {
      mountedRef.current = false;
    };
  }, [loader, runFetch]);

  return { feed, refreshKeepingShownData };
}
