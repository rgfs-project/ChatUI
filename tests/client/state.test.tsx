// @vitest-environment jsdom
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelListDto } from "@shared/generations";
import { ConversationView } from "../../app/components/ConversationView";
import { SectionBoundary } from "../../app/components/SectionBoundary";
import { Sidebar } from "../../app/components/Sidebar";
import { createQueryClient, queryKeys } from "../../app/lib/query";
import { sendTiming } from "../../app/lib/send";
import { ShellProvider } from "../../app/lib/shell-context";
import {
  conversation,
  CONV,
  FakeEventSource,
  GEN,
  json,
  message,
  MODELS,
  noop,
  REPLY,
  seededClient,
  signInStore,
  TEST_USER,
  USER,
} from "./support";

const OTHER_CONV = "66666666-6666-4666-8666-666666666666";
const USER_MSG = "55555555-5555-4555-8555-555555555555";
const ACCEPTED = {
  conversationId: CONV,
  generationId: GEN,
  userMessageId: USER_MSG,
  assistantMessageId: REPLY,
};

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;
let handler: Handler;
let calls: { url: string; init?: RequestInit | undefined }[];

beforeEach(() => {
  signInStore();
  Element.prototype.scrollTo = () => undefined;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  calls = [];
  handler = () => json(200, { conversations: [] });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }),
  );
  sendTiming.baseMs = 1;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sendTiming.baseMs = 1_000;
});

const posts = () => calls.filter((c) => c.url === "/api/generations");

function Page() {
  const { conversationId } = useParams();
  return (
    <>
      <Sidebar user={TEST_USER} hidden={false} drawer={false} onHide={noop} onNavigate={noop} />
      <ConversationView
        key={conversationId ?? "new"}
        userId={USER}
        conversationId={conversationId}
      />
    </>
  );
}

function renderApp(initial: string, client = seededClient(), strict = false) {
  const router = createMemoryRouter(
    [
      { path: "/chat/new", element: <Page /> },
      { path: "/chat/:conversationId", element: <Page /> },
    ],
    { initialEntries: [initial] },
  );
  const tree = (
    <QueryClientProvider client={client}>
      <ShellProvider>
        <RouterProvider router={router} />
      </ShellProvider>
    </QueryClientProvider>
  );
  return { router, client, ...render(strict ? <StrictMode>{tree}</StrictMode> : tree) };
}

async function type(text: string) {
  const user = userEvent.setup();
  const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
  await user.click(box);
  await user.keyboard(text);
  return { user, box };
}

describe("optimistic sends (contracts §4.1 client rules)", () => {
  it("the message appears at once, then reconciles to the server ids without duplicates", async () => {
    let accept!: (r: Response) => void;
    handler = (url, init) => {
      if (url === "/api/generations" && init?.method === "POST")
        return new Promise<Response>((resolve) => {
          accept = resolve;
        });
      if (url.startsWith("/api/conversations/"))
        return json(200, conversation([message(1, "user", "hello there", { id: USER_MSG })], GEN));
      return json(200, { conversations: [] });
    };
    renderApp(`/chat/${CONV}`, seededClient(conversation([])));
    const { box } = await type("hello there{Enter}");
    // Before any answer: shown as sending, composer cleared, send locked.
    const pending = await screen.findByTestId("message-pending");
    expect(pending.textContent).toContain("hello there");
    expect(pending.textContent).toContain("Sending…");
    expect(pending.getAttribute("data-temp-id")).toMatch(/^temp-/);
    expect(box.value).toBe("");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    act(() => {
      accept(json(202, ACCEPTED));
    });
    await waitFor(() => {
      expect(screen.queryByTestId("message-pending")).toBeNull();
    });
    const stored = screen.getAllByTestId("message-user");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.textContent).toContain("hello there");
    expect(FakeEventSource.latest().url).toBe(`/api/generations/${GEN}/stream`);
  });

  it("an explicit rejection rolls the message back and returns the text with the error", async () => {
    handler = (url, init) =>
      url === "/api/generations" && init?.method === "POST"
        ? json(400, { error: { code: "MODEL_NOT_FOUND", message: "That model is gone." } })
        : json(200, { conversations: [] });
    renderApp(`/chat/${CONV}`, seededClient(conversation([])));
    const { box } = await type("will be rejected{Enter}");
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("That model is gone.");
    });
    expect(screen.queryByTestId("message-pending")).toBeNull();
    expect(box.value).toBe("will be rejected");
    expect(posts()).toHaveLength(1);
  });

  it("a dropped 202 is resent with the same key and reconciled to the original ids", async () => {
    let attempt = 0;
    handler = (url, init) => {
      if (url === "/api/generations" && init?.method === "POST") {
        attempt++;
        // The first request was accepted but its response was lost.
        if (attempt === 1) throw new TypeError("Failed to fetch");
        return json(202, ACCEPTED);
      }
      if (url.startsWith("/api/conversations/"))
        return json(200, conversation([message(1, "user", "retry me", { id: USER_MSG })]));
      return json(200, { conversations: [] });
    };
    renderApp(`/chat/${CONV}`, seededClient(conversation([])));
    await type("retry me{Enter}");
    await waitFor(() => {
      expect(screen.getAllByTestId("message-user")).toHaveLength(1);
    });
    expect(screen.queryByTestId("message-pending")).toBeNull();
    const bodies = posts().map((c) => JSON.parse(c.init?.body as string) as Record<string, string>);
    expect(bodies).toHaveLength(2);
    // Byte-identical resend: same key, same payload.
    expect(posts()[0]?.init?.body).toBe(posts()[1]?.init?.body);
    expect(bodies[0]?.operationKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("exhausted retries leave 'outcome unknown' with a refresh that looks up the key", async () => {
    let lookedUp = "";
    handler = (url, init) => {
      if (url === "/api/generations" && init?.method === "POST")
        return new Response("bad gateway", { status: 502 });
      if (url.startsWith("/api/operations/")) {
        lookedUp = decodeURIComponent(url.slice("/api/operations/".length));
        return json(404, { error: { code: "NOT_FOUND", message: "none" } });
      }
      return json(200, { conversations: [] });
    };
    renderApp(`/chat/${CONV}`, seededClient(conversation([])));
    const { user, box } = await type("lost in transit{Enter}");
    const pending = await screen.findByText("Outcome unknown");
    const item = pending.closest("li");
    if (!item) throw new Error("no pending item");
    expect(posts()).toHaveLength(sendTiming.retries + 1);
    const keys = new Set(
      posts().map(
        (p) => (JSON.parse(p.init?.body as string) as { operationKey: string }).operationKey,
      ),
    );
    expect(keys.size).toBe(1); // never a new key for an unresolved send
    await user.click(within(item).getByRole("button", { name: "Refresh conversation" }));
    await within(item).findByText(/probably not saved/);
    expect(lookedUp).toBe([...keys][0]);
    await user.click(within(item).getByRole("button", { name: "Edit and resend" }));
    expect(box.value).toBe("lost in transit");
    expect(screen.queryByTestId("message-pending")).toBeNull();
  });

  it("OPERATION_EXPIRED is an unknown outcome at once, never a fresh send", async () => {
    handler = (url, init) =>
      url === "/api/generations" && init?.method === "POST"
        ? json(409, { error: { code: "OPERATION_EXPIRED", message: "too old" } })
        : json(200, { conversations: [] });
    renderApp(`/chat/${CONV}`, seededClient(conversation([])));
    await type("stale key{Enter}");
    await screen.findByText("Outcome unknown");
    expect(posts()).toHaveLength(1);
  });

  it("Strict Mode double-mount causes no duplicate mutation", async () => {
    handler = (url, init) =>
      url === "/api/generations" && init?.method === "POST"
        ? json(202, ACCEPTED)
        : url.startsWith("/api/conversations/")
          ? json(200, conversation([message(1, "user", "once", { id: USER_MSG })]))
          : json(200, { conversations: [] });
    renderApp(`/chat/${CONV}`, seededClient(conversation([])), true);
    await type("once{Enter}");
    await waitFor(() => {
      expect(screen.getAllByTestId("message-user")).toHaveLength(1);
    });
    expect(posts()).toHaveLength(1);
  });
});

describe("INV-23: stale responses never overwrite newer state", () => {
  it("rapid switching: an older conversation response resolving last never wins, and is aborted", async () => {
    const resolvers = new Map<string, (r: Response) => void>();
    const aborted: string[] = [];
    handler = (url, init) => {
      const m = /^\/api\/conversations\/(.+)$/.exec(url);
      if (m?.[1]) {
        const id = m[1];
        init?.signal?.addEventListener("abort", () => aborted.push(id));
        return new Promise<Response>((resolve) => resolvers.set(id, resolve));
      }
      return json(200, { conversations: [] });
    };
    const { router } = renderApp(`/chat/${CONV}`, seededClient());
    await waitFor(() => {
      expect(resolvers.has(CONV)).toBe(true);
    });
    await act(async () => {
      await router.navigate(`/chat/${OTHER_CONV}`);
    });
    await waitFor(() => {
      expect(resolvers.has(OTHER_CONV)).toBe(true);
    });
    act(() => {
      resolvers.get(OTHER_CONV)?.(
        json(200, { ...conversation([message(1, "user", "newest view")]), id: OTHER_CONV }),
      );
    });
    await screen.findByText("newest view");
    // The superseded request was aborted; even if it answers now, it can't win.
    expect(aborted).toContain(CONV);
    act(() => {
      resolvers.get(CONV)?.(json(200, conversation([message(1, "user", "stale view")])));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("stale view")).toBeNull();
    expect(screen.getByText("newest view")).toBeTruthy();
  });

  it("rapid model switching: the send uses the last selection", async () => {
    const two = structuredClone<ModelListDto>(MODELS);
    const first = two.providers[0];
    if (!first?.models[0]) throw new Error("fixture");
    first.models.push({ ...first.models[0], id: "m2" });
    const client = seededClient(conversation([]));
    client.setQueryData(queryKeys.models(USER), two);
    handler = (url, init) =>
      url === "/api/generations" && init?.method === "POST"
        ? json(202, ACCEPTED)
        : json(200, { conversations: [] });
    renderApp(`/chat/${CONV}`, client);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
    for (const id of ["m2", "m1", "m2", "m1", "m2"])
      fireEvent.change(select, { target: { value: JSON.stringify(["local", id]) } });
    await type("which model{Enter}");
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(JSON.parse(posts()[0]?.init?.body as string)).toMatchObject({ model: "m2" });
  });
});

describe("composer-first shell", () => {
  it("the composer is usable while the secondary conversation list is still loading", async () => {
    handler = (url, init) => {
      if (url === "/api/conversations") return new Promise<Response>(() => undefined); // held open
      if (url === "/api/generations" && init?.method === "POST") return json(202, ACCEPTED);
      return json(200, conversation([]));
    };
    const client = seededClient();
    client.removeQueries({ queryKey: queryKeys.conversations(USER) });
    renderApp("/chat/new", client);
    expect(screen.getByTestId("conversations-loading")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    await type("before the sidebar{Enter}");
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    expect(screen.getByTestId("conversations-loading")).toBeTruthy();
  });
});

describe("empty states", () => {
  it("no conversations", async () => {
    renderApp("/chat/new");
    await screen.findByTestId("conversations-empty");
  });

  it("no models: no provider configured; send stays disabled", () => {
    const client = seededClient();
    client.setQueryData(queryKeys.models(USER), { providers: [] });
    renderApp("/chat/new", client);
    expect(screen.getByTestId("models-notice").textContent).toContain("no model provider");
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  it("all providers unavailable: explains it and Retry refreshes discovery", async () => {
    const down = structuredClone<ModelListDto>(MODELS);
    const group = down.providers[0];
    if (!group) throw new Error("fixture");
    group.provider.status = "unavailable";
    group.models = [];
    const client = seededClient();
    client.setQueryData(queryKeys.models(USER), down);
    handler = (url) =>
      url === "/api/models?refresh=1" ? json(200, MODELS) : json(200, { conversations: [] });
    renderApp("/chat/new", client);
    const notice = screen.getByTestId("models-notice");
    expect(notice.textContent).toContain("All model providers are unavailable");
    await userEvent.setup().click(within(notice).getByRole("button", { name: /Retry/ }));
    await waitFor(() => {
      expect(screen.queryByTestId("models-notice")).toBeNull();
    });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("error boundaries", () => {
  it("a section failure is contained and 'Try again' recovers it with fresh data", async () => {
    let good = false;
    handler = () => json(200, good ? { items: ["recovered"] } : { items: null });
    function Fragile() {
      const { data } = useQuery({
        queryKey: ["user", USER, "fragile"],
        queryFn: async () => ((await (await fetch("/x")).json()) as { items: string[] }).items,
      });
      // Renders a list; malformed data throws during render.
      return <p>{data === undefined ? "…" : data.map((x) => x.toUpperCase()).join()}</p>;
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <p>rest of the shell</p>
        <SectionBoundary
          label="The fragile part"
          resetKeys={[]}
          queryKey={["user", USER, "fragile"]}
        >
          <Fragile />
        </SectionBoundary>
      </QueryClientProvider>,
    );
    const fallback = await screen.findByTestId("section-error");
    expect(fallback.textContent).toContain("The fragile part couldn’t be displayed.");
    expect(screen.getByText("rest of the shell")).toBeTruthy();
    good = true;
    await userEvent.setup().click(within(fallback).getByRole("button", { name: "Try again" }));
    await screen.findByText("RECOVERED");
  });
});
