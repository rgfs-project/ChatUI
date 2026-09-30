// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "../../app/components/ConversationView";
import { Sidebar } from "../../app/components/Sidebar";
import { queryKeys } from "../../app/lib/query";
import { renderCounters } from "../../app/lib/render-counters";
import {
  AppHarness,
  conversation,
  CONV,
  FakeEventSource,
  GEN,
  json,
  message,
  noop,
  REPLY,
  seededClient,
  signInStore,
  TEST_USER,
  USER,
} from "./support";

function Page(props: { initialError?: { status: number; code: string } }) {
  const { conversationId } = useParams();
  return (
    <>
      <Sidebar user={TEST_USER} hidden={false} drawer={false} onHide={noop} onNavigate={noop} />
      <ConversationView
        key={conversationId ?? "new"}
        userId={USER}
        conversationId={conversationId}
        initialError={props.initialError ?? null}
      />
    </>
  );
}

function renderAt(
  initial: string,
  client = seededClient(),
  initialError?: { status: number; code: string },
) {
  const page = <Page {...(initialError ? { initialError } : {})} />;
  return render(
    <AppHarness
      client={client}
      initial={initial}
      routes={[
        { path: "/chat/new", element: page },
        { path: "/chat/:conversationId", element: page },
      ]}
    />,
  );
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  signInStore();
  // jsdom has no layout or scrolling.
  Element.prototype.scrollTo = () => undefined;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(json(200, {})));
  vi.stubGlobal("fetch", fetchMock);
  for (const key of Object.keys(renderCounters) as (keyof typeof renderCounters)[])
    renderCounters[key] = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const history = [
  message(1, "user", "first question"),
  message(2, "assistant", "first *answer*"),
  message(3, "user", "second question"),
  message(4, "assistant", "second answer"),
];

describe("streaming state transitions", () => {
  it("observes the active generation: pending → streaming → terminal, composer locked meanwhile", async () => {
    const conv = conversation(history, GEN);
    const client = seededClient(conv);
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith(`/api/conversations/${CONV}`)
          ? json(200, conversation([...history, message(5, "assistant", "done!", { id: REPLY })]))
          : json(200, { conversations: [] }),
      ),
    );
    renderAt(`/chat/${CONV}`, client);
    const source = FakeEventSource.latest();
    expect(source.url).toBe(`/api/generations/${GEN}/stream`);
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "pending",
        content: "",
        reasoning: "",
        error: null,
      });
    });
    expect(screen.getByTestId("generation-status").textContent).toContain("Waiting for the model");
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    act(() => {
      source.emit("state", { state: "streaming" });
      source.emit("delta", { reasoning: "thinking" });
      source.emit("delta", { content: "do" });
      source.emit("delta", { content: "ne!" });
    });
    expect(screen.getByTestId("generation-status").textContent).toContain("Generating");
    expect(screen.getByTestId("content").textContent).toBe("done!");
    expect(screen.getByTestId("reasoning").hasAttribute("open")).toBe(false);

    act(() => {
      source.emit("terminal", { state: "completed", error: null });
    });
    expect(source.closed).toBe(true);
    // The stored copy replaces the live one once the transcript refetches.
    await waitFor(() => {
      expect(screen.queryByTestId("response")).toBeNull();
    });
    expect(screen.getAllByTestId("message-assistant").at(-1)?.textContent).toContain("done!");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("resync replaces the live state wholesale", () => {
    renderAt(`/chat/${CONV}`, seededClient(conversation(history, GEN)));
    const source = FakeEventSource.latest();
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "streaming",
        content: "abc",
        reasoning: "",
        error: null,
      });
      source.emit("resync", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "streaming",
        content: "abcdef",
        reasoning: "",
        error: null,
      });
      source.emit("delta", { content: "g" });
    });
    expect(screen.getByTestId("content").textContent).toBe("abcdefg");
  });

  it("a failed terminal state shows its error", () => {
    renderAt(`/chat/${CONV}`, seededClient(conversation(history, GEN)));
    const source = FakeEventSource.latest();
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "streaming",
        content: "par",
        reasoning: "",
        error: null,
      });
      source.emit("terminal", {
        state: "failed",
        error: { code: "PROVIDER_UNAVAILABLE", message: "The provider went away" },
      });
    });
    expect(screen.getByTestId("generation-status").textContent).toBe(
      "Failed — The provider went away",
    );
  });

  it("stored reply statuses are labelled", () => {
    renderAt(
      `/chat/${CONV}`,
      seededClient(
        conversation([
          message(1, "assistant", "a", { status: "cancelled" }),
          message(2, "assistant", "b", { status: "failed" }),
          message(3, "assistant", "c", { status: "timed_out" }),
          message(4, "assistant", "d", { status: "interrupted" }),
        ]),
      ),
    );
    const labels = screen.getAllByTestId("message-assistant").map((li) => li.textContent);
    expect(labels[0]).toContain("Stopped");
    expect(labels[1]).toContain("Failed");
    expect(labels[2]).toContain("Timed out");
    expect(labels[3]).toContain("Interrupted");
  });
});

describe("render isolation (INV-32 groundwork)", () => {
  it("a streaming token re-renders only the growing message, never remounts unrelated UI", () => {
    renderAt(`/chat/${CONV}`, seededClient(conversation(history, GEN)));
    const source = FakeEventSource.latest();
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "streaming",
        content: "",
        reasoning: "",
        error: null,
      });
    });
    const before = { ...renderCounters };
    expect(before.messageMounts).toBe(history.length);
    expect(before.sidebarMounts).toBe(1);
    const chunks = ["```ts\n", "const a", " = 1;\n", "| x |", "\n| - |\n", "- item"];
    for (const chunk of chunks) {
      act(() => {
        source.emit("delta", { content: chunk });
      });
    }
    expect(renderCounters.messageMounts).toBe(before.messageMounts);
    expect(renderCounters.messageRenders).toBe(before.messageRenders);
    expect(renderCounters.sidebarMounts).toBe(1);
    expect(renderCounters.sidebarRenders).toBe(before.sidebarRenders);
    expect(screen.getByTestId("content").querySelector("pre code")?.textContent).toContain(
      "const a = 1;",
    );
  });
});

describe("INV-32: streaming into a 200-message conversation", () => {
  it("incomplete Markdown tokens re-render only the growing reply", () => {
    const long = Array.from({ length: 200 }, (_, n) =>
      message(n + 1, n % 2 ? "assistant" : "user", `message ${String(n)} with *markdown*`),
    );
    renderAt(`/chat/${CONV}`, seededClient(conversation(long, GEN)));
    const source = FakeEventSource.latest();
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "streaming",
        content: "",
        reasoning: "",
        error: null,
      });
    });
    const before = { ...renderCounters };
    expect(before.messageMounts).toBe(200);
    // Prose, an open fence, a growing table and nested lists, token by token.
    const answer =
      "Intro with **bold** text.\n\n```ts\nconst x = 1;\nconst y = 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\n- one\n  - two\n    1. three\n";
    for (let i = 0; i < answer.length; i += 4) {
      act(() => {
        source.emit("delta", { content: answer.slice(i, i + 4) });
      });
    }
    expect(renderCounters.messageMounts).toBe(before.messageMounts);
    expect(renderCounters.messageRenders).toBe(before.messageRenders);
    expect(renderCounters.sidebarMounts).toBe(1);
    expect(renderCounters.sidebarRenders).toBe(before.sidebarRenders);
    const content = screen.getByTestId("content");
    expect(content.querySelector("pre code")?.textContent).toContain("const y = 2;");
    expect(content.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(content.querySelector("ul ul ol li")?.textContent).toBe("three");
    // Older text is still in the document (no virtualization): find-in-page works.
    expect(screen.getByText("message 3 with", { exact: false })).toBeTruthy();
  });
});

describe("malformed and missing conversations", () => {
  it("malformed: explains the problem and offers only delete (with confirmation)", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "DELETE" ? json(200, { deleted: true }) : json(200, { conversations: [] }),
      ),
    );
    renderAt(`/chat/${CONV}`, seededClient(), { status: 422, code: "CONVERSATION_MALFORMED" });
    const state = await screen.findByTestId("malformed-state");
    expect(state.textContent).toContain("can’t be opened");
    expect(
      within(state)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Delete conversation"]);
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    await user.click(within(state).getByRole("button", { name: "Delete conversation" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this conversation?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === `/api/conversations/${CONV}` && init?.method === "DELETE",
        ),
      ).toBe(true);
    });
  });

  it("missing: a data error, not a silent create", () => {
    renderAt(`/chat/${CONV}`, seededClient(), { status: 404, code: "NOT_FOUND" });
    expect(screen.getByTestId("missing-state").textContent).toContain("does not exist");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});

describe("composer keyboard", () => {
  it("Shift+Enter adds a newline; Enter sends with an operation key", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        url === "/api/generations" && init?.method === "POST"
          ? json(202, {
              conversationId: CONV,
              generationId: GEN,
              userMessageId: "55555555-5555-4555-8555-555555555555",
              assistantMessageId: REPLY,
            })
          : url.startsWith("/api/conversations/")
            ? json(200, conversation(history))
            : json(200, { conversations: [] }),
      ),
    );
    renderAt(`/chat/${CONV}`, seededClient(conversation(history)));
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
    await user.click(box);
    await user.keyboard("line one{Shift>}{Enter}{/Shift}line two");
    expect(box.value).toBe("line one\nline two");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/generations")).toBe(false);
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/generations")).toBe(true);
    });
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/generations") ?? [];
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      conversationId: CONV,
      providerId: "local",
      model: "m1",
      content: "line one\nline two",
    });
    expect(body.operationKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(box.value).toBe("");
    });
  });

  it("an empty composer does not send", () => {
    renderAt(`/chat/${CONV}`, seededClient(conversation(history)));
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/generations")).toBe(false);
  });

  it("drafts survive navigating away and back within the shell", async () => {
    const user = userEvent.setup();
    const client = seededClient(conversation(history));
    client.setQueryData(queryKeys.conversations(USER), [
      {
        id: CONV,
        title: "Test chat",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        messageCount: 4,
        malformed: false,
      },
    ]);
    renderAt("/chat/new", client);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "keep me");
    await user.click(screen.getByRole("link", { name: "Test chat" }));
    await screen.findByText("second question");
    expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe("");
    await user.click(screen.getByRole("link", { name: /New chat/ }));
    await waitFor(() => {
      expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" }).value).toBe(
        "keep me",
      );
    });
  });
});
