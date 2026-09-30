// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../app/components/Sidebar";
import { endIntent, HOVER_DELAY_MS, resetPrefetchForTests } from "../../app/lib/prefetch";
import { getQueryClient, queryKeys, resetQueryClientForTests } from "../../app/lib/query";
import { clientLoader } from "../../app/routes/chat-conversation";
import { conversation, CONV, json, message, noop, signInStore, TEST_USER, USER } from "./support";

const B = "88888888-8888-4888-8888-888888888888";
const summary = (id: string, title: string) => ({
  id,
  title,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 1,
  malformed: false,
});

interface Pending {
  url: string;
  priority: string | undefined;
  aborted: boolean;
  resolve: (r: Response) => void;
}
let requests: Pending[];

beforeEach(() => {
  signInStore();
  resetQueryClientForTests();
  resetPrefetchForTests();
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const entry: Pending = {
            url,
            priority: init?.priority,
            aborted: false,
            resolve,
          };
          init?.signal?.addEventListener("abort", () => {
            entry.aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
          requests.push(entry);
        }),
    ),
  );
});
afterEach(() => {
  endIntent();
  cleanup();
  vi.unstubAllGlobals();
});

const forConversation = (id: string) =>
  requests.filter((r) => r.url === `/api/conversations/${id}`);
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

function renderSidebar() {
  const client = getQueryClient();
  client.setQueryData(queryKeys.conversations(USER), [summary(CONV, "Alpha"), summary(B, "Beta")]);
  const router = createMemoryRouter(
    [
      {
        path: "/chat/new",
        element: (
          <Sidebar user={TEST_USER} hidden={false} drawer={false} onHide={noop} onNavigate={noop} />
        ),
      },
      {
        path: "/chat/:conversationId",
        loader: clientLoader as never,
        element: (
          <Sidebar user={TEST_USER} hidden={false} drawer={false} onHide={noop} onNavigate={noop} />
        ),
      },
    ],
    { initialEntries: ["/chat/new"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, client, link: (name: string) => screen.getByRole("link", { name }) };
}

describe("INV-31: bounded intent prefetch", () => {
  it("hover prefetches once, at low priority, after a short delay", async () => {
    const { link } = renderSidebar();
    fireEvent.pointerEnter(link("Alpha"), { pointerType: "mouse" });
    expect(forConversation(CONV)).toHaveLength(0);
    await wait(HOVER_DELAY_MS + 20);
    expect(forConversation(CONV)).toHaveLength(1);
    expect(forConversation(CONV)[0]?.priority).toBe("low");
    fireEvent.pointerEnter(link("Alpha"), { pointerType: "mouse" });
    await wait(HOVER_DELAY_MS + 20);
    expect(forConversation(CONV)).toHaveLength(1);
  });

  it("a brief pass over a link, or a touch, fetches nothing", async () => {
    const { link } = renderSidebar();
    fireEvent.pointerEnter(link("Alpha"), { pointerType: "mouse" });
    fireEvent.pointerLeave(link("Alpha"), { pointerType: "mouse" });
    fireEvent.pointerEnter(link("Beta"), { pointerType: "touch" });
    await wait(HOVER_DELAY_MS + 20);
    expect(requests.filter((r) => r.url.startsWith("/api/conversations/"))).toHaveLength(0);
  });

  it("a changed intent aborts the previous speculation (at most one in flight)", async () => {
    const { link } = renderSidebar();
    fireEvent.pointerEnter(link("Alpha"), { pointerType: "mouse" });
    await wait(HOVER_DELAY_MS + 20);
    fireEvent.pointerLeave(link("Alpha"), { pointerType: "mouse" });
    fireEvent.focus(link("Beta")); // keyboard focus: immediate
    await waitFor(() => {
      expect(forConversation(B)).toHaveLength(1);
    });
    expect(forConversation(CONV)[0]?.aborted).toBe(true);
    const inFlight = requests.filter((r) => r.url.startsWith("/api/conversations/") && !r.aborted);
    expect(inFlight).toHaveLength(1);
  });

  it("clicking after hover reuses the in-flight prefetch: one request, never cancelled", async () => {
    const { link, router } = renderSidebar();
    fireEvent.pointerEnter(link("Alpha"), { pointerType: "mouse" });
    await wait(HOVER_DELAY_MS + 20);
    fireEvent.click(link("Alpha"));
    fireEvent.pointerLeave(link("Alpha"), { pointerType: "mouse" });
    await wait(10);
    const [only] = forConversation(CONV);
    expect(forConversation(CONV)).toHaveLength(1);
    expect(only?.aborted).toBe(false);
    act(() => {
      only?.resolve(json(200, conversation([message(1, "user", "hi")])));
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/chat/${CONV}`);
    });
    expect(forConversation(CONV)).toHaveLength(1);
  });

  it("INV-23: an old prefetch answering last never overwrites newer data", async () => {
    const { link, client } = renderSidebar();
    // Cached earlier, now out of date: hovering speculatively refreshes it.
    client.setQueryData(
      queryKeys.conversation(USER, CONV),
      conversation([message(1, "user", "cached")]),
    );
    await client.invalidateQueries({
      queryKey: queryKeys.conversation(USER, CONV),
      refetchType: "none",
    });
    fireEvent.pointerEnter(link("Alpha"), { pointerType: "mouse" });
    await wait(HOVER_DELAY_MS + 20);
    const stale = forConversation(CONV)[0];
    // Newer state is requested (as a mounted view does after a send): the
    // refetch cancels the in-flight speculation and starts a fresh request.
    const refetch = client.refetchQueries({
      queryKey: queryKeys.conversation(USER, CONV),
      type: "all",
    });
    await waitFor(() => {
      expect(forConversation(CONV)).toHaveLength(2);
    });
    const fresh = forConversation(CONV)[1];
    act(() => {
      fresh?.resolve(json(200, conversation([message(1, "user", "newer")])));
    });
    await act(() => refetch);
    // The old response "arrives" last: it was aborted and can't be applied.
    act(() => {
      stale?.resolve(json(200, conversation([message(1, "user", "older")])));
    });
    await wait(20);
    const data = client.getQueryData<ReturnType<typeof conversation>>(
      queryKeys.conversation(USER, CONV),
    );
    expect(data?.messages[0]?.content).toBe("newer");
    expect(stale?.aborted).toBe(true);
  });
});
