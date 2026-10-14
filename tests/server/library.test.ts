import { describe, expect, it } from "vitest";
import type { ConversationSummary } from "@shared/conversations";
import { startApi as start } from "./api-harness.ts";

describe("projects and the archive", () => {
  it("creates, renames, assigns and deletes projects", async () => {
    const api = await start();
    const chat = (await api("POST", "/api/conversations", {})).body;
    const created = await api("POST", "/api/projects", { name: "Trip" });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Trip", chatCount: 0 });
    const id = created.body.id;

    expect(
      (await api("PUT", `/api/conversations/${chat.id}/project`, { projectId: id })).status,
    ).toBe(200);
    expect((await api("GET", "/api/projects")).body.projects).toMatchObject([{ id, chatCount: 1 }]);
    const listed = (await api("GET", "/api/conversations")).body.conversations;
    expect(listed[0]).toMatchObject({ projectId: id, archived: false });

    expect((await api("PATCH", `/api/projects/${id}`, { name: "Holiday" })).body).toMatchObject({
      name: "Holiday",
      chatCount: 1,
    });
    expect((await api("DELETE", `/api/projects/${id}`)).status).toBe(200);
    expect((await api("GET", "/api/projects")).body.projects).toEqual([]);
    expect((await api("GET", "/api/conversations")).body.conversations[0]?.projectId).toBeNull();
  });

  it("refuses a project that doesn't exist", async () => {
    const api = await start();
    const chat = (await api("POST", "/api/conversations", {})).body;
    const res = await api("PUT", `/api/conversations/${chat.id}/project`, {
      projectId: "00000000-0000-4000-8000-000000000001",
    });
    expect(res.status).toBe(404);
  });

  it("archives, unarchives and archives everything", async () => {
    const api = await start();
    const a = (await api("POST", "/api/conversations", {})).body;
    const b = (await api("POST", "/api/conversations", {})).body;
    expect((await api("PUT", `/api/conversations/${a.id}/archive`)).status).toBe(200);
    const archived = (list: ConversationSummary[]) =>
      list.filter((c) => c.archived).map((c) => c.id);
    expect(archived((await api("GET", "/api/conversations")).body.conversations)).toEqual([a.id]);
    expect((await api("DELETE", `/api/conversations/${a.id}/archive`)).status).toBe(200);
    expect(archived((await api("GET", "/api/conversations")).body.conversations)).toEqual([]);
    expect((await api("POST", "/api/conversations/archive-all", {})).body).toEqual({ archived: 2 });
    expect(archived((await api("GET", "/api/conversations")).body.conversations).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    // Deleting a chat drops it from the archive.
    await api("DELETE", `/api/conversations/${a.id}`);
    expect(archived((await api("GET", "/api/conversations")).body.conversations)).toEqual([b.id]);
  });
});
