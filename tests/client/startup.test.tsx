import {
  createStaticHandler,
  RouterContextProvider,
  type StaticHandlerContext,
} from "react-router";
import { describe, expect, it, vi } from "vitest";
import { appContext } from "../../app/context";
import { loader as rootLoader } from "../../app/root";
import { loader as layoutLoader } from "../../app/routes/app-layout";
import { loader as conversationLoader } from "../../app/routes/chat-conversation";
import { conversation, CONV, message, MODELS, USER } from "./support";

/**
 * The startup dependency graph, run through React Router's own static
 * handler (the loader orchestration the SSR server uses) against controllable
 * services: independent critical work must overlap, and secondary work (the
 * full conversation list) must never be awaited.
 */

interface Gate<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  startedAt: number | null;
  endedAt: number | null;
}

function gate<T>(): Gate<T> {
  let resolve!: (value: T) => void;
  const g: Gate<T> = {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (value) => {
      g.endedAt = performance.now();
      resolve(value);
    },
    startedAt: null,
    endedAt: null,
  };
  return g;
}

function routes() {
  return [
    {
      id: "root",
      path: "/",
      loader: rootLoader as never,
      children: [
        {
          id: "routes/app-layout",
          loader: layoutLoader as never,
          children: [
            {
              id: "routes/chat-conversation",
              path: "chat/:conversationId",
              loader: conversationLoader as never,
            },
          ],
        },
      ],
    },
  ];
}

function context(services: object, signedIn = true) {
  const ctx = new RouterContextProvider();
  ctx.set(appContext, {
    services: {
      auth: {
        sessionDto: () => ({
          user: signedIn ? { id: USER, username: "alice", role: "user" } : null,
          csrfToken: signedIn ? "t" : null,
          registrationOpen: false,
        }),
      },
      ...services,
    },
    auth: signedIn ? { userId: USER, username: "alice", role: "user" } : null,
  } as never);
  return ctx;
}

describe("INV-29 groundwork: startup dependency graph", () => {
  it("cold load of /chat/:id: models and the active conversation load concurrently", async () => {
    const models = gate<typeof MODELS.providers>();
    const convo = gate<ReturnType<typeof conversation>>();
    const list = vi.fn();
    const services = {
      modelList: () => {
        models.startedAt = performance.now();
        return models.promise.then((providers) => ({ providers, defaultModel: null }));
      },
      conversationDto: () => {
        convo.startedAt = performance.now();
        return convo.promise;
      },
      conversations: { list },
    };
    const handler = createStaticHandler(routes());
    const pending = handler.query(new Request(`http://localhost/chat/${CONV}`), {
      requestContext: context(services),
    });
    // Both critical requests start before either is answered: no waterfall.
    await vi.waitFor(() => {
      expect(models.startedAt).not.toBeNull();
      expect(convo.startedAt).not.toBeNull();
    });
    expect(models.endedAt).toBeNull();
    expect(convo.endedAt).toBeNull();
    // Answer in the "wrong" order: the conversation last.
    models.resolve(MODELS.providers);
    convo.resolve(conversation([message(1, "user", "hello")], "g-1"));
    const result = (await pending) as StaticHandlerContext;
    expect(result.statusCode).toBe(200);
    const chat = result.loaderData["routes/chat-conversation"] as {
      dehydratedState: { queries: { queryKey: unknown[] }[] };
    };
    const layout = result.loaderData["routes/app-layout"] as {
      dehydratedState: { queries: { queryKey: unknown[] }[] };
    };
    expect(chat.dehydratedState.queries.map((q) => q.queryKey)).toEqual([
      ["user", USER, "conversation", CONV],
    ]);
    expect(layout.dehydratedState.queries.map((q) => q.queryKey)).toEqual([
      ["user", USER, "models"],
    ]);
    // Secondary: the full conversation list is never part of the critical path.
    expect(list).not.toHaveBeenCalled();
  });

  it("measured: two 150 ms critical dependencies finish in about 150 ms, not 300 ms", async () => {
    const delay = <T,>(value: T) =>
      new Promise<T>((resolve) =>
        setTimeout(() => {
          resolve(value);
        }, 150),
      );
    const services = {
      modelList: () =>
        delay(MODELS.providers).then((providers) => ({ providers, defaultModel: null })),
      conversationDto: () => delay(conversation([message(1, "user", "hi")])),
      conversations: { list: () => [] },
    };
    const handler = createStaticHandler(routes());
    const start = performance.now();
    await handler.query(new Request(`http://localhost/chat/${CONV}`), {
      requestContext: context(services),
    });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(145);
    expect(elapsed).toBeLessThan(290);
  });

  it("a hanging model endpoint never holds the document past its budget; the conversation still renders", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const services = {
        // Discovery that never answers (a cold, stuck provider).
        modelList: () => new Promise(() => undefined),
        conversationDto: () => Promise.resolve(conversation([message(1, "user", "still here")])),
        conversations: { list: () => [] },
      };
      const handler = createStaticHandler(routes());
      let settled = false;
      const pending = handler
        .query(new Request(`http://localhost/chat/${CONV}`), {
          requestContext: context(services),
        })
        .then((r) => {
          settled = true;
          return r as StaticHandlerContext;
        });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      const result = await pending;
      expect(settled).toBe(true);
      const layout = result.loaderData["routes/app-layout"] as {
        dehydratedState: { queries: unknown[] };
      };
      const chat = result.loaderData["routes/chat-conversation"] as {
        dehydratedState: { queries: { queryKey: unknown[] }[] };
      };
      // Models are omitted (the browser fetches them); the transcript is not.
      expect(layout.dehydratedState.queries).toEqual([]);
      expect(chat.dehydratedState.queries.map((q) => q.queryKey)).toEqual([
        ["user", USER, "conversation", CONV],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("signed out: the guard redirects before any private read starts", async () => {
    const modelList = vi.fn();
    const conversationDto = vi.fn();
    const handler = createStaticHandler(routes());
    const result = await handler.query(new Request(`http://localhost/chat/${CONV}`), {
      requestContext: context({ modelList, conversationDto }, false),
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(`/login?returnTo=%2Fchat%2F${CONV}`);
    expect(modelList).not.toHaveBeenCalled();
    expect(conversationDto).not.toHaveBeenCalled();
  });
});
