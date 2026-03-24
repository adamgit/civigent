import { useEffect, useRef, useState } from "react";
import { prettyAge } from "../utils/prettyAge.js";

/**
 * Given a server-provided seconds_ago value, returns a live pretty-formatted
 * age string that updates every minute as time passes.
 */
export function useAgeDisplay(secondsAgo: number | undefined): string {
  // Capture the wall-clock time when seconds_ago was last received
  const receivedAtRef = useRef(Date.now());
  const [, setTick] = useState(0);

  useEffect(() => {
    receivedAtRef.current = Date.now();
  }, [secondsAgo]);

  // Tick every 60 seconds to keep the display fresh
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (secondsAgo === undefined) return "";
  const elapsed = (Date.now() - receivedAtRef.current) / 1000;
  return prettyAge(Math.max(0, secondsAgo + elapsed));
}
