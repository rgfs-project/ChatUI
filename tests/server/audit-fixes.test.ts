// Regressions for the independent audit (2026-10): each test failed before its fix.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yazl from "yazl";
import { RateLimiter } from "../../server/auth/rate-limit.ts";
import { SessionStore } from "../../server/auth/sessions.ts";
import { DEFAULT_IMPORT_LIMITS } from "../../server/portability/archive.ts";
import { listEntries, openZip } from "../../server/portability/read-archive.ts";
import { DataPaths } from "../../server/storage/paths.ts";
import { tempDataDir, tempDir } from "./helpers.ts";

describe("session refresh vs revocation", () => {
  it("a refresh that read the session before a revoke does not bring it back", async () => {
    let now = new Date("2026-10-08T00:00:00Z");
    const store = new SessionStore({
      paths: new DataPaths(tempDataDir()),
      absoluteTtlMs: 30 * 86_400_000,
      idleTtlMs: 7 * 86_400_000,
      now: () => now,
    });
    const { tokenHash } = await store.issue("user-1", "user");
    now = new Date(now.getTime() + 61_000);
    const seen = await store.read(tokenHash);
    if (!seen) throw new Error("session missing");
    // Logout lands between the request's read and its idle refresh.
    await store.revokeUser("user-1");
    await store.touch(tokenHash, seen);
    expect(await store.read(tokenHash)).toBeNull();
  });

  it("a refresh and a revoke racing leave the session revoked", async () => {
    let now = new Date("2026-10-08T00:00:00Z");
    const store = new SessionStore({
      paths: new DataPaths(tempDataDir()),
      absoluteTtlMs: 30 * 86_400_000,
      idleTtlMs: 7 * 86_400_000,
      now: () => now,
    });
    const { tokenHash } = await store.issue("user-1", "user");
    now = new Date(now.getTime() + 61_000);
    const seen = await store.read(tokenHash);
    if (!seen) throw new Error("session missing");
    await Promise.all([store.revoke(tokenHash), store.touch(tokenHash, seen)]);
    expect(await store.read(tokenHash)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("never holds more than its cap of keys, and drops expired ones first", () => {
    let t = 0;
    const limiter = new RateLimiter({ limit: 10, windowMs: 1000, now: () => t, maxKeys: 50 });
    for (let i = 0; i < 500; i++) limiter.hit(`k${String(i)}`);
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.size).toBeLessThanOrEqual(
      50,
    );
    t = 2000;
    limiter.hit("fresh");
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.size).toBe(1);
  });

  it("blocked() reports without recording", () => {
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    expect(limiter.blocked("a")).toBe(0);
    for (let i = 0; i < 3; i++) limiter.hit("a");
    expect(limiter.blocked("a")).toBe(60);
    expect(limiter.blocked("b")).toBe(0);
    expect((limiter as unknown as { hits: Map<string, unknown> }).hits.has("b")).toBe(false);
  });
});

describe("archive entry limit", () => {
  it("counts directory records too", async () => {
    const zipFile = new yazl.ZipFile();
    for (let i = 0; i < 25; i++) zipFile.addEmptyDirectory(`d${String(i)}`);
    zipFile.addBuffer(Buffer.from("{}"), "manifest.json");
    zipFile.end();
    const chunks: Buffer[] = [];
    for await (const chunk of zipFile.outputStream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const file = path.join(tempDir("chatui-zip-"), "a.zip");
    writeFileSync(file, bytes);
    const zip = await openZip(file);
    await expect(listEntries(zip, { ...DEFAULT_IMPORT_LIMITS, maxEntries: 2 })).rejects.toThrow(
      /more than 2 entries/,
    );
    zip.close();
  });
});
