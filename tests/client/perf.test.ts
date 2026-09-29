import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markAccepted,
  markDocumentStart,
  markGeneration,
  markOnce,
  perfSummary,
  resetPerfForTests,
} from "../../app/lib/perf";

const GEN = "33333333-3333-4333-8333-333333333333";
const CONV = "22222222-2222-4222-8222-222222222222";
const SENTINEL = "PRIVATE-SENTINEL-7c1e";

// Node's User Timing API stands in for the browser's; the module only needs `window`.
beforeEach(() => {
  vi.stubGlobal("window", {});
  performance.clearMarks();
  performance.clearMeasures();
  resetPerfForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const marks = (name: string) => performance.getEntriesByName(name, "mark");

describe("contracts §9.5: performance marks", () => {
  it("each mark is emitted at most once per matching event", () => {
    markDocumentStart();
    markDocumentStart();
    markOnce("chatui:hydration-complete");
    markOnce("chatui:hydration-complete");
    markOnce("chatui:conversation-visible", CONV, { conversationId: CONV });
    markOnce("chatui:conversation-visible", CONV, { conversationId: CONV });
    expect(marks("chatui:navigation-start")).toHaveLength(1);
    expect(marks("chatui:navigation-start")[0]?.startTime).toBe(0);
    expect(marks("chatui:hydration-complete")).toHaveLength(1);
    expect(marks("chatui:conversation-visible")).toHaveLength(1);
  });

  it("ComposerTTI is navigation-start → composer-interactive", () => {
    markDocumentStart();
    markOnce("chatui:composer-interactive");
    const [tti] = performance.getEntriesByName("chatui:ComposerTTI", "measure");
    expect(tti?.duration).toBeGreaterThanOrEqual(0);
    expect(perfSummary()["chatui:ComposerTTI"]).toBeDefined();
  });

  it("the send path is measured only for generations accepted in this document", () => {
    markGeneration("chatui:first-assistant-event", GEN);
    expect(marks("chatui:first-assistant-event")).toHaveLength(0);
    markAccepted(GEN, CONV);
    markGeneration("chatui:stream-open", GEN);
    markGeneration("chatui:first-assistant-event", GEN);
    markGeneration("chatui:first-assistant-event", GEN);
    markGeneration("chatui:first-assistant-paint", GEN);
    markGeneration("chatui:generation-complete", GEN);
    for (const name of [
      "chatui:generation-accepted",
      "chatui:stream-open",
      "chatui:first-assistant-event",
      "chatui:first-assistant-paint",
      "chatui:generation-complete",
    ])
      expect(marks(name), name).toHaveLength(1);
    const [fae] = performance.getEntriesByName("chatui:FirstAssistantEvent", "measure");
    expect(fae?.duration).toBeGreaterThanOrEqual(0);
  });

  it("marks carry only opaque ids, never private content", () => {
    markDocumentStart();
    markOnce("chatui:conversation-visible", CONV, { conversationId: CONV });
    markAccepted(GEN, CONV);
    markGeneration("chatui:first-assistant-event", GEN);
    const entries = [
      ...performance.getEntriesByType("mark"),
      ...performance.getEntriesByType("measure"),
    ].filter((e) => e.name.startsWith("chatui:"));
    const serialized = JSON.stringify(
      entries.map((e) => ({ name: e.name, detail: (e as PerformanceMark).detail as unknown })),
    );
    expect(serialized).not.toContain(SENTINEL);
    for (const e of entries) {
      const detail = ((e as PerformanceMark).detail ?? {}) as Record<string, unknown>;
      for (const value of Object.values(detail)) expect(String(value)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("is a no-op outside the browser (SSR)", () => {
    vi.unstubAllGlobals();
    markOnce("chatui:hydration-complete");
    expect(marks("chatui:hydration-complete")).toHaveLength(0);
  });
});
