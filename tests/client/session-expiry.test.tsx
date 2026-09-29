// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRoutesStub } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@shared/auth";
import { resetAuthStoreForTests } from "../../app/lib/auth-store";
import App from "../../app/root";
import AppLayout from "../../app/routes/app-layout";
import ChatNew from "../../app/routes/chat-new";
import { FakeEventSource, json, MODELS, SESSION } from "./support";

/**
 * Session expiry mid-use (contracts §12): a 401 opens the in-app
 * re-authentication dialog without navigating; the draft stays in tab memory
 * only and comes back only for the same user.
 */

const BOB: SessionDto = {
  user: { id: "77777777-7777-4777-8777-777777777777", username: "bob", role: "user" },
  csrfToken: "csrf-bob",
  registrationOpen: false,
};

let expired: boolean;
let loginAs: SessionDto;
let setItem: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.scrollIntoView = () => undefined;
});

beforeEach(() => {
  resetAuthStoreForTests();
  Element.prototype.scrollTo = () => undefined;
  vi.stubGlobal("EventSource", FakeEventSource);
  expired = false;
  loginAs = SESSION;
  setItem = vi.spyOn(Storage.prototype, "setItem");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/auth/login" && init?.method === "POST") {
        expired = false;
        return Promise.resolve(json(200, loginAs));
      }
      if (expired)
        return Promise.resolve(json(401, { error: { code: "UNAUTHENTICATED", message: "x" } }));
      if (url.startsWith("/api/models")) return Promise.resolve(json(200, MODELS));
      return Promise.resolve(json(200, { conversations: [] }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderApp() {
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      Component: App,
      loader: () => ({ session: loginAs.user?.id === BOB.user?.id && !expired ? BOB : SESSION }),
      children: [
        {
          id: "routes/app-layout",
          Component: AppLayout,
          loader: () => ({ dehydratedState: undefined, user: SESSION.user }),
          children: [{ path: "chat/new", Component: ChatNew }],
        },
        { path: "login", Component: () => <p>login page</p> },
      ],
    },
  ]);
  return render(<Stub initialEntries={["/chat/new"]} />);
}

async function composer() {
  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
}

/** Types a draft, then sends it after the session has ended server-side. */
async function expireWhileSending(text: string) {
  const user = userEvent.setup();
  const box = await composer();
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
  });
  await user.click(box);
  await user.keyboard(text);
  expired = true;
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Sign in again" });
  return { user, dialog };
}

describe("contracts §12: session expiry mid-use", () => {
  it("opens the in-app dialog once, hides private content, and restores the draft for the same user", async () => {
    renderApp();
    const { user, dialog } = await expireWhileSending("unsent words");
    // No document navigation; private content is gone while signed out.
    expect(screen.queryByText("login page")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Conversations" })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByLabelText<HTMLInputElement>("Username").value).toBe("alice");
    await user.type(within(dialog).getByLabelText("Password"), "correct horse");
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect((await composer()).value).toBe("unsent words");
    expect(screen.getByTestId("signed-in-user").textContent).toBe("alice");
  });

  it("a different identity discards the draft and the previous account's view", async () => {
    renderApp();
    const { user, dialog } = await expireWhileSending("alice's secret draft");
    loginAs = BOB;
    const name = within(dialog).getByLabelText("Username");
    await user.clear(name);
    await user.type(name, "bob");
    await user.type(within(dialog).getByLabelText("Password"), "bob password");
    await user.click(within(dialog).getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect((await composer()).value).toBe("");
    expect(screen.queryByText(/alice's secret draft/)).toBeNull();
    expect(screen.getByTestId("signed-in-user").textContent).toBe("bob");
  });

  it("a reload discards the draft (tab memory only, never browser storage)", async () => {
    const first = renderApp();
    await expireWhileSending("gone after reload");
    first.unmount();
    // A reload is a fresh page: new module state, new shell.
    resetAuthStoreForTests();
    expired = false;
    renderApp();
    expect((await composer()).value).toBe("");
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("leaving for the sign-in page discards the draft", async () => {
    renderApp();
    const { user, dialog } = await expireWhileSending("left behind");
    await user.click(within(dialog).getByTestId("reauth-login-page"));
    await screen.findByText("login page");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("while auth is known from the SSR session, neither a sign-in prompt nor a neutral state ever renders", async () => {
    const flashes: string[] = [];
    const observer = new MutationObserver(() => {
      for (const id of ["auth-unknown", "signed-out"])
        if (document.querySelector(`[data-testid="${id}"]`)) flashes.push(id);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    renderApp();
    await composer();
    observer.disconnect();
    expect(flashes).toEqual([]);
    expect(screen.getByTestId("app-shell").getAttribute("data-auth")).toBe("authenticated");
    expect(screen.getByTestId("signed-in-user").textContent).toBe("alice");
  });
});
