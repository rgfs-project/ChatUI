// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatApp, CONV, conversation, FakeEventSource, GEN, seededClient } from "./harness";

let events: string[];
const count = (event: string) => events.filter((e) => e === event).length;
/** TanStack Query notifies observers on a timer; let those notifications land. */
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  events = [];
  FakeEventSource.instances = [];
  (globalThis as { __chatuiRenderProbe?: (e: string) => void }).__chatuiRenderProbe = (e) =>
    events.push(e);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  delete (globalThis as { __chatuiRenderProbe?: unknown }).__chatuiRenderProbe;
  vi.unstubAllGlobals();
});

const snapshot = (state: string, content: string) => ({
  generationId: GEN,
  assistantMessageId: "22222222-0000-4000-8000-000000000001",
  conversationId: CONV,
  providerId: "local",
  model: "mock-chat",
  state,
  content,
  reasoning: "",
  finishReason: null,
  error: null,
  createdAt: "",
  finishedAt: null,
  revision: null,
  lastEventId: 1,
  tools: [],
  proposals: [],
});

describe("INV-32: a streaming token re-renders only the live reply", () => {
  it("deltas never remount or re-render the sidebar, stored messages or composer", async () => {
    const client = seededClient({
      ok: true,
      conversation: conversation({ activeGeneration: { generationId: GEN } }),
    });
    const App = chatApp(client);
    render(<App at={`/chat/${CONV}`} />);
    await screen.findByText("Hello", { selector: ".bubble" });
    const source = FakeEventSource.instances.at(-1);
    expect(source?.url).toBe(`/api/generations/${GEN}/stream`);
    await act(async () => {
      await Promise.resolve();
      source?.emit("snapshot", snapshot("streaming", ""));
    });
    await flush();
    const before = {
      sidebar: count("render:Sidebar"),
      message: count("render:Message:11111111-0000-4000-8000-000000000002"),
      composer: count("render:Composer"),
      live: count("render:LiveReply"),
    };
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        await Promise.resolve();
        source?.emit("delta", { content: `tok${String(i)} ` });
      });
    }
    await flush();
    expect(screen.getByTestId("content").textContent).toContain("tok19");
    expect(count("render:Sidebar")).toBe(before.sidebar);
    expect(count("render:Message:11111111-0000-4000-8000-000000000002")).toBe(before.message);
    expect(count("render:Composer")).toBe(before.composer);
    // Notifications are batched, so 20 tokens cost at most 20 live-reply renders.
    expect(count("render:LiveReply")).toBeGreaterThan(before.live);
    for (const name of ["Sidebar", "Composer", "ChatView", "LiveReply"])
      expect(count(`mount:${name}`)).toBe(1);
  });

  it("an unfinished fence, table and list render while streaming", async () => {
    const client = seededClient({
      ok: true,
      conversation: conversation({ activeGeneration: { generationId: GEN } }),
    });
    const App = chatApp(client);
    render(<App at={`/chat/${CONV}`} />);
    await screen.findByText("Hello", { selector: ".bubble" });
    const source = FakeEventSource.instances.at(-1);
    await act(async () => {
      await Promise.resolve();
      source?.emit("snapshot", snapshot("streaming", ""));
    });
    const pieces = [
      "- one\n  - two\n\n| a | b |\n|---|---|\n| 1 |",
      " 2 |\n\n```js\nconst x",
      " = 1;\n",
    ];
    for (const p of pieces) {
      await act(async () => {
        await Promise.resolve();
        source?.emit("delta", { content: p });
      });
    }
    await flush();
    const live = screen.getByTestId("live-reply");
    expect(live.querySelector("ul ul")).not.toBeNull();
    expect(live.querySelector("td")?.textContent).toBe("1");
    expect(live.querySelector(".code-block pre")?.textContent).toContain("const x = 1;");
  });
});
