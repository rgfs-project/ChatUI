/**
 * Performance marks (contracts §9.5). Each mark is emitted at most once per
 * matching event (per document, or per generation/conversation id) and
 * carries only opaque ids in `detail`, never message text, usernames, tokens
 * or URLs with private data. Browser-only; SSR calls are no-ops.
 *
 * Document lifecycle: navigation-start (t = 0) → shell-painted (first
 * contentful paint of the server HTML) → hydration-complete →
 * composer-interactive (send controls usable) and conversation-visible.
 * Send path: generation-accepted (202) → stream-open (SSE ready) →
 * first-assistant-event (first reasoning/content delta) →
 * first-assistant-paint → generation-complete.
 */
export type MarkName =
  | "chatui:navigation-start"
  | "chatui:shell-painted"
  | "chatui:hydration-complete"
  | "chatui:composer-interactive"
  | "chatui:conversation-visible"
  | "chatui:generation-accepted"
  | "chatui:stream-open"
  | "chatui:first-assistant-event"
  | "chatui:first-assistant-paint"
  | "chatui:generation-complete";

export interface MarkDetail {
  conversationId?: string;
  generationId?: string;
}

const emitted = new Set<string>();
/** Generations accepted in this document: only their send path is measured. */
const accepted = new Set<string>();

function detailOf(entry: PerformanceEntry): MarkDetail | null {
  return (entry as PerformanceMark).detail as MarkDetail | null;
}

function available(): boolean {
  return typeof window !== "undefined" && typeof performance.mark === "function";
}

function measure(name: string, start: MarkName, end: MarkName, detail?: MarkDetail): void {
  try {
    performance.measure(name, { start, end, ...(detail ? { detail } : {}) });
  } catch {
    // A start mark from before this document (or cleared): no measure.
  }
}

/** Emits `name` once per `key` (the document when omitted). */
export function markOnce(name: MarkName, key = "", detail?: MarkDetail, startTime?: number): void {
  if (!available()) return;
  const id = `${name}|${key}`;
  if (emitted.has(id)) return;
  emitted.add(id);
  performance.mark(name, {
    ...(detail ? { detail } : {}),
    ...(startTime === undefined ? {} : { startTime }),
  });
  if (name === "chatui:composer-interactive")
    measure("chatui:ComposerTTI", "chatui:navigation-start", "chatui:composer-interactive");
}

/** Document start and the server-rendered shell's first contentful paint. */
export function markDocumentStart(): void {
  if (!available()) return;
  markOnce("chatui:navigation-start", "", undefined, 0);
  const paint = performance.getEntriesByName("first-contentful-paint")[0];
  if (paint) {
    markOnce("chatui:shell-painted", "", undefined, paint.startTime);
    return;
  }
  const observer = new PerformanceObserver((list) => {
    const fcp = list.getEntriesByName("first-contentful-paint")[0];
    if (!fcp) return;
    markOnce("chatui:shell-painted", "", undefined, fcp.startTime);
    observer.disconnect();
  });
  observer.observe({ type: "paint", buffered: true });
}

/** A send was accepted (202): its send path is measured from here. */
export function markAccepted(generationId: string, conversationId: string): void {
  if (!available()) return;
  accepted.add(generationId);
  markOnce("chatui:generation-accepted", generationId, { generationId, conversationId });
}

/** Send-path marks after acceptance; ignored for generations started elsewhere. */
export function markGeneration(
  name:
    | "chatui:stream-open"
    | "chatui:first-assistant-event"
    | "chatui:first-assistant-paint"
    | "chatui:generation-complete",
  generationId: string,
): void {
  if (!available() || !accepted.has(generationId)) return;
  const key = `${name}|${generationId}`;
  if (emitted.has(key)) return;
  markOnce(name, generationId, { generationId });
  if (name === "chatui:first-assistant-event") {
    const start = performance
      .getEntriesByName("chatui:generation-accepted")
      .find((m) => detailOf(m)?.generationId === generationId);
    const end = performance
      .getEntriesByName("chatui:first-assistant-event")
      .find((m) => detailOf(m)?.generationId === generationId);
    if (start && end)
      performance.measure("chatui:FirstAssistantEvent", {
        start: start.startTime,
        end: end.startTime,
        detail: { generationId },
      });
  }
}

/** Readable summary of this document's marks and measures (dev/test helper). */
export function perfSummary(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of performance.getEntriesByType("mark"))
    if (entry.name.startsWith("chatui:")) out[entry.name] ??= Math.round(entry.startTime);
  for (const entry of performance.getEntriesByType("measure"))
    if (entry.name.startsWith("chatui:")) out[entry.name] ??= Math.round(entry.duration);
  return out;
}

/** Test helper: forget emitted marks (one document per test). */
export function resetPerfForTests(): void {
  emitted.clear();
  accepted.clear();
}
