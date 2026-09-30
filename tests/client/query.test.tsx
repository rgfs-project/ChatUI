// @vitest-environment jsdom
import {
  HydrationBoundary,
  QueryClientProvider,
  type DehydratedState,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterContextProvider, RouterProvider, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "../../app/components/ConversationView";
import { Sidebar } from "../../app/components/Sidebar";
import { appContext } from "../../app/context";
import { authStore } from "../../app/lib/auth-store";
import { createQueryClient, isDehydratable, queryKeys } from "../../app/lib/query";
import { prefetchForRequest } from "../../app/lib/server-query";
import { ShellProvider } from "../../app/lib/shell-context";
import { useAccountBoundary } from "../../app/lib/use-account-boundary";
import { loader as layoutLoader } from "../../app/routes/app-layout";
import { loader as conversationLoader } from "../../app/routes/chat-conversation";
import {
  conversation,
  CONV,
  FakeEventSource,
  json,
  message,
  MODELS,
  noop,
  SESSION,
  signInStore,
  TEST_USER,
  USER,
} from "./support";

const OTHER = "99999999-9999-4999-8999-999999999999";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const summary = (id: string, title: string) => ({
  id,
  title,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  messageCount: 2,
  malformed: false,
});

/** A fake per-request router context, as server/create-app.ts builds it. */
function requestContext(userId: string | null, titles: Record<string, string[]>) {
  const context = new RouterContextProvider();
  const services = {
    conversationDto: (owner: string, id: string) =>
      Promise.resolve({
        ...conversation([message(1, "user", titles[owner]?.[0] ?? "")]),
        id,
      }),
    conversations: {
      list: (id: string) =>
        (titles[id] ?? []).map((title, n) =>
          summary(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title),
        ),
    },
    // Resolves on a later tick so concurrent requests interleave.
    modelList: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          resolve({ providers: MODELS.providers, defaultModel: null });
        }, 5),
      ),
  };
  context.set(appContext, {
    services,
    auth: userId ? { userId, username: `u-${userId.slice(0, 4)}`, role: "user" } : null,
  } as never);
  return context;
}

async function load(userId: string | null, titles: Record<string, string[]>, url = "/chat/new") {
  return layoutLoader({
    context: requestContext(userId, titles),
    request: new Request(`http://localhost${url}`),
    params: {},
  } as never);
}

/** The active-conversation loader's dehydrated state for one request. */
async function loadConversation(userId: string, titles: Record<string, string[]>) {
  const result = (await conversationLoader({
    context: requestContext(userId, titles),
    request: new Request(`http://localhost/chat/${CONV}`),
    params: { conversationId: CONV },
  } as never)) as unknown as { data: { dehydratedState: DehydratedState } };
  return result.data.dehydratedState;
}

describe("INV-55: per-request server QueryClient", () => {
  it("two concurrent users each get only their own dehydrated data", async () => {
    const titles = { [USER]: ["alice secret plan"], [OTHER]: ["bob private notes"] };
    const [aLayout, bLayout, a, b] = await Promise.all([
      load(USER, titles),
      load(OTHER, titles),
      loadConversation(USER, titles),
      loadConversation(OTHER, titles),
    ]);
    const aJson = JSON.stringify([aLayout.dehydratedState, a]);
    const bJson = JSON.stringify([bLayout.dehydratedState, b]);
    expect(aJson).toContain("alice secret plan");
    expect(aJson).not.toContain("bob private notes");
    expect(aJson).not.toContain(OTHER);
    expect(bJson).toContain("bob private notes");
    expect(bJson).not.toContain("alice secret plan");
    expect(bJson).not.toContain(USER);
    for (const q of [...aLayout.dehydratedState.queries, ...a.queries])
      expect(q.queryKey[1]).toBe(USER);
    for (const q of [...bLayout.dehydratedState.queries, ...b.queries])
      expect(q.queryKey[1]).toBe(OTHER);
  });

  it("the layout seeds only critical model state, never the full conversation list", async () => {
    const titles = { [USER]: ["a"] };
    const context = requestContext(USER, titles);
    const list = vi.fn();
    (
      context.get(appContext).services as unknown as { conversations: { list: unknown } }
    ).conversations.list = list;
    const { dehydratedState } = await layoutLoader({
      context,
      request: new Request("http://localhost/chat/new"),
      params: {},
    } as never);
    expect(dehydratedState.queries.map((q) => q.queryKey)).toEqual([queryKeys.models(USER)]);
    expect(list).not.toHaveBeenCalled();
  });

  it("signed-out requests redirect with a validated return-to before reading anything", async () => {
    const list = vi.fn();
    const context = requestContext(null, {});
    (
      context.get(appContext).services as unknown as { conversations: { list: unknown } }
    ).conversations.list = list;
    const thrown: unknown = await layoutLoader({
      context,
      request: new Request(`http://localhost/chat/${CONV}`),
      params: {},
    } as never).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe(`/login?returnTo=%2Fchat%2F${CONV}`);
    expect(list).not.toHaveBeenCalled();
  });

  it("dehydrates only allowlisted, successful, user-scoped queries", async () => {
    const state = await prefetchForRequest(async (client) => {
      client.setQueryData(queryKeys.session(), { csrfToken: "SECRET-CSRF", user: null });
      client.setQueryData(queryKeys.generation(USER, "g"), { internal: "SECRET-GEN" });
      client.setQueryData(queryKeys.conversations(USER), [summary(CONV, "ok")]);
      client.setQueryData(["internal", "passwordHash"], "SECRET-HASH");
      await client
        .query({
          queryKey: queryKeys.models(USER),
          queryFn: () => Promise.reject(new Error("SECRET-ERROR detail")),
          retry: false,
        })
        .catch(() => undefined);
    });
    const serialized = JSON.stringify(state);
    expect(state.queries.map((q) => q.queryKey)).toEqual([queryKeys.conversations(USER)]);
    for (const secret of ["SECRET-CSRF", "SECRET-GEN", "SECRET-HASH", "SECRET-ERROR"])
      expect(serialized).not.toContain(secret);
    expect(isDehydratable(queryKeys.preferences(USER))).toBe(true);
    expect(isDehydratable(queryKeys.session())).toBe(false);
  });
});

describe("hydration reuses the seeded cache", () => {
  beforeEach(() => {
    Element.prototype.scrollTo = () => undefined;
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  function App({ client, state }: { client: QueryClient; state: unknown }) {
    const Page = () => {
      const { conversationId } = useParams();
      return (
        <>
          <Sidebar user={TEST_USER} hidden={false} drawer={false} onHide={noop} onNavigate={noop} />
          <ConversationView userId={USER} conversationId={conversationId} />
        </>
      );
    };
    const router = createMemoryRouter([{ path: "/chat/:conversationId", element: <Page /> }], {
      initialEntries: [`/chat/${CONV}`],
    });
    return (
      <QueryClientProvider client={client}>
        <HydrationBoundary state={state as never}>
          <ShellProvider>
            <RouterProvider router={router} />
          </ShellProvider>
        </HydrationBoundary>
      </QueryClientProvider>
    );
  }

  it("no duplicate initial fetch of conversations, the conversation or models", async () => {
    const state = await prefetchForRequest((client) => {
      client.setQueryData(queryKeys.conversations(USER), [summary(CONV, "Seeded chat")]);
      client.setQueryData(queryKeys.models(USER), MODELS);
      client.setQueryData(
        queryKeys.conversation(USER, CONV),
        conversation([message(1, "user", "hello from SSR")]),
      );
      return Promise.resolve();
    });
    const fetchMock = vi.fn(() => Promise.resolve(json(500, {})));
    vi.stubGlobal("fetch", fetchMock);
    const client = createQueryClient();
    render(<App client={client} state={state} />);
    expect(screen.getByText("hello from SSR")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Seeded chat" })).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("account boundary", () => {
  function Boundary({ client }: { client: QueryClient }) {
    useAccountBoundary(client);
    return null;
  }

  /** The hook reads auth through the router (root loader data): mount it in one. */
  function mount(client: QueryClient) {
    const router = createMemoryRouter([{ path: "/", element: <Boundary client={client} /> }]);
    return render(<RouterProvider router={router} />);
  }

  const B = { ...SESSION, user: { id: OTHER, username: "bob", role: "user" as const } };

  function seeded() {
    const client = createQueryClient();
    client.setQueryData(queryKeys.conversations(USER), [summary(CONV, "a")]);
    client.setQueryData(queryKeys.models(USER), MODELS);
    return client;
  }

  beforeEach(() => {
    signInStore();
  });

  it("keeps the seeded cache on first render", () => {
    const client = seeded();
    mount(client);
    expect(client.getQueryData(queryKeys.conversations(USER))).toBeDefined();
  });

  it("an account switch drops the previous user's queries and keeps the new user's", () => {
    const client = seeded();
    mount(client);
    client.setQueryData(queryKeys.conversations(OTHER), [summary(CONV, "b")]);
    act(() => {
      authStore.applySession(B);
    });
    expect(client.getQueryData(queryKeys.conversations(USER))).toBeUndefined();
    expect(client.getQueryData(queryKeys.models(USER))).toBeUndefined();
    expect(client.getQueryData(queryKeys.conversations(OTHER))).toBeDefined();
  });

  it("sign-out drops everything", () => {
    const client = seeded();
    mount(client);
    act(() => {
      authStore.signedOut();
    });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("a session expiring mid-use aborts in-flight requests and drops private data", async () => {
    const client = seeded();
    let aborted = false;
    void client
      .query({
        queryKey: queryKeys.conversation(USER, CONV),
        queryFn: ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      })
      .catch(() => undefined);
    mount(client);
    act(() => {
      authStore.expire();
    });
    await vi.waitFor(() => {
      expect(aborted).toBe(true);
    });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
});
