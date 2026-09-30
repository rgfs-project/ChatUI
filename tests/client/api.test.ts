import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@shared/auth";

const A: SessionDto = {
  user: { id: "a".repeat(8) + "-0000-4000-8000-000000000000", username: "alice", role: "user" },
  csrfToken: "tok-a1",
  registrationOpen: false,
};
const A2: SessionDto = { ...A, csrfToken: "tok-a2" };
const B: SessionDto = {
  user: { id: "b".repeat(8) + "-0000-4000-8000-000000000000", username: "bob", role: "user" },
  csrfToken: "tok-b",
  registrationOpen: false,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const csrfInvalid = () => json(403, { error: { code: "CSRF_INVALID", message: "x" } });

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fresh page: the adapter plus its auth store (epoch counts account changes). */
async function load() {
  const api = await import("../../app/lib/api.ts");
  const { authStore } = await import("../../app/lib/auth-store.ts");
  return { ...api, store: authStore };
}

describe("INV-59: shared fetch wrapper", () => {
  it("attaches the CSRF token and expected user to mutations only", async () => {
    const api = await load();
    api.setSession(A);
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(json(200, {})));
    vi.stubGlobal("fetch", fetchMock);
    await api.apiFetch("/api/x", { method: "POST" });
    await api.apiFetch("/api/x");
    const post = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    const get = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(post.get("X-CSRF-Token")).toBe("tok-a1");
    expect(post.get("X-Expected-User")).toBe(A.user?.id);
    expect(get.get("X-CSRF-Token")).toBeNull();
  });

  it("same user after a session rotation: refetches once and retries once with the new token", async () => {
    const api = await load();
    api.setSession(A);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        calls.push(`${url} ${new Headers(init?.headers).get("X-CSRF-Token") ?? "-"}`);
        if (url === "/api/auth/session") return Promise.resolve(json(200, A2));
        return Promise.resolve(calls.length === 1 ? csrfInvalid() : json(201, { ok: true }));
      }),
    );
    const res = await api.apiFetch("/api/conversations", { method: "POST" });
    expect(res.status).toBe(201);
    expect(calls).toEqual([
      "/api/conversations tok-a1",
      "/api/auth/session -",
      "/api/conversations tok-a2",
    ]);
    expect(api.store.get().epoch).toBe(0);
  });

  it("another account signed in meanwhile: the request is discarded, never executed as B, and state is cleared", async () => {
    const api = await load();
    api.setSession(A);
    const mutations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url === "/api/auth/session") return Promise.resolve(json(200, B));
        mutations.push(new Headers(init?.headers).get("X-Expected-User") ?? "");
        return Promise.resolve(csrfInvalid());
      }),
    );
    await expect(api.apiFetch("/api/generations", { method: "POST" })).rejects.toBeInstanceOf(
      api.AccountChangedError,
    );
    expect(mutations).toEqual([A.user?.id]); // exactly one attempt, as A
    expect(api.store.get().epoch).toBe(1); // the account boundary purges on this
    expect(api.currentSession()?.user?.id).toBe(B.user?.id);
  });

  it("a superseded request is not retried even for the same user", async () => {
    const api = await load();
    api.setSession(A);
    let mutations = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (url === "/api/auth/session") return Promise.resolve(json(200, A2));
        mutations++;
        return Promise.resolve(csrfInvalid());
      }),
    );
    await expect(
      api.apiFetch("/api/x", { method: "POST", isCurrent: () => false }),
    ).rejects.toBeInstanceOf(api.AccountChangedError);
    expect(mutations).toBe(1);
  });

  it("SESSION_CHANGED is surfaced as an account change", async () => {
    const api = await load();
    api.setSession(A);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === "/api/auth/session"
            ? json(200, B)
            : json(409, { error: { code: "SESSION_CHANGED" } }),
        ),
      ),
    );
    await expect(api.apiFetch("/api/x", { method: "DELETE" })).rejects.toBeInstanceOf(
      api.AccountChangedError,
    );
    expect(api.store.get().epoch).toBe(1);
  });
});

describe("contracts §12: session expiry mid-use", () => {
  const unauthenticated = () =>
    json(401, { error: { code: "UNAUTHENTICATED", message: "Sign in" } });

  it("any 401 (read or mutation) moves auth to unauthenticated exactly once", async () => {
    const api = await load();
    api.setSession(A);
    const seen: string[] = [];
    api.store.subscribe(() => seen.push(api.store.get().status));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(unauthenticated())),
    );
    await expect(api.apiFetch("/api/conversations")).rejects.toBeInstanceOf(
      api.SessionExpiredError,
    );
    await expect(api.apiFetch("/api/x", { method: "POST" })).rejects.toBeInstanceOf(
      api.SessionExpiredError,
    );
    expect(seen).toEqual(["unauthenticated"]);
    expect(api.store.get().expired).toEqual({ userId: A.user?.id, username: "alice" });
    expect(api.store.get().session?.csrfToken).toBeNull();
  });

  it("a signed-out session answer while signed in counts as expiry", async () => {
    const api = await load();
    api.setSession(A);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json(200, { ...A, user: null, csrfToken: null }))),
    );
    await api.refreshSession();
    expect(api.store.get().status).toBe("unauthenticated");
    expect(api.store.get().expired?.userId).toBe(A.user?.id);
  });

  it("the same user re-authenticating keeps the epoch; another user bumps it", async () => {
    const api = await load();
    api.setSession(A);
    api.store.expire();
    api.setSession(A2);
    expect(api.store.get()).toMatchObject({ status: "authenticated", epoch: 0, expired: null });
    api.store.expire();
    api.setSession(B);
    expect(api.store.get()).toMatchObject({ status: "authenticated", epoch: 1, expired: null });
  });

  it("an anonymous revalidation while re-authentication is pending keeps the dialog state", async () => {
    const api = await load();
    api.setSession(A);
    api.store.expire();
    api.setSession({ ...A, user: null, csrfToken: null });
    expect(api.store.get().expired?.userId).toBe(A.user?.id);
  });
});

describe("return-to validation", () => {
  it.each([
    [
      "/chat?c=0b7e7c2a-1111-4a1a-8a1a-111111111111",
      "/chat?c=0b7e7c2a-1111-4a1a-8a1a-111111111111",
    ],
    ["/account", "/account"],
    ["//evil.example/chat", "/chat"],
    ["https://evil.example", "/chat"],
    ["/\\evil.example", "/chat"],
    ["/admin", "/chat"],
    [null, "/chat"],
  ])("%s → %s", async (input, expected) => {
    const api = await load();
    expect(api.safeReturnTo(input)).toBe(expected);
  });
});
