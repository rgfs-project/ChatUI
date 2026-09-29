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

let events: string[];

beforeEach(() => {
  vi.resetModules();
  events = [];
  const target = new EventTarget();
  target.addEventListener("chatui:account-changed", () => events.push("changed"));
  vi.stubGlobal("window", target);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function load() {
  return import("../../app/lib/api.ts");
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
    expect(events).toEqual([]);
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
    expect(events.length).toBeGreaterThan(0);
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
    expect(events).toEqual(["changed"]);
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
