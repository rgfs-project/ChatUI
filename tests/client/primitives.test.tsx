// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../app/components/Sidebar";
import { queryKeys } from "../../app/lib/query";
import { AppHarness, CONV, json, noop, seededClient, TEST_USER, USER } from "./support";

/** jsdom lacks the pointer/layout APIs Radix probes. */
beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = () => false;
  proto.releasePointerCapture = () => undefined;
  proto.scrollIntoView = () => undefined;
  const noop = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = noop;
      unobserve = noop;
      disconnect = noop;
    },
  );
});

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(json(200, { conversations: [] })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSidebar() {
  const client = seededClient();
  client.setQueryData(queryKeys.conversations(USER), [
    {
      id: CONV,
      title: "Trip plans",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
      malformed: false,
    },
  ]);
  const page = (
    <div style={{ overflow: "hidden" }} data-testid="clipping-ancestor">
      <Sidebar user={TEST_USER} hidden={false} drawer={false} onHide={noop} onNavigate={noop} />
    </div>
  );
  return render(
    <AppHarness
      client={client}
      initial={`/chat/${CONV}`}
      routes={[{ path: "/chat/:conversationId", element: page }]}
    />,
  );
}

describe("INV-47: menus (Radix DropdownMenu)", () => {
  it("opens from the keyboard, moves with arrows, closes on Escape and restores focus", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const trigger = screen.getByRole("button", { name: "Actions for Trip plans" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent.trim())).toEqual(["Rename", "Delete"]);
    // Portal layering: rendered outside the clipping ancestor.
    expect(screen.getByTestId("clipping-ancestor").contains(menu)).toBe(false);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent.trim()).toBe("Delete");
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });
});

describe("INV-47: dialogs (Radix Dialog)", () => {
  it("rename: labelled, prefilled, traps focus, Escape closes and focus returns", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const trigger = screen.getByRole("button", { name: "Actions for Trip plans" });
    trigger.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
    await user.keyboard("{Enter}"); // first item: Rename
    const dialog = await screen.findByRole("dialog", { name: "Rename conversation" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    const input = within(dialog).getByRole<HTMLInputElement>("textbox", { name: "Title" });
    expect(input.value).toBe("Trip plans");
    await waitFor(() => {
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
    // Focus trap: tabbing cycles inside the dialog.
    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    // Everything else is hidden from assistive technology while open.
    expect(screen.getByTestId("clipping-ancestor").closest("[aria-hidden='true']")).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("delete: confirmation names the conversation; Cancel does nothing", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Actions for Trip plans" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete conversation?" });
    expect(dialog.textContent).toContain('"Trip plans" will be permanently deleted');
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("rename submits the trimmed title through the shared adapter", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole("button", { name: "Actions for Trip plans" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Title" });
    await user.clear(input);
    await user.type(input, "  Summer trip  {Enter}");
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
    });
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "PATCH") ?? [];
    expect(url).toBe(`/api/conversations/${CONV}`);
    expect(JSON.parse(init?.body as string)).toEqual({ title: "Summer trip" });
  });
});

describe("screen-reader smoke", () => {
  it("the sidebar is a labelled navigation landmark with the current conversation marked", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Conversations" });
    const current = within(nav).getByRole("link", { name: "Trip plans" });
    expect(current.getAttribute("aria-current")).toBe("page");
    for (const button of within(nav).getAllByRole("button"))
      expect(button.getAttribute("aria-label") ?? button.textContent).toBeTruthy();
  });
});
