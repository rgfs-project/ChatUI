// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentDto } from "@shared/attachments";
import { ConversationView } from "../../app/components/ConversationView";
import { MessageAttachments } from "../../app/components/MessageAttachments";
import {
  addFiles,
  getTray,
  removeAttachment,
  resetAttachmentsForTests,
  restoreReady,
  takeReady,
} from "../../app/lib/attachments";
import { authStore } from "../../app/lib/auth-store";
import { queryKeys } from "../../app/lib/query";
import {
  AppHarness,
  chooseModel,
  json,
  MODELS,
  seededClient,
  SESSION,
  signInStore,
  USER,
} from "./support";

/** A controllable XMLHttpRequest for upload tests. */
class FakeXhr {
  static instances: FakeXhr[] = [];
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: FormData | null = null;
  status = 0;
  response: unknown = null;
  responseType = "";
  aborted = false;
  upload: {
    onprogress:
      ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(fraction: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded: fraction * 100, total: 100 });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.response = body;
    this.onload?.();
  }
}

const dto = (n: number, extra: Partial<AttachmentDto> = {}): AttachmentDto => ({
  id: `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, "0")}`,
  filename: `file-${String(n)}.png`,
  mediaType: "image/png",
  kind: "image",
  size: 10,
  width: 4,
  height: 3,
  linked: false,
  ...extra,
});

const OPTIONS = { maxPerMessage: 3, maxFileBytes: 1_000, imageMaxEdge: 0 };
const image = (name = "a.png") =>
  new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
const flush = () => new Promise((r) => setTimeout(r, 0));

const revoke = vi.fn();
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  Element.prototype.scrollTo = () => undefined;
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url.includes("/api/attachments/") ? json(200, { deleted: true }) : json(404, {}),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  revoke.mockClear();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = revoke;
  signInStore();
  resetAttachmentsForTests();
});

afterEach(() => {
  cleanup();
  resetAttachmentsForTests();
  vi.unstubAllGlobals();
});

describe("composer attachments store (Phase 12)", () => {
  it("uploads with the CSRF and expected-user headers, reports progress, becomes ready", async () => {
    addFiles(USER, "new", [image()], OPTIONS);
    expect(getTray(USER, "new")[0]).toMatchObject({
      status: "uploading",
      previewUrl: "blob:preview",
    });
    await flush();
    const xhr = FakeXhr.instances[0];
    expect(xhr?.method).toBe("POST");
    expect(xhr?.url).toBe("/api/attachments");
    expect(xhr?.headers).toMatchObject({ "X-CSRF-Token": "csrf-alice", "X-Expected-User": USER });
    expect((xhr?.body?.get("file") as File).name).toBe("a.png");
    act(() => xhr?.progress(0.5));
    expect(getTray(USER, "new")[0]?.progress).toBe(0.5);
    act(() => xhr?.respond(201, dto(1)));
    await flush();
    expect(getTray(USER, "new")[0]).toMatchObject({ status: "ready", dto: dto(1) });
  });

  it("server rejections become chip errors; the per-message limit refuses extra files", async () => {
    const notice = addFiles(
      USER,
      "new",
      [image("1.png"), image("2.png"), image("3.png"), image("4.png")],
      OPTIONS,
    );
    expect(notice).toBe("A message can have at most 3 attachments.");
    expect(getTray(USER, "new")).toHaveLength(3);
    await flush();
    act(() =>
      FakeXhr.instances[0]?.respond(415, {
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "x" },
      }),
    );
    act(() =>
      FakeXhr.instances[1]?.respond(413, { error: { code: "QUOTA_EXCEEDED", message: "x" } }),
    );
    await flush();
    expect(getTray(USER, "new").map((a) => a.error)).toEqual([
      "Unsupported file",
      "Storage full",
      null,
    ]);
    // A text file over the size limit is refused before any upload.
    addFiles(
      USER,
      "other",
      [new File(["x".repeat(2_000)], "big.txt", { type: "text/plain" })],
      OPTIONS,
    );
    expect(getTray(USER, "other")[0]).toMatchObject({ status: "error", error: "Too large" });
    expect(FakeXhr.instances).toHaveLength(3);
  });

  it("removing aborts an upload in flight or deletes the pending server copy", async () => {
    addFiles(USER, "new", [image("1.png"), image("2.png")], OPTIONS);
    await flush();
    const [first, second] = getTray(USER, "new");
    act(() => {
      removeAttachment(USER, "new", first?.localId ?? "");
    });
    expect(FakeXhr.instances[0]?.aborted).toBe(true);
    act(() => FakeXhr.instances[1]?.respond(201, dto(2)));
    await flush();
    act(() => {
      removeAttachment(USER, "new", second?.localId ?? "");
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/attachments/${dto(2).id}`,
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(getTray(USER, "new")).toHaveLength(0);
    expect(revoke).toHaveBeenCalled();
  });

  it("take for a send clears the tray without deleting; a rejected send restores it", async () => {
    addFiles(USER, "new", [image()], OPTIONS);
    await flush();
    act(() => FakeXhr.instances[0]?.respond(201, dto(1)));
    await flush();
    const taken = takeReady(USER, "new");
    expect(taken).toEqual([dto(1)]);
    expect(getTray(USER, "new")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining("/api/attachments/"),
      expect.anything(),
    );
    restoreReady(USER, "new", taken);
    expect(getTray(USER, "new")[0]).toMatchObject({ status: "ready", dto: dto(1) });
  });

  it("an account change aborts uploads and clears every tray (contracts §12)", async () => {
    addFiles(USER, "new", [image()], OPTIONS);
    await flush();
    act(() => {
      authStore.applySession({
        ...SESSION,
        user: { id: "99999999-9999-4999-8999-999999999999", username: "bob", role: "user" },
        csrfToken: "csrf-bob",
      });
    });
    expect(FakeXhr.instances[0]?.aborted).toBe(true);
    expect(getTray(USER, "new")).toHaveLength(0);
  });
});

describe("transcript attachments", () => {
  it("demand-loads bytes: lazy thumbnails, audio preload none, text only on download; missing is a placeholder", () => {
    const open = vi.fn();
    render(
      <MessageAttachments
        onOpenImage={open}
        items={[
          {
            id: dto(1).id,
            missing: false,
            filename: "photo.png",
            mediaType: "image/png",
            kind: "image",
            size: 10,
            width: 4,
            height: 3,
          },
          {
            id: dto(2).id,
            missing: false,
            filename: "clip.wav",
            mediaType: "audio/wav",
            kind: "audio",
            size: 2048,
            width: null,
            height: null,
          },
          {
            id: dto(3).id,
            missing: false,
            filename: "notes.md",
            mediaType: "text/markdown",
            kind: "text",
            size: 12,
            width: null,
            height: null,
          },
          {
            id: dto(4).id,
            missing: true,
            filename: null,
            mediaType: null,
            kind: null,
            size: null,
            width: null,
            height: null,
          },
        ]}
      />,
    );
    const img = screen.getByTestId("attachment-thumbnail");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("src")).toBe(`/api/attachments/${dto(1).id}/content`);
    expect(img.getAttribute("width")).toBe("4");
    fireEvent.click(screen.getByRole("button", { name: "View image photo.png" }));
    expect(open).toHaveBeenCalledWith(
      [expect.objectContaining({ id: dto(1).id })],
      0,
      expect.any(HTMLElement),
    );
    const audio = screen.getByTestId("attachment-audio").querySelector("audio");
    expect(audio?.getAttribute("preload")).toBe("none");
    expect(screen.getByTestId("attachment-file").getAttribute("href")).toBe(
      `/api/attachments/${dto(3).id}/content?download=1`,
    );
    expect(screen.getByTestId("attachment-missing").textContent).toContain(
      "Attachment unavailable",
    );
  });
});

function Page() {
  const { conversationId } = useParams();
  return (
    <ConversationView key={conversationId ?? "new"} userId={USER} conversationId={conversationId} />
  );
}

function renderNew(client = seededClient()) {
  client.setQueryData(queryKeys.attachmentLimits(USER), {
    maxFileBytes: 1_000_000,
    maxPerMessage: 10,
    quotaBytes: 10_000_000,
    usedBytes: 0,
  });
  client.setQueryData(queryKeys.preferences(USER), {
    pins: [],
    defaultProvider: null,
    defaultModel: null,
    historyImages: null,
    imageMaxEdge: 0,
  });
  return render(
    <AppHarness
      client={client}
      initial="/chat/new"
      routes={[
        { path: "/chat/new", element: <Page /> },
        { path: "/chat/:conversationId", element: <Page /> },
      ]}
    />,
  );
}

describe("composer with attachments", () => {
  it("the picker opens only from the + button (a genuine user activation)", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    renderNew();
    const box = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(box, "hello");
    expect(click).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Attach files" }));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("send waits for uploads, then posts the attachment ids; a text-only model warns about images", async () => {
    const vision = structuredClone(MODELS);
    const group = vision.providers[0];
    group?.models.push({
      ...(group.models[0] as (typeof group.models)[number]),
      id: "v1",
      capabilities: { inputModalities: ["text", "image"], reasoning: false, tools: false },
    });
    const client = seededClient();
    client.setQueryData(queryKeys.models(USER), vision);
    renderNew(client);
    const input = screen.getByTestId("file-input");
    fireEvent.change(input, { target: { files: [image("photo.png")] } });
    await waitFor(() => {
      expect(screen.getByTestId("attachment-chip")).toBeTruthy();
    });
    // m1 is text-only: the warning names it and Send stays disabled.
    expect(screen.getByTestId("capability-warning").textContent).toContain("m1 can't read images");
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });
    expect(send.disabled).toBe(true);
    await chooseModel(JSON.stringify(["local", "v1"]));
    expect(screen.queryByTestId("capability-warning")).toBeNull();
    expect(send.disabled).toBe(true); // still uploading
    await waitFor(() => {
      expect(FakeXhr.instances).toHaveLength(1);
    });
    act(() => FakeXhr.instances[0]?.respond(201, dto(1)));
    await waitFor(() => {
      expect(send.disabled).toBe(false);
    });
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === "/api/generations"
          ? json(422, { error: { code: "CONTEXT_TOO_LARGE", message: "Too long" } })
          : json(404, {}),
      ),
    );
    await userEvent.click(send);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/generations", expect.anything());
    });
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/generations");
    const body = JSON.parse(call?.[1]?.body as string) as {
      attachmentIds: string[];
      content: string;
    };
    expect(body.attachmentIds).toEqual([dto(1).id]);
    expect(body.content).toBe("");
    // Rejected: the attachment is back on the composer, still pending.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("attachment-tray")).getByTestId("attachment-chip").dataset.status,
      ).toBe("ready");
    });
  });
});
