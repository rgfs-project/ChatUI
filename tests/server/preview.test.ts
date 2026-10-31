import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isPreviewable, PREVIEW_MAX_BYTES, PreviewTokens } from "../../server/artifacts/preview.ts";
import type { ChatUiApp } from "../../server/create-app.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, signIn, testApp, type TestSession } from "./helpers.ts";

/** Phase 19, INV-51: preview links and the preview document's headers. */

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
afterEach(async () => {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function serve() {
  const { chatui } = testApp({ config: { provider: providerConfig({ baseUrl: llama.url }) } });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, chatui };
}

async function json(base: string, who: TestSession, method: string, url: string, body?: unknown) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: {
      ...who.headers(method !== "GET"),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Record<string, string> };
}

/** A reply that captures `filename` with `source`; returns the captured file's id. */
async function captured(
  base: string,
  chatui: ChatUiApp,
  who: TestSession,
  filename: string,
  source: string,
) {
  const sent = await json(base, who, "POST", "/api/generations", {
    providerId: "local",
    model: MOCK_MODELS.chat,
    content: `x\n\`\`\`html file=${filename}\n${source}\n\`\`\``,
    operationKey: crypto.randomUUID(),
    operationIssuedAt: new Date().toISOString(),
  });
  await chatui.services.generations.settled(sent.json.generationId ?? "");
  const files = await chatui.services.artifacts.list(who.userId);
  const file = files.find((f) => f.filename === filename);
  if (!file) throw new Error("not captured");
  return file.id;
}

describe("preview tokens", () => {
  it("are single-use, expire, and refuse any change", () => {
    let now = 1_000_000;
    const tokens = new PreviewTokens(() => now);
    const a = tokens.mint("user-a", "file-1");
    expect(tokens.redeem(a.token)).toEqual({ userId: "user-a", artifactId: "file-1" });
    expect(tokens.redeem(a.token)).toBeNull();
    const b = tokens.mint("user-a", "file-1");
    now += 61_000;
    expect(tokens.redeem(b.token)).toBeNull();
    const c = tokens.mint("user-a", "file-1");
    const [body = "", sig = ""] = c.token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), u: "user-b" }),
    ).toString("base64url");
    expect(tokens.redeem(`${forged}.${sig}`)).toBeNull();
    expect(tokens.redeem(`${body}.${sig}x`)).toBeNull();
    expect(tokens.redeem("garbage")).toBeNull();
    // Another process (another key) never accepts it.
    expect(new PreviewTokens(() => now).redeem(c.token)).toBeNull();
    expect(tokens.redeem(c.token)).not.toBeNull();
  });
});

describe("preview routes", () => {
  it("mint only for the owner, only with previews on, only for small HTML/SVG files", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    const bob = await signIn(base, chatui, "bob");
    const id = await captured(base, chatui, alice, "plot.html", "<p>plot</p>");
    // Off by default.
    const off = await json(base, alice, "POST", `/api/artifacts/${id}/preview`);
    expect(off.status).toBe(403);
    await json(base, alice, "PATCH", "/api/preferences", { previews: true });
    const minted = await json(base, alice, "POST", `/api/artifacts/${id}/preview`);
    expect(minted.status).toBe(200);
    expect(minted.json.url).toMatch(/^\/api\/preview\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Another account can't mint for it, even with previews on.
    await json(base, bob, "PATCH", "/api/preferences", { previews: true });
    expect((await json(base, bob, "POST", `/api/artifacts/${id}/preview`)).status).toBe(404);
    // Not previewable: other types and large files.
    const ts = await captured(base, chatui, alice, "code.ts", "export {}");
    expect((await json(base, alice, "POST", `/api/artifacts/${ts}/preview`)).status).toBe(400);
    // Files over the preview limit are refused (a message can't carry one, so checked directly).
    expect(isPreviewable("big.html", PREVIEW_MAX_BYTES + 1)).toBe(false);
    expect(isPreviewable("ok.svg", PREVIEW_MAX_BYTES)).toBe(true);
    expect(isPreviewable("x.js", 10)).toBe(false);
  });

  it("serve the file once, sandboxed, with no network, framing only by the app", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui, "alice");
    await json(base, alice, "PATCH", "/api/preferences", { previews: true });
    const id = await captured(base, chatui, alice, "plot.html", "<script>1</script>");
    const { url = "" } = (await json(base, alice, "POST", `/api/artifacts/${id}/preview`)).json;
    // No cookie is sent: the token alone authorizes it.
    const res = await fetch(`${base}${url}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<script>1</script>");
    const h = (name: string) => res.headers.get(name) ?? "";
    expect(h("content-type")).toBe("text/html; charset=utf-8");
    const csp = h("content-security-policy");
    for (const directive of [
      "sandbox allow-scripts",
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "frame-ancestors http://localhost:3000",
    ])
      expect(csp).toContain(directive);
    expect(csp).not.toContain("allow-same-origin");
    expect(h("x-frame-options")).toBe("");
    expect(h("x-content-type-options")).toBe("nosniff");
    expect(h("cache-control")).toBe("no-store");
    expect(h("referrer-policy")).toBe("no-referrer");
    expect(h("permissions-policy")).toContain("camera=()");
    expect(h("set-cookie")).toBe("");
    // Single use; unknown and malformed tokens are plain 404s.
    expect((await fetch(`${base}${url}`)).status).toBe(404);
    expect((await fetch(`${base}/api/preview/nope`)).status).toBe(404);
  });

  it("app pages may frame only previews; nothing else may be framed", async () => {
    const { base } = await serve();
    const csp = (await fetch(`${base}/`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
