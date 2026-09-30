// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../../app/components/Markdown";
import { Message } from "../../app/components/Message";
import { MAX_TEX_LENGTH } from "../../app/components/math/MathView";
import { MAX_HIGHLIGHT_CHARS } from "../../app/components/code/highlight";
import { downloadName, grammarFor } from "../../app/lib/code-languages";
import { renderCounters } from "../../app/lib/render-counters";
import { loadMath } from "../../app/lib/renderers";

/**
 * Phase 14: the answer surface. INV-45 (math, code and Markdown never execute
 * provider content), INV-46 (incremental rendering keeps DOM identity,
 * selection and bounded work), MathML and copy-source behavior.
 */

const MATHML = "http://www.w3.org/1998/Math/MathML";

beforeAll(async () => {
  // Math renders synchronously once its chunk is loaded (as on the server).
  await loadMath();
});
beforeEach(() => {
  for (const key of Object.keys(renderCounters) as (keyof typeof renderCounters)[])
    renderCounters[key] = 0;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function html(text: string, props: { live?: boolean; growing?: boolean } = {}): HTMLElement {
  return render(<Markdown text={text} {...props} />).container;
}

/** Lets pending imports, effects and store updates settle. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function stubClipboard() {
  const writes: string[] = [];
  const clipboard = {
    writeText: (text: string) => {
      writes.push(text);
      return Promise.resolve();
    },
  };
  // jsdom has no Clipboard API: a navigator that adds one.
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator) as Navigator, { clipboard }));
  return writes;
}

/** The value, or a failed test. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}

describe("math renders as accessible MathML (INV-45)", () => {
  it("renders inline and display math as MathML with the TeX source kept", () => {
    const root = html("Energy $E = mc^2$ and\n\n$$\n\\frac{a}{b}\n$$\n\nalso \\(x\\) and \\[y\\]");
    const maths = root.querySelectorAll("math");
    expect(maths).toHaveLength(4);
    for (const math of maths) expect(math.namespaceURI).toBe(MATHML);
    expect(root.querySelector(".math-inline")?.getAttribute("data-tex")).toBe("E = mc^2");
    const block = root.querySelector("div.math-block");
    expect(block?.getAttribute("data-tex")).toBe("\\frac{a}{b}");
    expect(block?.querySelector("math")?.getAttribute("display")).toBe("block");
    expect(root.querySelector("mfrac")).not.toBeNull();
    // The source rides along as a MathML annotation for assistive technology.
    expect(root.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      "E = mc^2",
    );
    // `\[…\]` inside a paragraph is display math made of phrasing elements.
    expect(root.querySelector("p span.math-block")?.getAttribute("data-tex")).toBe("y");
  });

  it("leaves dollar amounts, escaped dollars and code spans as text", () => {
    const root = html("It costs $5 and $10. Escaped \\$x\\$ stays. `$y$` is code. US$5 or $ 6$.");
    expect(root.querySelector("math")).toBeNull();
    expect(root.textContent).toContain("It costs $5 and $10.");
    expect(root.textContent).toContain("Escaped $x$ stays.");
    expect(root.querySelector("code")?.textContent).toBe("$y$");
  });

  it.each([
    ["\\href{javascript:alert(1)}{click}"],
    ["\\url{javascript:alert(1)}"],
    ["\\includegraphics{https://evil.example/pixel.png}"],
    ["\\htmlStyle{background:url(https://evil.example)}{x}"],
    ["\\htmlData{onclick=alert(1)}{x}"],
    ["\\htmlClass{evil}{x}"],
    ["\\text{<img src=x onerror=alert(1)><script>alert(1)</script>}"],
    ["\\def\\a{\\a\\a}\\a"],
    ["\\color{red;background:url(https://evil.example)}{x}"],
  ])("math injection %s renders inert", (tex) => {
    const root = html(`Before $${tex}$ after\n\n$$\n${tex}\n$$`);
    expect(root.querySelector("a, img, script, iframe, object, embed, foreignObject")).toBeNull();
    // The formula may appear as text (a title, data-tex, the source), never as behavior.
    for (const element of root.querySelectorAll("*"))
      for (const attribute of element.getAttributeNames())
        expect(attribute).not.toMatch(/^(on.*|href|src|style|xlink:href|action|formaction)$/i);
    expect(root.textContent).toContain("Before");
    expect(root.textContent).toContain("after");
  });

  it("shows malformed math as inert source with the reason, and the rest renders", () => {
    const root = html("Intro text.\n\n$$\\frac{a}{$$\n\nThen $\\badcommand{x}$ and **bold**.");
    const sources = root.querySelectorAll("[data-testid=math-source]");
    expect(sources).toHaveLength(2);
    expect(sources[0]?.textContent).toBe("\\frac{a}{");
    expect(sources[0]?.getAttribute("title")).toMatch(/Couldn’t render this formula/);
    expect(sources[1]?.textContent).toBe("\\badcommand{x}");
    expect(root.querySelector("strong")?.textContent).toBe("bold");
    expect(root.textContent).toContain("Intro text.");
  });

  it("keeps macro definitions inside one formula", () => {
    const root = html("$\\gdef\\secret{42}\\secret$ then $\\secret$");
    expect(root.querySelector("math")?.textContent).toContain("42");
    expect(root.querySelector("[data-testid=math-source]")?.textContent).toBe("\\secret");
  });

  it("does not render an oversized formula", () => {
    const tex = "x+".repeat(MAX_TEX_LENGTH);
    const root = html(`$${tex}x$`);
    expect(root.querySelector("math")).toBeNull();
    expect(root.querySelector("[data-testid=math-source]")?.getAttribute("title")).toMatch(
      /too long/,
    );
  });

  it("copies a display formula's exact LaTeX", async () => {
    const writes = stubClipboard();
    html("$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$");
    fireEvent.click(screen.getByRole("button", { name: "Copy LaTeX" }));
    await settle();
    expect(writes).toEqual(["\\sum_{i=1}^n i = \\frac{n(n+1)}{2}"]);
  });

  it("copies a selection containing math as $…$ source", () => {
    const root = html("Area $\\pi r^2$ of a circle.\n\n$$\nx^2\n$$");
    const paragraph = must(root.querySelector("p"));
    const last = must(paragraph.lastChild);
    const range = document.createRange();
    range.setStart(must(paragraph.firstChild), 0);
    range.setEnd(last, (last.textContent ?? "").length);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const data = new Map<string, string>();
    fireEvent.copy(must(root.querySelector(".markdown")), {
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
    });
    expect(data.get("text/plain")).toBe("Area $\\pi r^2$ of a circle.");

    // A selection inside one formula copies that whole formula.
    const inner = root.querySelector("div.math-block mi");
    const r2 = document.createRange();
    r2.selectNodeContents(must(inner));
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(r2);
    fireEvent.copy(must(root.querySelector(".markdown")), {
      clipboardData: { setData: (type: string, value: string) => data.set(type, value) },
    });
    expect(data.get("text/plain")).toBe("$$x^2$$");
  });

  it("server HTML has rendered math and no style attributes (the CSP blocks them)", () => {
    const markup = renderToString(
      <Markdown
        text={"$$\n\\begin{pmatrix}1&2\\\\3&4\\end{pmatrix} \\boxed{x}\n$$\n\ninline $a_1$"}
      />,
    );
    expect(markup).toContain("<math");
    expect(markup).toContain("<mtable");
    // Temml's matrix padding is applied through the CSSOM (checked in the browser E2E).
    expect(markup).not.toMatch(/\sstyle=/);
  });

  it("renders every prefix of a math-heavy answer without throwing", () => {
    const answer =
      "Let $f(x) = \\frac{1}{x}$.\n\n$$\n\\int_1^e f(x)\\,dx = 1\n$$\n\nThen \\(g\\) and $$\\sqrt{2}$$ end, $5.";
    const { container, rerender } = render(<Markdown text="" live growing />);
    for (let i = 1; i <= answer.length; i++) {
      rerender(<Markdown text={answer.slice(0, i)} live growing />);
      expect(container.querySelector("script")).toBeNull();
    }
    rerender(<Markdown text={answer} live />);
    expect(container.querySelectorAll("math")).toHaveLength(4);
  });

  it("keeps an unfinished display formula as source while it streams", () => {
    const root = html("Text\n\n$$\n\\frac{a}{", { live: true, growing: true });
    const source = root.querySelector("[data-testid=math-source]");
    expect(source?.textContent).toBe("\\frac{a}{");
    expect(source?.getAttribute("title")).toBeNull();
  });
});

describe("read-only code blocks (INV-45)", () => {
  it("highlights a known language lazily, keeping the exact text", async () => {
    const source = 'def square(x):\n    return x * x  # "quoted"';
    const root = html(`\`\`\`python\n${source}\n\`\`\``);
    expect(root.querySelector("pre code")?.textContent).toBe(source);
    await waitFor(() => {
      expect(root.querySelector(".hljs-keyword")).not.toBeNull();
    });
    expect(root.querySelector("pre code")?.textContent).toBe(source);
    expect(root.querySelector("pre code")?.className).toBe("language-python hljs");
    expect(root.querySelector(".code-language")?.textContent).toBe("python");
    expect(root.querySelector("pre")?.tabIndex).toBe(0);
  });

  it("falls back to plain text for an unknown language", async () => {
    const root = html("```unknownlang\nplain <b>text</b> here\n```");
    await settle();
    expect(root.querySelector(".code-language")?.textContent).toBe("unknownlang");
    expect(root.querySelector("pre code span, pre code b")).toBeNull();
    expect(root.querySelector("pre code")?.textContent).toBe("plain <b>text</b> here");
  });

  it("does not highlight an oversized block", async () => {
    const source = "x = 1\n".repeat(MAX_HIGHLIGHT_CHARS / 6 + 10);
    const root = html(`\`\`\`python\n${source}\`\`\``);
    await settle();
    expect(root.querySelector(".hljs-number")).toBeNull();
  });

  it("copies and downloads the exact source", async () => {
    const writes = stubClipboard();
    const blobs: Blob[] = [];
    const created = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:local-test";
    });
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() }),
    );
    const clicks: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this);
    });
    const source = 'fn main() {\n    println!("hi");\n}';
    html(`\`\`\`rust\n${source}\n\`\`\``);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    fireEvent.click(screen.getByRole("button", { name: "Download code" }));
    await settle();
    expect(writes).toEqual([source]);
    expect(clicks[0]?.download).toBe("snippet.rs");
    expect(blobs[0]?.type).toBe("text/plain;charset=utf-8");
    expect(await blobs[0]?.text()).toBe(source);
  });

  it("leaves an unfinished fence plain while it streams, then highlights it", async () => {
    const { container, rerender } = render(
      <Markdown text={"Intro\n\n```ts\nconst a = 1;"} live growing />,
    );
    await settle();
    expect(container.querySelector(".hljs-keyword")).toBeNull();
    rerender(<Markdown text={"Intro\n\n```ts\nconst a = 1;\n```\n\nMore"} live growing />);
    await waitFor(() => {
      expect(container.querySelector(".hljs-keyword")).not.toBeNull();
    });
  });

  it("maps fence labels to grammars and download names", () => {
    expect(grammarFor("py")).toBe("python");
    expect(grammarFor("TSX")).toBe("typescript");
    expect(grammarFor("unknownlang")).toBeNull();
    expect(grammarFor(undefined)).toBeNull();
    expect(downloadName("tsx")).toBe("snippet.tsx");
    expect(downloadName("python")).toBe("snippet.py");
    expect(downloadName("docker")).toBe("Dockerfile");
    expect(downloadName("../../etc/passwd")).toBe("snippet.txt");
    expect(downloadName(undefined)).toBe("snippet.txt");
  });
});

/** Markdown covering the block constructs whose boundaries matter while streaming. */
const CORPUS = [
  "# Title",
  "Setext heading",
  "===",
  "",
  "A paragraph with *emphasis*, a [link](https://example.com) and `code`.",
  "Lazy continuation line.",
  "- tight one",
  "- tight two",
  "",
  "1. loose one",
  "",
  "2. loose two",
  "   continued",
  "",
  "Paragraph then a number:",
  "2. not a list",
  "",
  "> quote",
  "lazy quote line",
  "",
  "    indented code",
  "",
  "```",
  "fenced without language",
  "",
  "blank line inside",
  "```",
  "~~~unknownlang",
  "tilde fence",
  "~~~",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "***",
  "",
  "<div>raw html block</div>",
  "",
  "$$",
  "x^2",
  "$$",
  "",
  "Inline $y$ and \\(z\\) end.",
  "",
  "- [ ] task",
  "- [x] done",
  "",
  "Final ~~strike~~ paragraph.",
].join("\n");

describe("incremental streaming rendering (INV-46)", () => {
  it("renders exactly like the whole document at every prefix", () => {
    const live = render(<Markdown text="" live />);
    const whole = render(<Markdown text="" />);
    for (let i = 1; i <= CORPUS.length; i += 3) {
      const text = CORPUS.slice(0, i);
      live.rerender(<Markdown text={text} live />);
      whole.rerender(<Markdown text={text} />);
      // Blocks rendered separately lack only the newline text between blocks.
      const normal = (markup: string) => markup.replace(/>\s+</g, "><");
      expect(normal(live.container.innerHTML), `prefix ${String(i)}`).toBe(
        normal(whole.container.innerHTML),
      );
    }
  });

  it("keeps finished blocks' DOM nodes and re-renders only the growing block", () => {
    const { container, rerender } = render(<Markdown text="First paragraph." live growing />);
    const first = container.querySelector("p");
    let text = "First paragraph.";
    for (let i = 0; i < 30; i++) {
      text += i % 5 === 0 ? `\n\nParagraph ${String(i)} ` : `word${String(i)} `;
      const before = renderCounters.markdownPartRenders;
      rerender(<Markdown text={text} live growing />);
      // The growing block, plus a new block's first render.
      expect(renderCounters.markdownPartRenders - before).toBeLessThanOrEqual(2);
    }
    expect(container.querySelector("p")).toBe(first);
    expect(first?.isConnected).toBe(true);
  });

  it("preserves a selection in a finished block while the reply grows", () => {
    const { container, rerender } = render(
      <Markdown text={"Select these words.\n\nSecond"} live growing />,
    );
    const node = must(must(container.querySelector("p")).firstChild);
    const range = document.createRange();
    range.setStart(node, 7);
    range.setEnd(node, 18);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    let text = "Select these words.\n\nSecond";
    for (let i = 0; i < 20; i++) {
      text += ` more${String(i)}`;
      if (i === 10) text += "\n\n```ts\nconst x = 1;\n```\n\n| a |\n| - |\n| 1 |\n\n- list";
      rerender(<Markdown text={text} live growing />);
    }
    const selection = window.getSelection();
    expect(selection?.toString()).toBe("these words");
    expect(selection?.anchorNode).toBe(node);
    expect(node.isConnected).toBe(true);
  });

  it("parses a growing reply with work linear in its length", () => {
    const { rerender } = render(<Markdown text="" live growing />);
    let text = "";
    const perPhase: number[] = [];
    for (let phase = 0; phase < 4; phase++) {
      const before = renderCounters.blockParseChars;
      for (let i = 0; i < 100; i++) {
        text += i % 4 === 0 ? `\n\nParagraph ${String(i)} with $x_${String(i)}$ ` : "some words ";
        rerender(<Markdown text={text} live growing />);
      }
      perPhase.push(renderCounters.blockParseChars - before);
    }
    // Only the last blocks re-parse: the work per token does not grow with the
    // reply (re-parsing everything would make the last phase ~7x the first).
    expect(perPhase[3]).toBeLessThan((perPhase[0] ?? 0) * 1.5);
  });

  it("a 200-message conversation: a streaming reply never re-renders stored messages", () => {
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `m${String(i)}`,
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: i % 2 === 0 ? `Question ${String(i)}` : `Answer ${String(i)} with $x^${String(i)}$.`,
    }));
    let append: (chunk: string) => void = () => undefined;
    function Live() {
      const [text, setText] = useState("");
      append = (chunk) => {
        setText((t) => t + chunk);
      };
      return <Markdown text={text} live growing />;
    }
    const { container } = render(
      <ol>
        {messages.map((m) => (
          <Message key={m.id} role={m.role} content={m.content} reasoning={null} status={null} />
        ))}
        <li>
          <Live />
        </li>
      </ol>,
    );
    const firstStored = container.querySelector("li");
    const renders = renderCounters.messageRenders;
    const mounts = renderCounters.messageMounts;
    for (let i = 0; i < 200; i++)
      act(() => {
        append(i % 20 === 0 ? `\n\n$y_${String(i)}$ para ` : `tok${String(i)} `);
      });
    expect(renderCounters.messageRenders).toBe(renders);
    expect(renderCounters.messageMounts).toBe(mounts);
    expect(container.querySelector("li")).toBe(firstStored);
    expect(container.querySelectorAll("math").length).toBeGreaterThan(100);
  });
});
