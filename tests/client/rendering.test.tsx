// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Markdown } from "../../app/chat/markdown";
import { speakableText } from "../../app/chat/read-aloud";
import { highlighterModule } from "../../app/chat/render/code";
import { katexModule, looksLikeMoney, normalizeMath } from "../../app/chat/render/math";
import { tableToTsv } from "../../app/chat/render/table";

beforeAll(async () => {
  await katexModule.load();
  await highlighterModule.load();
});

afterEach(() => {
  cleanup();
});

async function show(source: string): Promise<HTMLElement> {
  const { container } = render(<Markdown>{source}</Markdown>);
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("math (KaTeX → MathML, INV-45, INV-46)", () => {
  it("inline and display math render as semantic MathML with the TeX source kept", async () => {
    const el = await show("Euler: $e^{i\\pi}+1=0$\n\n$$\n\\int_0^1 x\\,dx\n$$");
    const maths = el.querySelectorAll("math");
    expect(maths).toHaveLength(2);
    expect(el.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toContain(
      "e^{i\\pi}",
    );
    expect(screen.getByRole("button", { name: "Copy LaTeX" })).toBeTruthy();
  });

  it("a whole line of \\[…\\] is a display block; \\(…\\) is inline", async () => {
    const el = await show("Area \\(\\pi r^2\\) and\n\\[ a^2 + b^2 = c^2 \\]");
    expect(el.querySelectorAll(".math-display math")).toHaveLength(1);
    expect(el.querySelectorAll(".math-inline math")).toHaveLength(1);
  });

  it("dollar amounts stay plain text", async () => {
    const el = await show("It costs $5 and $10 in total.");
    expect(el.querySelector("math")).toBeNull();
    expect(el.textContent).toContain("$5 and $10");
    expect(looksLikeMoney("5 and ")).toBe(true);
    expect(looksLikeMoney("x^2")).toBe(false);
  });

  it("malformed math falls back to inert source", async () => {
    const el = await show("Broken $\\frac{1$ here\n\n$$\n\\begin{matrix\n$$");
    expect(el.querySelector("math")).toBeNull();
    expect(el.querySelectorAll(".math-source").length).toBeGreaterThan(0);
  });

  it("\\href and \\url never become links (trust is off)", async () => {
    const el = await show("$\\href{javascript:alert(1)}{click}$ and $\\url{https://evil.example}$");
    // The TeX source survives only as text in the MathML annotation; nothing links.
    expect(el.querySelector("a, [href], [xlink\\:href]")).toBeNull();
    expect(el.querySelector("annotation")?.textContent).toContain("\\href");
  });

  it("math delimiters inside code fences are left alone", () => {
    const source = "```\n\\[ not math \\]\n```";
    expect(normalizeMath(source)).toBe(source);
  });
});

describe("code highlighting (lazy, inert)", () => {
  it("known languages get highlight spans", async () => {
    const el = await show("```js\nconst x = 1; // note\n```");
    expect(el.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(el.querySelector(".hljs-comment")?.textContent).toBe("// note");
  });

  it("HTML in code stays text after highlighting", async () => {
    const el = await show('```html\n<script>alert(1)</script><img src=x onerror="alert(2)">\n```');
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("<script>alert(1)</script>");
  });

  it("unknown languages fall back to plain preformatted text", async () => {
    const el = await show("```klingon\nqapla'\n```");
    expect(el.querySelector(".code-block code")?.innerHTML).toBe("qapla'");
    expect(el.querySelector(".code-lang")?.textContent).toBe("klingon");
  });

  it("HTML in a block of an unknown language stays text (INV-45)", async () => {
    const el = await show('```klingon\n<img src=x onerror="alert(1)"><b>bold</b>\n```');
    expect(el.querySelector("img, b")).toBeNull();
    expect(el.querySelector(".code-block code")?.textContent).toBe(
      '<img src=x onerror="alert(1)"><b>bold</b>',
    );
  });
});

describe("table tools", () => {
  it("Copy produces tab-separated rows that paste into spreadsheets", async () => {
    const el = await show("| a | b |\n|---|---|\n| 1 | two words |");
    const table = el.querySelector("table");
    expect(table && tableToTsv(table)).toBe("a\tb\n1\ttwo words");
    expect(screen.getByRole("button", { name: "Copy table" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Expand table" })).toBeTruthy();
  });
});

describe("read aloud (INV-52: offered only where supported)", () => {
  it("speech text drops Markdown and code", () => {
    expect(speakableText("**Hi** `x` [link](https://a.b)\n```js\ncode\n```")).toBe(
      "Hi x link code block.",
    );
  });

  it("the action is hidden without speech synthesis", async () => {
    const { Message } = await import("../../app/chat/message");
    const { inChat, seededClient } = await import("./harness");
    vi.stubGlobal("speechSynthesis", undefined);
    // jsdom has no speechSynthesis; the stub above keeps it that way explicitly.
    delete (window as { speechSynthesis?: unknown }).speechSynthesis;
    render(
      inChat(
        seededClient(),
        <Message
          message={{
            id: "11111111-0000-4000-8000-000000000001",
            role: "assistant",
            content: "Hello",
            reasoning: null,
            status: "complete",
            provider: null,
            model: null,
            attachments: [],
            time: null,
            tools: [],
            artifacts: [],
            thoughtMs: null,
          }}
        />,
      ),
    );
    await screen.findByRole("button", { name: "Copy reply" });
    expect(screen.queryByRole("button", { name: "Read aloud" })).toBeNull();
    vi.unstubAllGlobals();
  });
});
