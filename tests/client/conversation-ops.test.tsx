// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useLocation, useParams } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDto, ConversationSummary, SearchResponse } from "@shared/conversations";
import { ConversationView } from "../../app/components/ConversationView";
import { SearchDialog } from "../../app/components/SearchDialog";
import { Sidebar } from "../../app/components/Sidebar";
import { queryKeys } from "../../app/lib/query";
import { ShellProvider } from "../../app/lib/shell-context";
import {
  AppHarness,
  conversation,
  CONV,
  FakeEventSource,
  GEN,
  json,
  message,
  noop,
  seededClient,
  signInStore,
  TEST_USER,
  USER,
} from "./support";

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
  signInStore();
  fetchMock = vi.fn(() => Promise.resolve(json(404, {})));
  vi.stubGlobal("fetch", fetchMock);
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const summary = (id: string, title: string, pinnedRank: number | null): ConversationSummary => ({
  id,
  title,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 2,
  malformed: false,
  pinnedRank,
});

function Page() {
  const { conversationId } = useParams();
  return (
    <ConversationView key={conversationId ?? "new"} userId={USER} conversationId={conversationId} />
  );
}

function renderConversation(conv: ConversationDto, client = seededClient(conv)) {
  render(
    <AppHarness
      client={client}
      initial={`/chat/${CONV}`}
      routes={[{ path: "/chat/:conversationId", element: <Page /> }]}
    />,
  );
  return client;
}

describe("message operations (Phase 13a)", () => {
  const exchange = () =>
    conversation([message(1, "user", "hello"), message(2, "assistant", "hi there")]);

  it("offers edit/delete on user turns and regenerate on replies; all disabled while a reply runs", async () => {
    renderConversation(conversation([message(1, "user", "hello")], GEN));
    const edit = await screen.findByRole<HTMLButtonElement>("button", { name: "Edit message" });
    expect(edit.disabled).toBe(true);
    expect(edit.title).toBe("Stop the reply first");
    cleanup();
    renderConversation(exchange());
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Edit message" }).disabled).toBe(
        false,
      );
    });
    expect(screen.getByRole("button", { name: "Delete message and reply" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Regenerate reply" })).toBeTruthy();
    // An answered user turn has no "Get a reply".
    expect(screen.queryByRole("button", { name: "Get a reply" })).toBeNull();
  });

  it("delete asks first, sends the expected revision and updates the cached conversation", async () => {
    const user = userEvent.setup();
    const conv = exchange();
    const after = { ...conv, revision: "b".repeat(64), messages: [] };
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "DELETE" && url.includes("/messages/") ? json(200, after) : json(404, {}),
      ),
    );
    const client = renderConversation(conv);
    await user.click(await screen.findByRole("button", { name: "Delete message and reply" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this message?" });
    expect(dialog.textContent).toContain("Later replies may refer to it");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(client.getQueryData(queryKeys.conversation(USER, CONV))).toEqual(after);
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(call?.[0]).toBe(
      `/api/conversations/${CONV}/messages/${message(1, "user", "").id}?expectedRevision=${conv.revision}`,
    );
  });

  it("the inline editor: Escape cancels, Save edits without a new reply", async () => {
    const user = userEvent.setup();
    const conv = exchange();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PATCH"
          ? json(200, {
              ...conv,
              revision: "c".repeat(64),
              messages: [message(1, "user", "hello!")],
            })
          : json(404, {}),
      ),
    );
    renderConversation(conv);
    await user.click(await screen.findByRole("button", { name: "Edit message" }));
    await screen.findByRole("form", { name: "Edit message" });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe("edit-message");
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("form", { name: "Edit message" })).toBeNull();
    });
    await user.click(screen.getByRole("button", { name: "Edit message" }));
    const editor = await screen.findByRole("form", { name: "Edit message" });
    const field = within(editor).getByRole("textbox");
    await user.clear(field);
    await user.type(field, "hello!");
    await user.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/conversations/${CONV}/messages/${message(1, "user", "").id}`,
        expect.objectContaining({ method: "PATCH" }),
      );
    });
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      content: "hello!",
      expectedRevision: conv.revision,
    });
    // Save alone never regenerates.
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/regenerate"))).toBe(false);
  });
});

describe("pins in the sidebar", () => {
  it("shows pinned chats first in pin order; pinning updates the cached list", async () => {
    const client = seededClient();
    client.setQueryData(queryKeys.conversations(USER), [
      summary("aaaaaaaa-0000-4000-8000-000000000001", "Alpha", null),
      summary("aaaaaaaa-0000-4000-8000-000000000002", "Beta", 1),
      summary("aaaaaaaa-0000-4000-8000-000000000003", "Gamma", 0),
    ]);
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PUT" && url.endsWith("/pin")
          ? json(200, {
              pins: [
                "aaaaaaaa-0000-4000-8000-000000000003",
                "aaaaaaaa-0000-4000-8000-000000000002",
                "aaaaaaaa-0000-4000-8000-000000000001",
              ],
            })
          : json(404, {}),
      ),
    );
    render(
      <AppHarness
        client={client}
        initial="/chat/new"
        routes={[
          {
            path: "/chat/new",
            element: (
              <Sidebar
                user={TEST_USER}
                hidden={false}
                drawer={false}
                onHide={noop}
                onNavigate={noop}
              />
            ),
          },
        ]}
      />,
    );
    const pinned = await screen.findByTestId("pinned-list");
    expect([...pinned.querySelectorAll(".row-title")].map((n) => n.textContent)).toEqual([
      "Gamma",
      "Beta",
    ]);
    expect(
      [...screen.getByTestId("conversation-list").querySelectorAll(".row-title")].map(
        (n) => n.textContent,
      ),
    ).toEqual(["Alpha"]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() => {
      expect(
        [...screen.getByTestId("pinned-list").querySelectorAll(".row-title")].map(
          (n) => n.textContent,
        ),
      ).toEqual(["Gamma", "Beta", "Alpha"]);
    });
  });
});

describe("search dialog (keyboard)", () => {
  function Where() {
    const location = useLocation();
    return <p data-testid="where">{`${location.pathname}${location.hash}`}</p>;
  }

  it("debounces the query, moves with arrows, opens the chosen message with Enter", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const response: SearchResponse = {
      results: [
        {
          conversationId: CONV,
          title: "Trip",
          messageId: null,
          role: null,
          snippet: { before: "", match: "Trip", after: "" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          conversationId: CONV,
          title: "Trip",
          messageId: "bbbbbbbb-0000-4000-8000-000000000001",
          role: "assistant",
          snippet: { before: "a ", match: "trip", after: " to Rome" },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      truncated: false,
      skippedMalformed: 1,
    };
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.startsWith("/api/search") ? json(200, response) : json(404, {})),
    );
    const client = seededClient();
    const onClose = vi.fn();
    const router = createMemoryRouter(
      [
        {
          path: "*",
          element: (
            <>
              <Where />
              <SearchDialog userId={USER} onClose={onClose} onNavigate={noop} />
            </>
          ),
        },
      ],
      { initialEntries: ["/chat/new"] },
    );
    render(
      <QueryClientProvider client={client}>
        <ShellProvider>
          <RouterProvider router={router} />
        </ShellProvider>
      </QueryClientProvider>,
    );
    const input = screen.getByRole("combobox", { name: "Search chats" });
    fireEvent.change(input, { target: { value: "t" } });
    fireEvent.change(input, { target: { value: "trip" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await screen.findAllByRole("option");
    // One request for the settled text, not one per keystroke.
    expect(fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/search"))).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/search?q=trip");
    expect(screen.getByRole("status").textContent).toContain("1 unreadable chat skipped");
    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe("search-option-1");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByTestId("where").textContent).toBe(
        `/chat/${CONV}#m-bbbbbbbb-0000-4000-8000-000000000001`,
      );
    });
    expect(onClose).toHaveBeenCalledWith(true);
    vi.useRealTimers();
  });
});
