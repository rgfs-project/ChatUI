import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, safeUrl } from "../../app/chat/markdown";

const html = (source: string) => renderToStaticMarkup(<Markdown>{source}</Markdown>);

describe("INV-22: rendered Markdown never executes script or raw HTML", () => {
  it.each([
    ["<script>alert(1)</script>", "<script"],
    ['<img src=x onerror="alert(1)">', "<img"],
    ["<iframe src=https://evil.example></iframe>", "<iframe"],
    ['<a href="javascript:alert(1)">x</a>', "<a href"],
    ['<div onclick="alert(1)">x</div>', "<div onclick"],
  ])("%s is shown as inert text", (source, forbidden) => {
    const out = html(source);
    expect(out).not.toContain(forbidden);
  });

  it("javascript:, data: and vbscript: links are removed; http(s) and mailto get safe rel", () => {
    const out = html(
      "[a](javascript:alert(1)) [b](data:text/html,<script>x</script>) [c](vbscript:x) [d](https://ok.example) [e](mailto:me@example.com)",
    );
    expect(out).not.toMatch(/href="(javascript|data|vbscript):/i);
    expect(out).toContain('href="https://ok.example" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('href="mailto:me@example.com"');
    expect(safeUrl("JaVaScRiPt:alert(1)")).toBe("");
    expect(safeUrl("/chat/new")).toBe("/chat/new");
  });

  it("HTML inside code fences is text, never markup", () => {
    const out = html("```html\n<script>alert(1)</script>\n```");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain('<span class="code-lang">html</span>');
  });

  it("images are not loaded; their reference is shown instead", () => {
    const out = html("![cat](https://img.example/cat.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("Image: cat");
  });
});

describe("streaming Markdown stays stable on unfinished structures", () => {
  it("an unterminated fence renders as a code block that grows", () => {
    const partial = html("Intro\n\n```py\nprint(1)\nprin");
    expect(partial).toContain('class="code-block"');
    expect(partial).toContain("print(1)\nprin");
    const done = html("Intro\n\n```py\nprint(1)\nprint(2)\n```\n\nAfter");
    expect(done).toContain("print(1)\nprint(2)");
    expect(done).toContain("<p>After</p>");
  });

  it("a table header without rows, then with rows, renders without throwing", () => {
    expect(() => html("| a | b |\n|---|")).not.toThrow();
    expect(html("| a | b |\n|---|---|\n| 1 |")).toContain("<table>");
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("<td>2</td>");
  });

  it("nested lists and open emphasis render at every prefix", () => {
    const source = "- one\n  - nested **bold** and *it";
    for (let i = 1; i <= source.length; i++) expect(() => html(source.slice(0, i))).not.toThrow();
    expect(html(source)).toContain("<ul>");
  });

  it("rendering never changes the source text", () => {
    const source = "**bold** `code` <b>raw</b>";
    html(source);
    expect(source).toBe("**bold** `code` <b>raw</b>");
  });
});
