import { describe, expect, it } from "vitest";
import type { FileItem } from "@shared/files";
import type { LogEntryDto } from "@shared/admin";
import { startApi } from "./api-harness.ts";

async function upload(api: Awaited<ReturnType<typeof startApi>>, name: string, text: string) {
  const body = new FormData();
  body.append("file", new Blob([text], { type: "text/plain" }), name);
  const res = await fetch(`${api.base}/api/files`, {
    method: "POST",
    headers: api.session.headers(true),
    body,
  });
  return { status: res.status, body: (await res.json()) as FileItem };
}

describe("files", () => {
  it("keeps uploads, lists them with a kind, and deletes them", async () => {
    const api = await startApi();
    const up = await upload(api, "script.py", "print('hi')\n");
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ origin: "upload", kindLabel: "Python", category: "code" });

    const listed = await api("GET", "/api/files");
    const files = listed.body.files as FileItem[];
    expect(files.map((f) => f.name)).toEqual(["script.py"]);
    expect(listed.body.usedBytes).toBe(12);

    // Kept files survive the pending-attachment GC, however old.
    const later = new Date(Date.now() + 365 * 86_400_000);
    await api.chatui.services.attachments.reconcile(api.session.userId, {
      startup: false,
      now: later,
    });
    expect(((await api("GET", "/api/files")).body.files as FileItem[]).length).toBe(1);

    expect((await api("DELETE", `/api/files/${up.body.id}`)).status).toBe(200);
    expect((await api("GET", "/api/files")).body.files).toEqual([]);
    expect((await api("DELETE", `/api/files/${up.body.id}`)).status).toBe(404);
  });
});

describe("logs and reports", () => {
  it("records reports and admin changes, filters by level, exports and clears", async () => {
    const api = await startApi("admin");
    expect(
      (await api("POST", "/api/reports", { description: "The button is stuck\nmore", page: "/" }))
        .status,
    ).toBe(201);
    await api("PATCH", "/api/admin/settings", { logging: { level: "info", retentionDays: 7 } });

    const logs = await api("GET", "/api/admin/logs");
    expect(logs.body.settings).toEqual({ level: "info", retentionDays: 7 });
    const entries = logs.body.entries as LogEntryDto[];
    const report = entries.find((e) => e.source === "reports");
    expect(report?.message).toBe("Problem report: The button is stuck");
    expect(report?.details).toContain("Page: /");
    expect(report?.user?.username).toBe("root");
    expect(
      entries.some((e) => e.source === "admin" && e.message.startsWith("settings.update")),
    ).toBe(true);

    const one = await api("GET", `/api/admin/logs/${report?.id ?? ""}`);
    expect(one.body.id).toBe(report?.id);

    // Below the level: not recorded.
    const before = entries.length;
    await api.chatui.services.admin.events.record({
      level: "debug",
      source: "system",
      message: "x",
    });
    expect(((await api("GET", "/api/admin/logs")).body.entries as LogEntryDto[]).length).toBe(
      before,
    );

    const exported = await fetch(`${api.base}/api/admin/logs/export`, {
      headers: api.session.headers(false),
    });
    expect(exported.status).toBe(200);
    const { entries: all } = (await exported.json()) as { entries: LogEntryDto[] };
    expect(all.length).toBe(before);

    expect((await api("DELETE", "/api/admin/logs")).status).toBe(200);
    // Clearing is itself recorded (an admin change), after the files are gone.
    const after = (await api("GET", "/api/admin/logs")).body.entries as LogEntryDto[];
    expect(after.every((e) => e.source === "admin")).toBe(true);
  });

  it("is for administrators only", async () => {
    const api = await startApi();
    expect((await api("GET", "/api/admin/logs")).status).toBe(403);
  });
});
