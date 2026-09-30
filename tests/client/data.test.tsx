// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportPreview } from "@shared/portability";
import DataSettings from "../../app/components/DataSettings";
import { createQueryClient, queryKeys } from "../../app/lib/query";
import { json, signInStore, USER } from "./support";

/** Phase 13d: Settings → Data export and the import preview/confirm/report flow. */

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let uploadResponse: { status: number; body: unknown };
let uploadedBody: unknown = null;

class FakeXhr {
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  status = 0;
  response: unknown = null;
  responseType = "";
  headers: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(): void {
    // Nothing to do: the fake answers in send().
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
  abort(): void {
    this.onabort?.();
  }
  send(body: unknown): void {
    uploadedBody = body;
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = uploadResponse.status;
      this.response = uploadResponse.body;
      this.onload?.();
    }, 10);
  }
}

const IMPORT = "66666666-0000-4000-8000-000000000001";
const MEMORY = "66666666-0000-4000-8000-000000000002";

function preview(extra: Partial<ImportPreview> = {}): ImportPreview {
  return {
    importId: IMPORT,
    key: "k".repeat(64),
    state: "previewed",
    createdAt: "2026-01-02T00:00:00.000Z",
    exportCreatedAt: "2026-01-01T00:00:00.000Z",
    previousImport: null,
    counts: { conversation: { new: 2, conflict: 1 }, memory: { skipped: 1 } },
    items: [
      {
        kind: "conversation",
        id: "c1",
        label: "Trip plans",
        action: "conflict",
        reason: "differs from your copy",
        newId: null,
        rewritten: false,
      },
    ],
    memories: [{ id: MEMORY, name: "Coffee", content: "Flat white", action: "new" }],
    warnings: [],
    report: null,
    progress: { done: 0, total: 0 },
    ...extra,
  };
}

beforeEach(() => {
  signInStore();
  uploadedBody = null;
  uploadResponse = { status: 201, body: preview() };
  fetchMock = vi.fn(() => Promise.resolve(json(404, {})));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderData() {
  const client = createQueryClient();
  client.setQueryData(queryKeys.conversations(USER), []);
  render(
    <QueryClientProvider client={client}>
      <DataSettings userId={USER} />
    </QueryClientProvider>,
  );
  return client;
}

describe("Settings → Data", () => {
  it("exports everything and offers the download", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/exports"
          ? json(201, {
              exportId: IMPORT,
              createdAt: "x",
              size: 2048,
              counts: {},
              activeGenerations: 0,
            })
          : json(404, {}),
      ),
    );
    renderData();
    await user.click(screen.getByRole("button", { name: /Export all data/ }));
    const link = await screen.findByTestId("export-download");
    expect(link.getAttribute("href")).toBe(`/api/exports/${IMPORT}/download`);
    expect(link.textContent).toContain("2.0 KB");
  });

  it("previews, needs explicit choices, commits them and reports; conflicts default to skip", async () => {
    const user = userEvent.setup();
    let polls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/commit"))
        return Promise.resolve(
          json(202, preview({ state: "committing", progress: { done: 1, total: 3 } })),
        );
      if (url === `/api/imports/${IMPORT}` && (init?.method ?? "GET") === "GET") {
        polls++;
        return Promise.resolve(
          json(
            200,
            preview({
              state: "committed",
              progress: { done: 3, total: 3 },
              report: {
                committedAt: "2026-01-02T00:00:01.000Z",
                error: null,
                items: [
                  {
                    kind: "conversation",
                    id: "c1",
                    label: "Trip plans",
                    action: "copy",
                    reason: null,
                    newId: "c9",
                    rewritten: false,
                  },
                  {
                    kind: "memory",
                    id: MEMORY,
                    label: "Coffee",
                    action: "new",
                    reason: null,
                    newId: null,
                    rewritten: false,
                  },
                ],
              },
            }),
          ),
        );
      }
      return Promise.resolve(json(404, {}));
    });
    const client = renderData();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    await user.upload(
      input as HTMLInputElement,
      new File(["zip"], "export.zip", { type: "application/zip" }),
    );
    const box = await screen.findByTestId("import-preview");
    expect(uploadedBody).toBeInstanceOf(File);
    expect(within(box).getByRole("table").textContent).toContain("Chats");
    // Defaults: conflicts skipped, no memories selected.
    expect(within(box).getByRole<HTMLInputElement>("radio", { name: /Skip them/ }).checked).toBe(
      true,
    );
    const memory = within(box).getByRole<HTMLInputElement>("checkbox", { name: /Coffee/ });
    expect(memory.checked).toBe(false);
    await user.click(within(box).getByRole("radio", { name: /as copies/ }));
    await user.click(memory);
    client.setQueryData(queryKeys.memories(USER), { memories: [] });
    await user.click(within(box).getByRole("button", { name: "Import" }));
    const call = fetchMock.mock.calls.find(([url]) => url.endsWith("/commit"));
    expect(JSON.parse(call?.[1]?.body as string)).toEqual({
      conflicts: "copy",
      memoryIds: [MEMORY],
      allowRepeat: false,
    });
    const report = await screen.findByTestId("import-report", {}, { timeout: 3_000 });
    expect(report.textContent).toContain("Import complete");
    expect(report.textContent).toContain("2 items imported");
    expect(polls).toBeGreaterThan(0);
    // Affected queries are refreshed.
    await waitFor(() => {
      expect(client.getQueryState(queryKeys.memories(USER))?.isInvalidated).toBe(true);
    });
  });

  it("a repeated archive needs 'import again'; cancel discards the preview", async () => {
    const user = userEvent.setup();
    uploadResponse = {
      status: 201,
      body: preview({ previousImport: { importId: "x", committedAt: "2026-01-01T00:00:00.000Z" } }),
    };
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === "DELETE" ? json(200, { cancelled: true }) : json(404, {})),
    );
    renderData();
    await user.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement,
      new File(["zip"], "export.zip"),
    );
    const box = await screen.findByTestId("import-preview");
    const importButton = within(box).getByRole<HTMLButtonElement>("button", { name: "Import" });
    expect(importButton.disabled).toBe(true);
    await user.click(within(box).getByRole("checkbox", { name: /Import it again/ }));
    expect(importButton.disabled).toBe(false);
    await user.click(within(box).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByTestId("import-preview")).toBeNull();
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => init?.method === "DELETE" && url === `/api/imports/${IMPORT}`,
      ),
    ).toBe(true);
  });

  it("shows a refused archive's reason", async () => {
    const user = userEvent.setup();
    uploadResponse = {
      status: 400,
      body: { error: { code: "VALIDATION", message: "abc points outside the archive" } },
    };
    renderData();
    await user.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement,
      new File(["zip"], "bad.zip"),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("points outside the archive");
  });
});
