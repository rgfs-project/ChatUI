import { readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import { computeStats } from "../../server/profile/stats.ts";
import type { ConversationModel } from "../../server/storage/markdown.ts";
import { makeGif, makePng } from "../support/media.ts";
import { startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, signIn, tempDataDir, testApp, type TestSession } from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama();
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

async function serve(dataDir = tempDataDir(), now?: () => Date) {
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
    ...(now ? { now } : {}),
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    chatui,
    dataDir,
  };
}

async function putFile(
  base: string,
  who: TestSession,
  url: string,
  method: string,
  bytes: Buffer,
  name: string,
) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch(`${base}${url}`, { method, headers: who.headers(true), body: form });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const user = (time: string, body = "hi") => ({
  type: "user" as const,
  id: crypto.randomUUID(),
  time,
  body,
});
const reply = (model: string) => ({
  type: "assistant" as const,
  id: crypto.randomUUID(),
  status: "complete" as const,
  model,
  body: "ok",
});
const chat = (blocks: ConversationModel["blocks"]): ConversationModel => ({
  title: "t",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  blocks,
});

describe("profile statistics", () => {
  it("counts streaks in the user's time zone; the current streak survives a quiet today", () => {
    const now = new Date("2026-10-30T09:00:00.000Z");
    const stats = computeStats(
      [
        chat([
          user("2026-10-27T10:00:00.000Z"),
          reply("model-a"),
          user("2026-10-28T10:00:00.000Z"),
          reply("model-a"),
          // 23:30 UTC on the 28th is the 29th in Tokyo, the 28th in UTC.
          user("2026-10-28T23:30:00.000Z"),
          reply("model-b"),
        ]),
        chat([user("2026-09-01T10:00:00.000Z"), user("2026-09-02T10:00:00.000Z")]),
      ],
      { timeZone: "UTC", now, files: 3 },
    );
    expect(stats).toMatchObject({
      today: "2026-10-30",
      chats: 2,
      messages: 5,
      replies: 3,
      files: 3,
      activeDays: 4,
      longestStreak: 2,
      // The 29th had no message in UTC: yesterday is quiet, so no current streak.
      currentStreak: 0,
      favoriteModel: "model-a",
    });
    const tokyo = computeStats(
      [
        chat([
          user("2026-10-27T10:00:00.000Z"),
          user("2026-10-28T10:00:00.000Z"),
          user("2026-10-28T23:30:00.000Z"),
        ]),
      ],
      { timeZone: "Asia/Tokyo", now, files: 0 },
    );
    expect(tokyo.longestStreak).toBe(3);
    expect(tokyo.currentStreak).toBe(3);
    expect(tokyo.days.map((d) => d.date)).toEqual(["2026-10-27", "2026-10-28", "2026-10-29"]);
    expect(tokyo.busiestHour).toBe(19);
  });

  it("the activity covers 53 weeks; older days count for totals only", () => {
    const now = new Date("2026-10-30T12:00:00.000Z");
    const stats = computeStats(
      [chat([user("2025-01-01T12:00:00.000Z"), user("2026-10-30T08:00:00.000Z")])],
      {
        timeZone: "UTC",
        now,
        files: 0,
      },
    );
    expect(stats.days).toEqual([{ date: "2026-10-30", count: 1 }]);
    expect(stats.activeDays).toBe(2);
    expect(stats.currentStreak).toBe(1);
    expect(stats.busiestWeekday).not.toBeNull();
  });

  it("the endpoint validates the time zone and reflects new messages", async () => {
    const { base, chatui } = await serve();
    const alice = await signIn(base, chatui);
    const bad = await fetch(`${base}/api/profile/stats?timeZone=Mars/Base`, {
      headers: alice.headers(),
    });
    expect(bad.status).toBe(400);
    const res = await fetch(`${base}/api/profile/stats?timeZone=Europe/London`, {
      headers: alice.headers(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      chats: 0,
      messages: 0,
      currentStreak: 0,
      timeZone: "Europe/London",
    });
  });
});

describe("profile photo and shape", () => {
  it("upload, serve, change shape and remove; only PNG, JPEG or WebP", async () => {
    const { base, chatui, dataDir } = await serve();
    const alice = await signIn(base, chatui);
    const empty = await fetch(`${base}/api/profile`, { headers: alice.headers() });
    expect(await empty.json()).toMatchObject({
      username: "alice",
      photoVersion: null,
      shape: "circle",
    });
    expect((await fetch(`${base}/api/profile/photo`, { headers: alice.headers() })).status).toBe(
      404,
    );

    const up = await putFile(
      base,
      alice,
      "/api/profile/photo",
      "PUT",
      makePng(64, 64),
      "photo.png",
    );
    expect(up.status).toBe(200);
    expect(up.json.photoVersion).toMatch(/^[0-9a-f]{16}$/);
    const photo = await fetch(`${base}/api/profile/photo?v=${String(up.json.photoVersion)}`, {
      headers: alice.headers(),
    });
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.headers.get("x-content-type-options")).toBe("nosniff");
    expect(photo.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(Buffer.from(await photo.arrayBuffer()).equals(makePng(64, 64))).toBe(true);
    expect(readdirSync(path.join(dataDir, alice.userId, "profile")).sort()).toEqual([
      "photo",
      "profile.json",
    ]);

    for (const [bytes, name] of [
      [makeGif(), "a.gif"],
      [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "a.svg"],
      [Buffer.from("text"), "a.png"],
    ] as const) {
      expect((await putFile(base, alice, "/api/profile/photo", "PUT", bytes, name)).status).toBe(
        415,
      );
    }
    const huge = await putFile(
      base,
      alice,
      "/api/profile/photo",
      "PUT",
      Buffer.alloc(6 * 1_048_576),
      "a.png",
    );
    expect(huge.status).toBe(413);
    // A rejected upload leaves the previous photo in place and no temp files.
    expect(readdirSync(path.join(dataDir, alice.userId, "profile")).sort()).toEqual([
      "photo",
      "profile.json",
    ]);

    const shaped = await fetch(`${base}/api/profile`, {
      method: "PATCH",
      headers: { ...alice.headers(true), "Content-Type": "application/json" },
      body: JSON.stringify({ shape: "cookie" }),
    });
    expect(await shaped.json()).toMatchObject({ shape: "cookie" });
    const bob = await signIn(base, chatui, "bob");
    expect((await fetch(`${base}/api/profile/photo`, { headers: bob.headers() })).status).toBe(404);
    expect(
      await (await fetch(`${base}/api/profile`, { headers: bob.headers() })).json(),
    ).toMatchObject({
      username: "bob",
      shape: "circle",
    });

    const removed = await fetch(`${base}/api/profile/photo`, {
      method: "DELETE",
      headers: alice.headers(true),
    });
    expect(await removed.json()).toMatchObject({ photoVersion: null, shape: "cookie" });
    expect((await fetch(`${base}/api/profile/photo`, { headers: alice.headers() })).status).toBe(
      404,
    );
  });
});

describe("Library uploads", () => {
  it("saved files are kept past the pending TTL, can be deleted, and can't be sent", async () => {
    const dataDir = tempDataDir();
    let clock = new Date();
    const first = await serve(dataDir, () => clock);
    const alice = await signIn(first.base, first.chatui);
    const saved = await putFile(
      first.base,
      alice,
      "/api/attachments?to=library",
      "POST",
      makePng(),
      "kept.png",
    );
    expect(saved.status).toBe(201);
    expect(saved.json.status).toBe("saved");
    const pending = await putFile(
      first.base,
      alice,
      "/api/attachments",
      "POST",
      makePng(),
      "temp.png",
    );

    clock = new Date(clock.getTime() + 2 * 86_400_000);
    const second = await serve(dataDir, () => clock);
    const list = (await (
      await fetch(`${second.base}/api/attachments`, { headers: alice.headers() })
    ).json()) as {
      attachments: { id: string }[];
    };
    expect(list.attachments.map((a) => a.id)).toEqual([saved.json.id]);
    expect(list.attachments.map((a) => a.id)).not.toContain(pending.json.id);

    const send = await fetch(`${second.base}/api/generations`, {
      method: "POST",
      headers: { ...alice.headers(true), "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "local",
        model: "mock-chat",
        content: "x",
        attachmentIds: [saved.json.id],
        operationKey: crypto.randomUUID(),
        operationIssuedAt: clock.toISOString(),
      }),
    });
    expect(send.status).toBe(409);
    const del = await fetch(`${second.base}/api/attachments/${String(saved.json.id)}`, {
      method: "DELETE",
      headers: alice.headers(true),
    });
    expect(del.status).toBe(200);
  });
});
