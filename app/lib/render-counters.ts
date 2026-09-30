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
  /** Markdown documents or blocks rendered (Phase 14: one per growing block). */
  markdownPartRenders: 0,
  /** Characters the streaming block splitter parsed (bounded incremental work). */
  blockParseChars: 0,
};

export function count(key: keyof typeof renderCounters, amount = 1): void {
  if (import.meta.env.MODE === "test") renderCounters[key] += amount;
}
