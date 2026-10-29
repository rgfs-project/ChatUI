/**
 * Performance marks (contracts §9.5). Each fires at most once per page load,
 * carries only a timestamp (and, for generation marks, an opaque id), and never
 * message text, names, tokens or URLs. No telemetry leaves the browser.
 *
 *   ComposerTTI        = navigation-start → composer-interactive
 *   FirstAssistantEvent = generation-accepted → first-assistant-event
 */
export type PerfMark =
  | "chatui:navigation-start"
  | "chatui:shell-painted"
  | "chatui:hydration-complete"
  | "chatui:composer-interactive"
  | "chatui:conversation-visible"
  | "chatui:generation-accepted"
  | "chatui:first-assistant-event"
  | "chatui:generation-complete";

const done = new Set<string>();

/** Marks once; generation marks once per generation id. */
export function mark(
  name: PerfMark,
  options: { generationId?: string; startTime?: number } = {},
): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  const key = options.generationId ? `${name}:${options.generationId}` : name;
  if (done.has(key)) return;
  done.add(key);
  performance.mark(name, {
    ...(options.startTime === undefined ? {} : { startTime: options.startTime }),
    ...(options.generationId ? { detail: { generationId: options.generationId } } : {}),
  });
}

/** Navigation start is time 0; the first paint comes from the browser's paint timing. */
export function markDocumentStart(): void {
  mark("chatui:navigation-start", { startTime: 0 });
  const paint = performance.getEntriesByName("first-contentful-paint")[0];
  if (paint) {
    mark("chatui:shell-painted", { startTime: paint.startTime });
    return;
  }
  if (typeof PerformanceObserver === "undefined") return;
  const observer = new PerformanceObserver((list) => {
    const entry = list.getEntriesByName("first-contentful-paint")[0];
    if (!entry) return;
    mark("chatui:shell-painted", { startTime: entry.startTime });
    observer.disconnect();
  });
  try {
    observer.observe({ type: "paint", buffered: true });
  } catch {
    // paint timing unsupported
  }
}

export interface PerfSummary {
  marks: Record<string, number>;
  composerTTI: number | null;
  firstAssistantEvent: number | null;
}

/** Readable summary for development and tests (`window.__chatuiPerf()`). */
export function perfSummary(): PerfSummary {
  const marks: Record<string, number> = {};
  for (const entry of performance.getEntriesByType("mark"))
    if (entry.name.startsWith("chatui:")) marks[entry.name] ??= Math.round(entry.startTime);
  const delta = (from: string, to: string) =>
    marks[from] !== undefined && marks[to] !== undefined
      ? (marks[to] ?? 0) - (marks[from] ?? 0)
      : null;
  return {
    marks,
    composerTTI: delta("chatui:navigation-start", "chatui:composer-interactive"),
    firstAssistantEvent: delta("chatui:generation-accepted", "chatui:first-assistant-event"),
  };
}
