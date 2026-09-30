// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useParams } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationView } from "../../app/components/ConversationView";
import { restoreReady } from "../../app/lib/attachments";
import {
  AppHarness,
  conversation,
  CONV,
  FakeEventSource,
  GEN,
  json,
  message,
  REPLY,
  seededClient,
  signInStore,
  USER,
} from "./support";

/**
 * Phase 15, INV-48: the native composer keeps IME, Enter/Shift+Enter, paste,
 * draft and focus semantics, and can never send the same message twice.
 */

function Page() {
  const { conversationId } = useParams();
  return (
    <ConversationView key={conversationId ?? "new"} userId={USER} conversationId={conversationId} />
  );
}

function renderAt(initial: string, client = seededClient(conversation(history))) {
  return render(
    <AppHarness
      client={client}
      initial={initial}
      routes={[
        { path: "/chat/new", element: <Page /> },
        { path: "/chat/:conversationId", element: <Page /> },
      ]}
    />,
  );
}

const history = [message(1, "user", "first question"), message(2, "assistant", "first answer")];

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  signInStore();
  Element.prototype.scrollTo = () => undefined;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock = vi.fn((url: string, init?: RequestInit) =>
    Promise.resolve(
      url === "/api/generations" && init?.method === "POST"
        ? json(202, {
            conversationId: CONV,
            generationId: GEN,
            userMessageId: "55555555-5555-4555-8555-555555555555",
            assistantMessageId: REPLY,
          })
        : url.startsWith("/api/conversations/")
          ? json(200, conversation(history))
          : json(200, { conversations: [] }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const posts = () => fetchMock.mock.calls.filter(([url]) => url === "/api/generations");
const box = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Message" });

function type(text: string) {
  fireEvent.input(box(), { target: { value: text } });
}

describe("INV-48: composer semantics", () => {
  it("INV-48: Enter inside an IME composition never sends (isComposing, and Safari's keyCode 229)", async () => {
    renderAt(`/chat/${CONV}`);
    type("にほんご");
    fireEvent.keyDown(box(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(box(), { key: "Enter", keyCode: 229 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(posts()).toHaveLength(0);
    expect(box().value).toBe("にほんご");
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
  });

  it("INV-48: a rapid double Enter sends one message", async () => {
    renderAt(`/chat/${CONV}`);
    type("only once");
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(posts()).toHaveLength(1);
  });

  it("INV-48: a double click on Send sends one message", async () => {
    renderAt(`/chat/${CONV}`);
    type("clicked twice");
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(posts()).toHaveLength(1);
  });

  it("INV-48: a double Enter with only an attachment sends one message, never an empty one", async () => {
    restoreReady(USER, CONV, [
      {
        id: "66666666-6666-4666-8666-666666666666",
        filename: "notes.txt",
        mediaType: "text/plain",
        kind: "text",
        size: 12,
        width: null,
        height: null,
        linked: false,
      },
    ]);
    renderAt(`/chat/${CONV}`);
    await screen.findByTestId("attachment-chip");
    fireEvent.keyDown(box(), { key: "Enter" });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => {
      expect(posts()).toHaveLength(1);
    });
    const body = JSON.parse(posts()[0]?.[1]?.body as string) as { attachmentIds?: string[] };
    expect(body.attachmentIds).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });

  it("INV-48: pasted text goes into the box; pasted files attach (text alongside them is kept)", async () => {
    renderAt(`/chat/${CONV}`);
    const textOnly = { types: ["text/plain"], files: [] as File[] };
    expect(fireEvent.paste(box(), { clipboardData: textOnly })).toBe(true);
    expect(screen.queryByTestId("attachment-chip")).toBeNull();

    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const filesOnly = { types: ["Files"], files: [file] };
    // Files only: the default (inserting a file name) is prevented and the file attaches.
    expect(fireEvent.paste(box(), { clipboardData: filesOnly })).toBe(false);
    expect(await screen.findByTestId("attachment-chip")).toBeTruthy();

    const both = { types: ["Files", "text/plain"], files: [file] };
    expect(fireEvent.paste(box(), { clipboardData: both })).toBe(true);
  });

  it("INV-48: switching the model keeps the draft", () => {
    renderAt(`/chat/${CONV}`);
    type("keep me");
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Model" });
    fireEvent.change(select, { target: { value: select.options[0]?.value ?? "" } });
    expect(box().value).toBe("keep me");
  });

  it("INV-48: streaming never takes focus from the composer or a message control", async () => {
    const user = userEvent.setup();
    renderAt(`/chat/${CONV}`, seededClient(conversation(history, GEN)));
    const source = FakeEventSource.latest();
    act(() => {
      source.emit("snapshot", {
        generationId: GEN,
        assistantMessageId: REPLY,
        state: "streaming",
        content: "",
        reasoning: "",
        error: null,
      });
    });
    await user.click(box());
    await user.keyboard("typing while it streams");
    for (let i = 0; i < 20; i++)
      act(() => {
        source.emit("delta", { content: i % 5 === 0 ? `\n\nblock ${String(i)} ` : "tok " });
      });
    expect(document.activeElement).toBe(box());
    expect(box().value).toBe("typing while it streams");

    const copy = screen.getAllByRole("button", { name: "Copy reply" })[0];
    copy?.focus();
    for (let i = 0; i < 10; i++)
      act(() => {
        source.emit("delta", { content: " more" });
      });
    expect(document.activeElement).toBe(copy);
  });
});
