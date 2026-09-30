// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationDto } from "@shared/conversations";
import type { MemoryList, ProposalDto } from "@shared/memories";
import { ConversationView } from "../../app/components/ConversationView";
import MemorySettings from "../../app/components/MemorySettings";
import { authStore } from "../../app/lib/auth-store";
import { createQueryClient, queryKeys } from "../../app/lib/query";
import { useAccountBoundary } from "../../app/lib/use-account-boundary";
import {
  AppHarness,
  conversation,
  CONV,
  FakeEventSource,
  GEN,
  json,
  message,
  seededClient,
  SESSION,
  signInStore,
  USER,
} from "./support";

/** Phase 13b: memory suggestion cards, Settings → Memories, account boundary. */

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

const REPLY_ID = message(2, "assistant", "").id;

function proposal(n: number, extra: Partial<ProposalDto> = {}): ProposalDto {
  return {
    id: `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`,
    generationId: GEN,
    callIndex: n,
    userMessageId: message(1, "user", "").id,
    assistantMessageId: REPLY_ID,
    tool: "create",
    name: `Note ${String(n)}`,
    content: `Fact ${String(n)}`,
    targetMemoryId: null,
    status: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: null,
    resultMemoryId: null,
    ...extra,
  };
}

function withProposals(proposals: ProposalDto[], reply = "Sure."): ConversationDto {
  return {
    ...conversation([message(1, "user", "remember this"), message(2, "assistant", reply)]),
    proposals,
  };
}

function Page() {
  const { conversationId } = useParams();
  return <ConversationView userId={USER} conversationId={conversationId} />;
}

function renderConversation(conv: ConversationDto, client: QueryClient = seededClient(conv)) {
  render(
    <AppHarness
      client={client}
      initial={`/chat/${CONV}`}
      routes={[{ path: "/chat/:conversationId", element: <Page /> }]}
    />,
  );
  return client;
}

describe("memory suggestions under a reply (INV-37)", () => {
  it("shows pending suggestions with Save/Dismiss; Save accepts and updates the cache", async () => {
    const user = userEvent.setup();
    const conv = withProposals([proposal(1), proposal(2, { status: "suppressed" })]);
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST" && url.endsWith("/accept")
          ? json(200, { ...proposal(1), status: "accepted", resultMemoryId: GEN })
          : json(404, {}),
      ),
    );
    const client = renderConversation(conv);
    const region = await screen.findByRole("region", { name: "Memory suggestions" });
    const cards = within(region).getAllByTestId("memory-suggestion");
    // Suppressed suggestions are not shown (not actionable).
    expect(cards).toHaveLength(1);
    expect(cards[0]?.textContent).toContain("Remember “Note 1”");
    const save = within(region).getByRole("button", { name: /Save/ });
    // The buttons are described by the suggestion text.
    expect(save.getAttribute("aria-describedby")).toBeTruthy();
    await user.click(save);
    await waitFor(() => {
      expect(within(region).getByTestId("memory-suggestion").textContent).toContain(
        "Saved to memory",
      );
    });
    // Announced to screen readers too.
    expect(within(region).getByRole("status").textContent).toBe("Saved to memory");
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(call?.[0]).toBe(`/api/conversations/${CONV}/proposals/${proposal(1).id}/accept`);
    const cached = client.getQueryData<ConversationDto>(queryKeys.conversation(USER, CONV));
    expect(cached?.proposals?.[0]?.status).toBe("accepted");
  });

  it("a stale note shows the conflict instead of overwriting", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? json(409, {
              error: { code: "CONFLICT", message: "changed", details: { reason: "note_changed" } },
            })
          : url.startsWith("/api/conversations/")
            ? json(200, withProposals([proposal(1, { tool: "update" })]))
            : json(404, {}),
      ),
    );
    renderConversation(withProposals([proposal(1, { tool: "update" })]));
    await user.click(await screen.findByRole("button", { name: /Save/ }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("wasn’t overwritten");
  });

  it("an empty complete reply says the answer wasn’t generated and offers regenerate", async () => {
    const user = userEvent.setup();
    renderConversation(withProposals([proposal(1)], ""));
    const note = await screen.findByTestId("answer-not-generated");
    await user.click(within(note).getByRole("button", { name: /Regenerate/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("The current reply will be replaced.");
  });

  it("resolved suggestions show their outcome without actions", async () => {
    renderConversation(
      withProposals([
        proposal(1, { status: "rejected" }),
        proposal(2, { status: "invalid" }),
        proposal(3, { status: "accepted", tool: "forget" }),
      ]),
    );
    const region = await screen.findByRole("region", { name: "Memory suggestions" });
    expect(within(region).queryByRole("button")).toBeNull();
    expect(region.textContent).toContain("Dismissed");
    expect(region.textContent).toContain("No longer available");
    expect(region.textContent).toContain("Memory forgotten");
  });

  it("streaming previews are shown but not actionable", async () => {
    renderConversation(conversation([message(1, "user", "hi")], GEN));
    await waitFor(() => {
      expect(FakeEventSource.instances.length).toBeGreaterThan(0);
    });
    const source = FakeEventSource.latest();
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY_ID,
        conversationId: CONV,
        providerId: "local",
        model: "m1",
        state: "streaming",
        content: "Noted",
        reasoning: "",
        finishReason: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
        revision: null,
        lastEventId: 1,
      });
      source.emit("proposals", {
        proposals: [
          {
            id: proposal(1).id,
            callIndex: 0,
            tool: "create",
            name: "Pet",
            content: "Cat",
            status: "pending",
          },
        ],
      });
    });
    const preview = await screen.findByTestId("memory-previews");
    expect(preview.textContent).toContain("“Pet”");
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
  });
});

describe("Settings → Memories", () => {
  const LIST: MemoryList = {
    memories: [
      {
        id: "66666666-6666-4666-8666-000000000001",
        name: "Coffee",
        content: "Flat white",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: "d".repeat(64),
      },
      {
        id: "66666666-6666-4666-8666-000000000002",
        name: "Zeta",
        content: "Long note",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        revision: "e".repeat(64),
      },
    ],
    omittedIds: ["66666666-6666-4666-8666-000000000002"],
    promptBudgetBytes: 40,
    unreadable: 0,
    limits: { nameMax: 64, contentMaxBytes: 4096, totalMaxBytes: 65536, maxCount: 200 },
  };

  function renderSettings(client = createQueryClient()) {
    render(
      <QueryClientProvider client={client}>
        <MemorySettings userId={USER} />
      </QueryClientProvider>,
    );
    return client;
  }

  it("lists memories, marks notes left out of prompts and edits with the expected revision", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "PATCH"
          ? json(200, { ...LIST.memories[0], content: "Oat flat white" })
          : url === "/api/memories"
            ? json(200, LIST)
            : json(404, {}),
      ),
    );
    renderSettings();
    const rows = await screen.findAllByTestId("memory-row");
    expect(rows).toHaveLength(2);
    expect(rows[1]?.textContent).toContain("Not included in chats");
    expect(screen.getByRole("note").textContent).toContain("1 note doesn’t fit");
    await user.click(screen.getByRole("button", { name: "Edit Coffee" }));
    const textarea = screen.getByLabelText("Note");
    await user.clear(textarea);
    await user.type(textarea, "Oat flat white");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toBe(`/api/memories/${LIST.memories[0]?.id ?? ""}`);
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({
      name: "Coffee",
      content: "Oat flat white",
      expectedRevision: "d".repeat(64),
    });
  });

  it("rejects an invalid name before sending and shows the server's conflict", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === "POST"
          ? json(409, {
              error: { code: "CONFLICT", message: 'A memory named "coffee" already exists' },
            })
          : url === "/api/memories"
            ? json(200, { ...LIST, memories: [], omittedIds: [] })
            : json(404, {}),
      ),
    );
    renderSettings();
    await screen.findByTestId("memories-empty");
    await user.click(screen.getByRole("button", { name: /Add/ }));
    await user.type(screen.getByLabelText("Name"), "   ");
    await user.type(screen.getByLabelText("Note"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The name must be");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "coffee");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("already exists");
    });
  });
});

describe("account switch (INV-39)", () => {
  function Boundary({ client }: { client: QueryClient }) {
    useAccountBoundary(client);
    return null;
  }

  it("drops the previous user's memories and conversation suggestions", () => {
    const client = createQueryClient();
    client.setQueryData(queryKeys.memories(USER), { memories: [] });
    client.setQueryData(queryKeys.conversation(USER, CONV), withProposals([proposal(1)]));
    const router = createMemoryRouter([{ path: "/", element: <Boundary client={client} /> }]);
    render(<RouterProvider router={router} />);
    const OTHER = "99999999-9999-4999-8999-999999999999";
    act(() => {
      authStore.applySession({ ...SESSION, user: { id: OTHER, username: "bob", role: "user" } });
    });
    expect(client.getQueryData(queryKeys.memories(USER))).toBeUndefined();
    expect(client.getQueryData(queryKeys.conversation(USER, CONV))).toBeUndefined();
    // Every memory key is scoped by user id.
    expect(queryKeys.memories(OTHER)).toEqual(["user", OTHER, "memories"]);
  });
});
