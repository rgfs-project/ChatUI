import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPrefetcher, PREFETCH_DELAY_MS } from "../../app/lib/prefetch";
import { qk } from "../../app/lib/query/keys";
import { conversationQuery, storeConversation } from "../../app/lib/query/queries";

const USER = "a1a1a1a1-0000-4000-8000-000000000001";
const id = (n: number) => `c0c0c0c0-0000-4000-8000-00000000000${String(n)}`;
const dto = (cid: string, updatedAt: string, title: string) => ({
  id: cid,
  title,
  createdAt: "",
  updatedAt,
  revision: "0".repeat(64),
  activeGeneration: null,
  proposals: [],
  messages: [],
});

let calls: string[];
let release: (() => void)[];

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  release = [];
  (globalThis as { window?: unknown }).window = new EventTarget();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      const cid = url.split("/").pop() ?? "";
      return new Promise<Response>((resolve) => {
        release.push(() => {
          resolve(
            new Response(JSON.stringify(dto(cid, "2026-10-29T10:00:00.000Z", "old")), {
              status: 200,
            }),
          );
        });
      });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { window?: unknown }).window;
});

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("intent prefetch (Phase 9, INV-31)", () => {
  it("fires once after the delay and the consumer reuses it", async () => {
    const client = new QueryClient();
    const p = createPrefetcher(client, USER);
    p.intent(id(1));
    p.intent(id(1));
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(PREFETCH_DELAY_MS + 1);
    expect(calls).toHaveLength(1);
    release.forEach((r) => {
      r();
    });
    await vi.runAllTimersAsync();
    // Navigation's own read: same key, served from the cache.
    const result = await client.query({ ...conversationQuery(USER, id(1)), staleTime: "static" });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    p.intent(id(1));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS + 1);
    expect(calls).toHaveLength(1);
  });

  it("changed intent before the delay fetches nothing", () => {
    const client = new QueryClient();
    const p = createPrefetcher(client, USER);
    p.intent(id(2));
    p.cancel(id(2));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS * 3);
    expect(calls).toHaveLength(0);
  });

  it("caps concurrent speculative work", async () => {
    const client = new QueryClient();
    const p = createPrefetcher(client, USER);
    for (const n of [3, 4, 5, 6]) p.intent(id(n));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS + 1);
    expect(calls).toHaveLength(2);
    release.forEach((r) => {
      r();
    });
    await vi.runAllTimersAsync();
  });

  it("INV-23: an older prefetch finishing last cannot overwrite newer data", async () => {
    const client = new QueryClient();
    const p = createPrefetcher(client, USER);
    p.intent(id(7));
    vi.advanceTimersByTime(PREFETCH_DELAY_MS + 1);
    expect(calls).toHaveLength(1);
    // A mutation response with newer data arrives while the prefetch is in flight.
    storeConversation(client, USER, dto(id(7), "2026-10-29T12:00:00.000Z", "new"));
    release.forEach((r) => {
      r();
    });
    await flush();
    await vi.runAllTimersAsync();
    const cached = client.getQueryData<{ ok: true; conversation: { title: string } }>(
      qk.conversation(USER, id(7)),
    );
    expect(cached?.conversation.title).toBe("new");
  });
});
