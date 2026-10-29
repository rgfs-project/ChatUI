// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendTiming } from "../../app/chat/chat-context";
import { SESSION_EXPIRED_EVENT, apiFetch, setSession } from "../../app/lib/api";
import { qk } from "../../app/lib/query/keys";
import { storeConversation } from "../../app/lib/query/queries";
import { ErrorBoundary } from "../../app/ui/error-boundary";
import {
  chatApp,
  CONV,
  conversation,
  FakeEventSource,
  MODELS,
  seededClient,
  USER,
} from "./harness";

const accepted = {
  conversationId: CONV,
  generationId: "9e9e9e9e-0000-4000-8000-000000000009",
  userMessageId: "11111111-0000-4000-8000-000000000009",
  assistantMessageId: "11111111-0000-4000-8000-00000000000a",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let posts: string[];
let generations: ((body: string) => Promise<Response>) | null;

beforeEach(() => {
  posts = [];
  generations = null;
  sendTiming.baseDelayMs = 1;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  setSession({ user: USER, csrfToken: "tok", registrationOpen: false });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === "/api/generations" && init.method === "POST") {
        posts.push(init.body as string);
        return generations
          ? generations(init.body as string)
          : Promise.resolve(json(202, accepted));
      }
      if (url.startsWith("/api/conversations/")) return Promise.resolve(json(200, conversation()));
      return Promise.resolve(json(200, { conversations: [] }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendTiming.baseDelayMs = 1_000;
});

async function typeAndSend(text: string) {
  const box = await screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  fireEvent.input(box, { target: { value: text } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  fireEvent.keyDown(box, { key: "Enter" });
  return box;
}

describe("optimistic sends (contracts §4.1)", () => {
  it("an explicit rejection rolls the message back and restores the draft", async () => {
    generations = () =>
      Promise.resolve(json(400, { error: { code: "VALIDATION", message: "Too long" } }));
    render(<App at="/chat/new" />);
    const box = await typeAndSend("rejected text");
    await vi.waitFor(() => {
      expect(box.value).toBe("rejected text");
    });
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(posts).toHaveLength(1);
  });

  it("a dropped 202 is resent with the same operation key", async () => {
    let calls = 0;
    generations = () =>
      ++calls === 1
        ? Promise.reject(new TypeError("network"))
        : Promise.resolve(json(202, accepted));
    render(<App at="/chat/new" />);
    await typeAndSend("resend me");
    await vi.waitFor(() => {
      expect(posts).toHaveLength(2);
    });
    const keys = posts.map((b) => (JSON.parse(b) as { operationKey: string }).operationKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("exhausted retries leave an 'outcome unknown' message, never a fresh key", async () => {
    generations = () => Promise.resolve(new Response("bad gateway", { status: 502 }));
    render(<App at="/chat/new" />);
    await typeAndSend("unknown fate");
    expect(await screen.findByText(/Not sure this was sent/)).toBeTruthy();
    expect(
      new Set(posts.map((b) => (JSON.parse(b) as { operationKey: string }).operationKey)).size,
    ).toBe(1);
    expect(posts).toHaveLength(4);
  });

  it("OPERATION_EXPIRED is an unknown outcome, not a rejection", async () => {
    generations = () =>
      Promise.resolve(json(409, { error: { code: "OPERATION_EXPIRED", message: "expired" } }));
    render(<App at="/chat/new" />);
    await typeAndSend("old key");
    expect(await screen.findByText(/Not sure this was sent/)).toBeTruthy();
    expect(posts).toHaveLength(1);
  });

  it("Strict Mode double mounting never duplicates the send", async () => {
    const Inner = chatApp(seededClient());
    render(
      <StrictMode>
        <Inner at="/chat/new" />
      </StrictMode>,
    );
    await typeAndSend("strict");
    await vi.waitFor(() => {
      expect(posts.length).toBeGreaterThan(0);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(posts).toHaveLength(1);
  });
});

function App({ at }: { at: string }) {
  const Inner = chatApp(seededClient());
  return <Inner at={at} />;
}

describe("INV-23: a stale response never overwrites newer state", () => {
  it("an older conversation version is ignored", () => {
    const client = seededClient({
      ok: true,
      conversation: conversation({ updatedAt: "2026-10-29T12:00:00.000Z", title: "New" }),
    });
    expect(
      storeConversation(
        client,
        USER.id,
        conversation({ updatedAt: "2026-10-29T11:00:00.000Z", title: "Old" }),
      ),
    ).toBe(false);
    const cached = client.getQueryData<{ ok: true; conversation: { title: string } }>(
      qk.conversation(USER.id, CONV),
    );
    expect(cached?.conversation.title).toBe("New");
    expect(
      storeConversation(
        client,
        USER.id,
        conversation({ updatedAt: "2026-10-29T13:00:00.000Z", title: "Newer" }),
      ),
    ).toBe(true);
  });
});

describe("empty states", () => {
  it("no models: the composer explains it", async () => {
    const client = seededClient();
    client.setQueryData(qk.models(USER.id), []);
    const Inner = chatApp(client);
    render(<Inner at="/chat/new" />);
    expect((await screen.findByTestId("model-notice")).textContent).toMatch(
      /No models are available/,
    );
  });

  it("all providers unreachable: the composer says so", async () => {
    const client = seededClient();
    client.setQueryData(
      qk.models(USER.id),
      MODELS.map((g) => ({
        ...g,
        provider: { ...g.provider, status: "unavailable" as const },
        models: [],
      })),
    );
    const Inner = chatApp(client);
    render(<Inner at="/chat/new" />);
    expect((await screen.findByTestId("model-notice")).textContent).toMatch(/can't be reached/);
  });
});

describe("session expiry signal", () => {
  it("the first 401 reports the expiry once for the signed-in user", async () => {
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent<{ userId: string }>).detail.userId);
    window.addEventListener(SESSION_EXPIRED_EVENT, listener);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json(401, { error: { code: "UNAUTHENTICATED", message: "x" } }))),
    );
    await apiFetch("/api/conversations");
    await apiFetch("/api/models");
    window.removeEventListener(SESSION_EXPIRED_EVENT, listener);
    expect(seen).toEqual([USER.id]);
  });
});

describe("error boundaries", () => {
  it("contain a failing area and recover with Retry", async () => {
    let fail = true;
    function Flaky() {
      if (fail) throw new Error("boom");
      return <p>recovered</p>;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary area="Transcript">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/could not be shown/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("recovered")).toBeTruthy();
    spy.mockRestore();
  });
});
