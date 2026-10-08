// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type ComposerProps } from "../../app/components/Composer";
import { Markdown } from "../../app/components/Markdown";
import { AssistantMessage } from "../../app/components/Message";

afterEach(cleanup);

describe("Markdown", () => {
  it("formats text and never renders raw HTML", () => {
    const { container } = render(
      <Markdown text={"**bold** <script>alert(1)</script><img src=x onerror=alert(1)>"} />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders GFM tables and opens external links safely", () => {
    const { container } = render(
      <Markdown text={"| a | b |\n| - | - |\n| 1 | 2 |\n\n[x](https://example.com)"} />,
    );
    expect(container.querySelector("table")).not.toBeNull();
    const link = container.querySelector("a");
    expect(link?.getAttribute("rel")).toContain("noopener");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("drops javascript: links", () => {
    const { container } = render(<Markdown text={"[x](javascript:alert(1))"} />);
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toContain("javascript");
  });

  it("shows code blocks with their language and a copy button", () => {
    render(<Markdown text={"```python\nprint('hi')\n```"} />);
    expect(screen.getByText("python")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });
});

describe("AssistantMessage", () => {
  it("says a stopped reply was stopped", () => {
    render(<AssistantMessage content="partial" reasoning={null} status="cancelled" />);
    expect(screen.getByTestId("message-assistant").textContent).toContain("Stopped");
  });
});

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const onSend = vi.fn(() => Promise.resolve(true));
  const onCommand = vi.fn();
  const props: ComposerProps = {
    models: undefined,
    model: { providerId: "local", model: "m" },
    onModelChange: vi.fn(),
    kinds: [],
    maxPerMessage: 10,
    imageMaxEdge: 3072,
    skills: [
      {
        id: "00000000-0000-4000-8000-000000000009",
        name: "summarize",
        description: "",
        instructions: "x",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
    ],
    inChat: true,
    generating: false,
    onSend,
    onStop: vi.fn(),
    onCommand,
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return { onSend, onCommand };
}

describe("Composer", () => {
  it("sends on Enter and keeps Shift+Enter for new lines", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    await user.type(box, "hello{Shift>}{Enter}{/Shift}there{Enter}");
    expect(onSend).toHaveBeenCalledWith({ content: "hello\nthere", attachments: [] });
  });

  it("applies a skill chosen from the / menu", async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "/sum");
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: /summarize/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.type(screen.getByRole("textbox", { name: "Message" }), "this{Enter}");
    expect(onSend).toHaveBeenCalledWith({ content: "/summarize this", attachments: [] });
  });

  it("runs built-in commands", async () => {
    const user = userEvent.setup();
    const { onCommand } = renderComposer();
    await user.type(screen.getByRole("textbox", { name: "Message" }), "/ren{Enter}");
    expect(onCommand).toHaveBeenCalledWith("rename");
  });

  it("offers Stop while a reply is written", () => {
    renderComposer({ generating: true });
    expect(screen.getByRole("button", { name: "Stop generating" })).toBeTruthy();
  });
});
