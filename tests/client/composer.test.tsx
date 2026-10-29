// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSession } from "../../app/lib/api";
import { chatApp, CONV, conversation, FakeEventSource, seededClient, USER } from "./harness";

const accepted = {
  conversationId: CONV,
  generationId: "9e9e9e9e-0000-4000-8000-000000000002",
  userMessageId: "11111111-0000-4000-8000-000000000003",
  assistantMessageId: "11111111-0000-4000-8000-000000000004",
};
let posts: { body: Record<string, unknown>; headers: Headers }[];

beforeEach(() => {
  posts = [];
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  setSession({ user: USER, csrfToken: "tok", registrationOpen: false });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === "/api/generations" && init.method === "POST") {
        posts.push({
          body: JSON.parse(init.body as string) as Record<string, unknown>,
          headers: new Headers(init.headers),
        });
        return Promise.resolve(new Response(JSON.stringify(accepted), { status: 202 }));
      }
      if (url.startsWith("/api/conversations/"))
        return Promise.resolve(new Response(JSON.stringify(conversation()), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ conversations: [] }), { status: 200 }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function draft() {
  const App = chatApp(seededClient());
  render(<App at="/chat/new" />);
  const box = await screen.findByRole("textbox", { name: "Message" });
  return box as HTMLTextAreaElement;
}

describe("composer keyboard behaviour", () => {
  it("Enter sends once with an operation key, CSRF token and expected user", async () => {
    const box = await draft();
    const user = userEvent.setup();
    await user.type(box, "hello there");
    await user.keyboard("{Enter}");
    await vi.waitFor(() => {
      expect(posts).toHaveLength(1);
    });
    const [post] = posts;
    expect(post?.body).toMatchObject({
      providerId: "local",
      model: "mock-chat",
      content: "hello there",
    });
    expect(post?.body.operationKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.body.conversationId).toBeUndefined();
    expect(post?.headers.get("X-CSRF-Token")).toBe("tok");
    expect(post?.headers.get("X-Expected-User")).toBe(USER.id);
  });

  it("Shift+Enter adds a new line and never sends", async () => {
    const box = await draft();
    const user = userEvent.setup();
    await user.type(box, "line one{Shift>}{Enter}{/Shift}line two");
    expect(box.value).toBe("line one\nline two");
    expect(posts).toHaveLength(0);
  });

  it("Enter during IME composition does not send", async () => {
    const box = await draft();
    fireEvent.input(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(posts).toHaveLength(0);
  });

  it("a second Enter before React re-renders cannot send twice", async () => {
    const box = await draft();
    fireEvent.input(box, { target: { value: "double" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    await vi.waitFor(() => {
      expect(posts.length).toBeGreaterThan(0);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(posts).toHaveLength(1);
  });

  it("an empty draft cannot be sent", async () => {
    await draft();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(true);
  });
});

describe("conversation states", () => {
  it("a malformed conversation explains the problem and offers only delete", async () => {
    const App = chatApp(seededClient({ ok: false, code: "CONVERSATION_MALFORMED" }));
    render(<App at={`/chat/${CONV}`} />);
    expect(await screen.findByText("This conversation can't be opened.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Delete it/ })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("a missing conversation is reported, not created", async () => {
    const App = chatApp(seededClient({ ok: false, code: "NOT_FOUND" }));
    render(<App at={`/chat/${CONV}`} />);
    expect(await screen.findByText("This conversation does not exist.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });
});
