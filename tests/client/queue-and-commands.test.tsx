// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager } from "@tanstack/react-query";
import { useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "../../app/components/ConversationView";
import { queryKeys } from "../../app/lib/query";
import {
  AppHarness,
  conversation,
  CONV,
  FakeEventSource,
  GEN,
  json,
  message,
  MODELS,
  REPLY,
  seededClient,
  USER,
} from "./support";

/** User-requested composer features: queued messages and "/" commands. */

const GEN2 = "55555555-5555-4555-8555-555555555555";
const REPLY2 = "66666666-6666-4666-8666-666666666666";

function Page() {
  const { conversationId } = useParams();
  return (
    <ConversationView key={conversationId ?? "new"} userId={USER} conversationId={conversationId} />
  );
}

function renderAt(initial: string, client = seededClient()) {
  return render(
    <AppHarness
      client={client}
      initial={initial}
      routes={[
        { path: "/chat/new", element: <Page /> },
        { path: "/chat/:conversationId", element: <Page /> },
        { path: "/settings", element: <p>settings page</p> },
      ]}
    />,
  );
}

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
const posts = (url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && init?.method === "POST");

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(json(200, {})));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const history = [message(1, "user", "hello"), message(2, "assistant", "hi there")];

/** A conversation whose reply GEN is running, streaming "partial". */
function startRunning() {
  const client = seededClient(conversation(history, GEN));
  renderAt(`/chat/${CONV}`, client);
  const source = FakeEventSource.latest();
  act(() => {
    source.emit("snapshot", {
      generationId: GEN,
      assistantMessageId: REPLY,
      state: "streaming",
      content: "partial",
      reasoning: "",
      error: null,
    });
  });
  return source;
}

const box = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

describe("queued messages", () => {
  it("queues while a reply runs, shows it as a pending bubble and sends it after the reply", async () => {
    const user = userEvent.setup();
    const source = startRunning();
    const finished = conversation([
      ...history,
      message(3, "assistant", "partial done", { id: REPLY }),
    ]);
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/generations" && init?.method === "POST")
        return Promise.resolve(
          json(202, { generationId: GEN2, assistantMessageId: REPLY2, conversationId: CONV }),
        );
      if (url === `/api/conversations/${CONV}`) return Promise.resolve(json(200, finished));
      return Promise.resolve(json(200, { conversations: [] }));
    });

    await user.type(box(), "follow up{Enter}");
    expect(box().value).toBe("");
    expect(posts("/api/generations")).toHaveLength(0);
    const queued = screen.getByTestId("message-queued");
    expect(queued.textContent).toContain("follow up");
    expect(queued.textContent).toContain("Queued");
    // Still streaming: Stop stays available.
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();

    act(() => {
      source.emit("terminal", { state: "completed", error: null });
    });
    await waitFor(() => {
      expect(posts("/api/generations")).toHaveLength(1);
    });
    const body = JSON.parse(posts("/api/generations")[0]?.[1]?.body as string) as {
      content: string;
      conversationId: string;
    };
    expect(body).toMatchObject({ content: "follow up", conversationId: CONV });
    await waitFor(() => {
      expect(screen.queryByTestId("message-queued")).toBeNull();
    });
  });

  it("offers a queue button while a reply runs and something is typed", async () => {
    const user = userEvent.setup();
    startRunning();
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
    await user.type(box(), "later");
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(screen.getByTestId("message-queued").textContent).toContain("later");
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();
  });

  it("a queued message can be removed before it is sent", async () => {
    const user = userEvent.setup();
    startRunning();
    await user.type(box(), "one{Enter}");
    await user.type(box(), "two{Enter}");
    expect(screen.getAllByTestId("message-queued")).toHaveLength(2);
    const first = screen.getAllByTestId("message-queued")[0];
    if (!first) throw new Error("missing");
    await user.click(within(first).getByRole("button", { name: "Remove queued message" }));
    const left = screen.getAllByTestId("message-queued");
    expect(left).toHaveLength(1);
    expect(left[0]?.textContent).toContain("two");
  });

  it("Stop returns queued messages to the box, in order, before any draft", async () => {
    const user = userEvent.setup();
    startRunning();
    await user.type(box(), "one{Enter}");
    await user.type(box(), "two{Enter}");
    await user.type(box(), "draft");
    await user.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(box().value).toBe("one\n\ntwo\n\ndraft");
    expect(screen.queryByTestId("message-queued")).toBeNull();
    expect(posts(`/api/generations/${GEN}/cancel`)).toHaveLength(1);
  });

  it("a failed reply pauses the queue: messages return to the box, nothing is sent", async () => {
    const user = userEvent.setup();
    const source = startRunning();
    await user.type(box(), "queued{Enter}");
    act(() => {
      source.emit("terminal", { state: "failed", error: { code: "X", message: "boom" } });
    });
    expect(box().value).toBe("queued");
    expect(screen.getByTestId("status").textContent).toContain("queued messages are back");
    expect(posts("/api/generations")).toHaveLength(0);
  });
});

describe('"/" commands', () => {
  const options = () =>
    within(screen.getByRole("listbox", { name: "Commands" }))
      .getAllByRole("option")
      .map((o) => o.querySelector(".command-name")?.textContent);

  it("typing / lists commands; typing more filters them", async () => {
    const user = userEvent.setup();
    renderAt(`/chat/${CONV}`, seededClient(conversation(history)));
    expect(screen.queryByRole("listbox")).toBeNull();
    await user.type(box(), "/");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    expect(options()).toEqual(["model", "new", "rename", "delete", "settings"]);
    await user.type(box(), "se");
    expect(options()).toEqual(["settings"]);
    await user.type(box(), " x");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("arrow keys move the highlighted option (the box keeps focus); Escape closes", async () => {
    const user = userEvent.setup();
    renderAt(`/chat/${CONV}`, seededClient(conversation(history)));
    await user.type(box(), "/");
    expect(box().getAttribute("aria-activedescendant")).toBe("command-model");
    await user.keyboard("{ArrowDown}");
    expect(box().getAttribute("aria-activedescendant")).toBe("command-new");
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(box().getAttribute("aria-activedescendant")).toBe("command-settings");
    expect(document.activeElement).toBe(box());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("Enter runs the command instead of sending: /rename opens the rename dialog", async () => {
    const user = userEvent.setup();
    renderAt(`/chat/${CONV}`, seededClient(conversation(history)));
    await user.type(box(), "/ren{Enter}");
    expect(await screen.findByRole("dialog", { name: "Rename conversation" })).toBeTruthy();
    // The modal hides the page from assistive tech; read the box directly.
    expect(document.querySelector<HTMLTextAreaElement>("#message")?.value).toBe("");
    expect(posts("/api/generations")).toHaveLength(0);
  });

  it("a new chat offers no rename/delete; clicking /settings opens settings", async () => {
    const user = userEvent.setup();
    renderAt("/chat/new");
    await user.type(box(), "/");
    expect(options()).not.toContain("rename");
    await user.click(screen.getByRole("option", { name: /^settings/ }));
    expect(await screen.findByText("settings page")).toBeTruthy();
  });
});

describe("model list refresh", () => {
  it("re-reads the model list (bypassing the server cache) when the tab regains focus", async () => {
    const client = seededClient(conversation(history));
    // Older than the refresh interval.
    client.setQueryData(queryKeys.models(USER), MODELS, { updatedAt: Date.now() - 60_000 });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(json(200, url.startsWith("/api/models") ? MODELS : conversation(history))),
    );
    renderAt(`/chat/${CONV}`, client);
    expect(screen.queryByRole("button", { name: "Refresh models" })).toBeNull();
    act(() => {
      focusManager.setFocused(false);
    });
    act(() => {
      focusManager.setFocused(true);
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/models?refresh=1")).toBe(true);
    });
    focusManager.setFocused(undefined);
  });

  it("does not re-read a fresh list on focus", () => {
    renderAt(`/chat/${CONV}`, seededClient(conversation(history)));
    act(() => {
      focusManager.setFocused(false);
    });
    act(() => {
      focusManager.setFocused(true);
    });
    expect(fetchMock.mock.calls.some(([url]) => url.startsWith("/api/models"))).toBe(false);
    focusManager.setFocused(undefined);
  });
});
