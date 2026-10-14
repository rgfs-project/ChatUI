import { describe, expect, it } from "vitest";
import { startApi } from "./api-harness.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("account profile", () => {
  it("reads and updates the profile, and the session carries it", async () => {
    const api = await startApi();
    const initial = await api("GET", "/api/account");
    expect(initial.body).toMatchObject({ displayName: null, email: null, avatarColor: "black" });

    const updated = await api("PATCH", "/api/account", {
      displayName: "  Ada  ",
      email: "ada@example.com",
      avatarColor: "green",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      displayName: "Ada",
      email: "ada@example.com",
      avatarColor: "green",
    });
    expect((await api("GET", "/api/auth/session")).body.user).toMatchObject({
      displayName: "Ada",
      avatarColor: "green",
      photoVersion: null,
    });
    expect((await api("PATCH", "/api/account", { email: "" })).body.email).toBeNull();
    expect((await api("PATCH", "/api/account", { email: "nope" })).status).toBe(400);
  });

  it("changes the username, refusing one that is taken", async () => {
    const api = await startApi();
    await api.chatui.services.users.create({ username: "taken", passwordHash: "x", role: "user" });
    expect((await api("PATCH", "/api/account", { username: "Taken" })).status).toBe(409);
    const renamed = await api("PATCH", "/api/account", { username: "Renamed" });
    expect(renamed.body.username).toBe("renamed");
    expect((await api.chatui.services.users.findByUsername("renamed"))?.id).toBe(
      api.session.userId,
    );
  });

  it("stores, serves and removes a photo", async () => {
    const api = await startApi();
    const put = await fetch(`${api.base}/api/account/photo`, {
      method: "PUT",
      headers: { ...api.session.headers(true), "Content-Type": "image/png" },
      body: PNG,
    });
    expect(put.status).toBe(200);
    const { photoVersion } = (await put.json()) as { photoVersion: string };
    expect(photoVersion).toMatch(/^[0-9a-f]{16}$/);

    const got = await fetch(
      `${api.base}/api/account/photo?u=${api.session.userId}&v=${photoVersion}`,
      { headers: api.session.headers(false) },
    );
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);

    const fake = await fetch(`${api.base}/api/account/photo`, {
      method: "PUT",
      headers: { ...api.session.headers(true), "Content-Type": "image/png" },
      body: "<svg/>",
    });
    expect(fake.status).toBe(415);

    expect((await api("DELETE", "/api/account/photo")).body.photoVersion).toBeNull();
    const gone = await fetch(`${api.base}/api/account/photo?u=${api.session.userId}`, {
      headers: api.session.headers(false),
    });
    expect(gone.status).toBe(404);
  });
});

describe("usage", () => {
  it("counts chats, archive and projects", async () => {
    const api = await startApi();
    const a = (await api("POST", "/api/conversations", {})).body;
    await api("POST", "/api/conversations", {});
    await api("PUT", `/api/conversations/${a.id}/archive`);
    await api("POST", "/api/projects", { name: "P" });
    const usage = await api("GET", "/api/usage");
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      chats: 1,
      archivedChats: 1,
      projects: 1,
      messages: { sent: 0, replies: 0 },
    });
    expect(usage.body.days).toHaveLength(30);
  });
});
