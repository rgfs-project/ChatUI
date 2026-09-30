/**
 * Mount/render counters used by component tests to prove that a streaming
 * token re-renders only the growing message (INV-32 groundwork). Counting is
 * compiled in only for the test build.
 */
export const renderCounters = {
  messageMounts: 0,
  messageRenders: 0,
  sidebarMounts: 0,
  sidebarRenders: 0,
};

export function count(key: keyof typeof renderCounters): void {
  if (import.meta.env.MODE === "test") renderCounters[key]++;
}
