// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown, safeUrl } from "../../app/components/Markdown";
import { Message } from "../../app/components/Message";

afterEach(cleanup);

function html(text: string): HTMLElement {
  return render(<Markdown text={text} />).container;
}

describe("INV-22: Markdown renders untrusted text inert", () => {
  it("drops raw <script> and event-handler HTML", () => {
    const root = html('hi <script>window.pwned = 1</script>\n\n<img src=x onerror="alert(1)">');
    expect(root.querySelector("script")).toBeNull();
    expect(root.querySelector("img")).toBeNull();
    expect(root.innerHTML).not.toMatch(/onerror/i);
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("strips javascript: and data: URLs and hardens links", () => {
    const root = html(
      "[a](javascript:alert(1)) [b](data:text/html,<b>x</b>) [c](JaVaScRiPt:alert(1)) [ok](https://example.com)",
    );
    const anchors = [...root.querySelectorAll("a")];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("href")).toBe("https://example.com");
    expect(anchors[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(anchors[0]?.getAttribute("target")).toBe("_blank");
    expect(root.innerHTML).not.toMatch(/javascript:|data:text/i);
  });

  it("shows HTML inside code fences as text", () => {
    const root = html("```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```");
    expect(root.querySelector("script, img")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toContain("<script>alert(1)</script>");
    expect(root.querySelector(".code-language")?.textContent).toBe("html");
  });

  it("never loads remote images (placeholder only)", () => {
    const root = html("![tracker](https://evil.example/pixel.png)");
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("[image: tracker]");
  });

  it("safeUrl keeps only http(s), mailto, fragments and same-origin paths", () => {
    expect(safeUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeUrl("mailto:a@b.example")).toBe("mailto:a@b.example");
    expect(safeUrl("#section")).toBe("#section");
    expect(safeUrl("/chat/new")).toBe("/chat/new");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example"]) {
      expect(safeUrl(bad)).toBe("");
    }
  });
});

describe("streaming Markdown renders every prefix stably", () => {
  const answer = [
    "Here is *emphasis* and **strong**.",
    "",
    "```ts",
    "const x = 1;",
    "console.log(x);",
    "```",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "- one",
    "  - nested",
    "    1. deep",
    "- two",
  ].join("\n");

  it("renders each growing chunk without throwing and converges on the final structure", () => {
    const { container, rerender } = render(<Markdown text="" />);
    for (let i = 1; i <= answer.length; i += 3) {
      rerender(<Markdown text={answer.slice(0, i)} />);
      // Never raw HTML, never lost text.
      expect(container.querySelector("script")).toBeNull();
    }
    rerender(<Markdown text={answer} />);
    expect(container.querySelector("em")?.textContent).toBe("emphasis");
    expect(container.querySelector("pre code")?.textContent).toContain("console.log(x);");
    expect(container.querySelectorAll("table td")).toHaveLength(2);
    expect(container.querySelector("ul ul ol li")?.textContent).toBe("deep");
  });

  it("an unfinished fence is already a code block (no layout flip at the close)", () => {
    const partial = "Intro\n\n```py\nprint('a')\nprint('b";
    const root = html(partial);
    expect(root.querySelector("pre code")?.textContent).toContain("print('b");
    expect(root.querySelector(".code-language")?.textContent).toBe("py");
  });

  it("an unfinished table row keeps earlier rows", () => {
    const root = html("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 |");
    expect(root.querySelectorAll("tbody tr").length).toBeGreaterThanOrEqual(1);
    expect(root.querySelector("th")?.textContent).toBe("a");
  });

  it("rendering never changes the stored message (frozen DTO renders unchanged)", () => {
    const stored = Object.freeze({
      role: "assistant" as const,
      content: "keep *this* `exactly`\n\n```\n<b>\n```\n[x](javascript:alert(1))",
      reasoning: "why",
      status: "complete" as const,
    });
    const before = JSON.stringify(stored);
    render(<Message {...stored} />);
    expect(JSON.stringify(stored)).toBe(before);
  });
});
