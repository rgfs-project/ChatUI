import { QueryClient } from "@tanstack/react-query";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { appContext } from "../../app/context";
import { dehydrateAllowed, makeQueryClient } from "../../app/lib/query/client";
import { qk, resourceOf } from "../../app/lib/query/keys";
import { applySession } from "../../app/lib/session";
import { loader as layoutLoader } from "../../app/routes/app-layout";
import { loader as rootLoader } from "../../app/root";

const A = {
  userId: "aaaaaaaa-0000-4000-8000-000000000001",
  username: "alice",
  role: "user" as const,
  tokenHash: "HASH-A",
  csrfToken: "csrf-a",
};
const B = {
  userId: "bbbbbbbb-0000-4000-8000-000000000001",
  username: "bob",
  role: "user" as const,
  tokenHash: "HASH-B",
  csrfToken: "csrf-b",
};
const CONV_A = "cccccccc-0000-4000-8000-00000000000a";

function services(delayMs = 0) {
  const wait = () => new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    auth: {
      sessionDto: (auth: typeof A | null) => ({
        user: auth ? { id: auth.userId, username: auth.username, role: auth.role } : null,
        csrfToken: auth?.csrfToken ?? null,
        registrationOpen: false,
      }),
    },
    bootstrap: {
      conversations: (userId: string) => [
        {
          id: CONV_A,
          title: `chats of ${userId}`,
          createdAt: "",
          updatedAt: "",
          messageCount: 1,
          malformed: false,
        },
      ],
      conversation: async (userId: string, id: string) => {
        await wait();
        return userId === A.userId && id === CONV_A
          ? {
              ok: true as const,
              conversation: { id, title: "alice secret", internalPath: undefined },
            }
          : { ok: false as const, code: "NOT_FOUND" as const };
      },
      preferences: async () => {
        await wait();
        return {
          pins: [],
          defaultProvider: null,
          defaultModel: null,
          historyImages: null,
          imageMaxEdge: null,
        };
      },
      models: async () => {
        await wait();
        return [];
      },
      instance: () => ({ notice: null, defaultModel: null }),
      profile: () =>
        Promise.resolve({
          username: "alice",
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          photoVersion: null,
          shape: "circle",
        }),
    },
    models: {
      listModels: async () => {
        await wait();
        return [];
      },
    },
  };
}

function args(
  auth: typeof A | null,
  url: string,
  params: Record<string, string> = {},
  delayMs = 0,
) {
  const context = new RouterContextProvider();
  context.set(appContext, {
    nonce: "n",
    services: services(delayMs) as never,
    auth,
  });
  return { context, request: new Request(url), params } as never;
}

async function layout(
  auth: typeof A,
  url: string,
  params: Record<string, string> = {},
  delayMs = 0,
) {
  const result = (await layoutLoader(args(auth, url, params, delayMs))) as unknown as {
    data: { dehydrated: { queries: { queryKey: unknown[] }[] } };
    init: { status: number } | null;
  };
  return result;
}

describe("INV-55: a fresh QueryClient per document request", () => {
  it("concurrent documents for two users never share or mix data", async () => {
    const [a, b] = await Promise.all([
      layout(A, `http://x/chat/${CONV_A}`, { conversationId: CONV_A }, 20),
      layout(B, `http://x/chat/${CONV_A}`, { conversationId: CONV_A }, 5),
    ]);
    const textA = JSON.stringify(a.data.dehydrated);
    const textB = JSON.stringify(b.data.dehydrated);
    expect(textA).toContain("alice secret");
    expect(textB).not.toContain("alice secret");
    expect(textB).not.toContain(A.userId);
    expect(textA).not.toContain(B.userId);
    // Every dehydrated user key carries its own user's id.
    for (const q of b.data.dehydrated.queries) expect(q.queryKey[1]).toBe(B.userId);
    expect(a.init?.status ?? 200).toBe(200);
    expect(b.init?.status).toBe(404);
  });

  it("each server render and loader gets its own client", () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });

  it("the root document bootstraps only the browser-safe session DTO", () => {
    const root = rootLoader(args(A, "http://x/chat/new"));
    const text = JSON.stringify(root.dehydrated);
    expect(text).toContain("csrf-a");
    expect(text).not.toContain("HASH-A");
    expect(root.dehydrated.queries.map((q) => q.queryKey)).toEqual([["session"]]);
  });
});

describe("dehydration allowlist", () => {
  it("only successful allowlisted queries leave the server", async () => {
    const client = new QueryClient();
    client.setQueryData(qk.session(), { user: null });
    client.setQueryData(qk.conversations("u1"), []);
    client.setQueryData(qk.generation("u1", "g1"), { content: "live" });
    client.setQueryData(["internal", "secret"], { apiKey: "sk-1" });
    await client
      .query({
        queryKey: qk.models("u1"),
        queryFn: () => Promise.reject(new Error("down")),
        retry: false,
      })
      .catch(() => undefined);
    const keys = dehydrateAllowed(client).queries.map((q) => q.queryKey);
    expect(keys).toEqual([qk.session(), qk.conversations("u1")]);
    expect(resourceOf(["internal", "secret"])).toBeUndefined();
  });
});

describe("account boundary", () => {
  it("a different account purges every user-scoped query; the same account keeps them", () => {
    const client = new QueryClient();
    const sessionA = {
      user: { id: A.userId, username: "alice", role: "user" as const },
      csrfToken: "a",
      registrationOpen: false,
    };
    const sessionB = {
      user: { id: B.userId, username: "bob", role: "user" as const },
      csrfToken: "b",
      registrationOpen: false,
    };
    (globalThis as { window?: unknown }).window = new EventTarget();
    applySession(client, sessionA);
    client.setQueryData(qk.conversations(A.userId), [{ id: "x" }]);
    applySession(client, { ...sessionA, csrfToken: "a2" });
    expect(client.getQueryData(qk.conversations(A.userId))).toBeDefined();
    applySession(client, sessionB);
    expect(client.getQueryData(qk.conversations(A.userId))).toBeUndefined();
    expect(client.getQueryData(qk.session())).toEqual(sessionB);
    delete (globalThis as { window?: unknown }).window;
  });
});

describe("Phase 8: startup dependency graph (INV-29, INV-30)", () => {
  it("critical loads start concurrently and a slow sidebar list never holds the document", async () => {
    const events: string[] = [];
    const timed = <T>(name: string, ms: number, value: T) => {
      events.push(`start:${name}`);
      return new Promise<T>((resolve) =>
        setTimeout(() => {
          events.push(`end:${name}`);
          resolve(value);
        }, ms),
      );
    };
    const svc = services();
    const slow = {
      ...svc,
      bootstrap: {
        conversations: () => timed("list", 5_000, []),
        conversation: (userId: string, id: string) =>
          timed("conversation", 80, null).then(() => svc.bootstrap.conversation(userId, id)),
        preferences: () => timed("preferences", 80, null).then(() => svc.bootstrap.preferences()),
        models: () => timed("models", 80, []),
        instance: svc.bootstrap.instance,
        profile: svc.bootstrap.profile,
      },
      models: { listModels: () => timed("models", 80, []) },
    };
    const context = new RouterContextProvider();
    context.set(appContext, { nonce: "n", services: slow as never, auth: A });
    const started = Date.now();
    const result = (await layoutLoader({
      context,
      request: new Request(`http://x/chat/${CONV_A}`),
      params: { conversationId: CONV_A },
    } as never)) as unknown as { data: { dehydrated: { queries: { queryKey: unknown[] }[] } } };
    const elapsed = Date.now() - started;
    // Every load started before the first one finished: no serial waterfall.
    const firstEnd = events.findIndex((e) => e.startsWith("end:"));
    expect(events.slice(0, firstEnd).sort()).toEqual(
      ["start:conversation", "start:list", "start:models", "start:preferences"].sort(),
    );
    // The secondary list's 5 s did not hold the document (budget 300 ms).
    expect(elapsed).toBeLessThan(1_500);
    const keys = result.data.dehydrated.queries.map((q) => q.queryKey[2]);
    expect(keys).toContain("conversation");
    expect(keys).not.toContain("conversations");
  });
});
