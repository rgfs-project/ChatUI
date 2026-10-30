// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { htmlToMarkdown, RICH_PASTE_MAX_HTML } from "../../app/chat/html-to-markdown";
import { setSession } from "../../app/lib/api";
import { qk } from "../../app/lib/query/keys";
import {
  chatApp,
  CONV,
  conversation,
  FakeEventSource,
  MODELS,
  seededClient,
  USER,
} from "./harness";

const accepted = {
  conversationId: CONV,
  generationId: "9e9e9e9e-0000-4000-8000-000000000002",
  userMessageId: "11111111-0000-4000-8000-000000000003",
  assistantMessageId: "11111111-0000-4000-8000-000000000004",
};
let posts: Record<string, unknown>[];

beforeEach(() => {
  posts = [];
  setSession({ user: USER, csrfToken: "tok", registrationOpen: false });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit = {}) => {
      if (url === "/api/generations" && init.method === "POST") {
        posts.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return Promise.resolve(new Response(JSON.stringify(accepted), { status: 202 }));
      }
      if (url.startsWith("/api/conversations/"))
        return Promise.resolve(new Response(JSON.stringify(conversation()), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ conversations: [] }), { status: 200 }));
    }),
  );
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function composer(options: { reasoning?: boolean } = {}) {
  const client = seededClient();
  if (options.reasoning) {
    client.setQueryData(
      qk.models(USER.id),
      MODELS.map((group) => ({
        ...group,
        models: group.models.map((m) => ({
          ...m,
          capabilities: { ...m.capabilities, reasoning: true },
        })),
      })),
    );
  }
  const App = chatApp(client);
  render(<App at="/chat/new" />);
  return screen.findByRole<HTMLTextAreaElement>("textbox", { name: "Message" });
}

async function sendText(box: HTMLTextAreaElement, text: string) {
  fireEvent.input(box, { target: { value: text } });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.keyDown(box, { key: "Enter" });
  await vi.waitFor(() => {
    expect(posts.length).toBeGreaterThan(0);
  });
}

function paste(box: HTMLTextAreaElement, data: Record<string, string>) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: {
      files: [],
      getData: (type: string) => data[type] ?? "",
    },
  });
  box.dispatchEvent(event);
  return event;
}

describe("rich paste: HTML to Markdown", () => {
  it("keeps headings, emphasis, links, lists, quotes, code and tables", () => {
    const md = htmlToMarkdown(
      [
        "<h2>Plan</h2>",
        "<p>Run <strong>fast</strong> and <em>far</em>, see <a href='https://example.com/a(b)'>notes</a>.</p>",
        "<ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>",
        "<ol start='3'><li>Three</li><li>Four</li></ol>",
        "<blockquote><p>Quoted</p></blockquote>",
        "<pre><code>const x = 1;\nx++;</code></pre>",
        "<p>Use <code>npm i</code></p>",
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table>",
      ].join(""),
    );
    expect(md).toBe(
      [
        "## Plan",
        "Run **fast** and *far*, see [notes](https://example.com/a%28b%29).",
        "- One\n- Two\n  - Nested",
        "3. Three\n4. Four",
        "> Quoted",
        "```\nconst x = 1;\nx++;\n```",
        "Use `npm i`",
        "| A | B |\n| --- | --- |\n| 1 | 2\\|3 |",
      ].join("\n\n"),
    );
  });

  it("drops scripts, styles, unsafe links and markup; escapes Markdown in text", () => {
    const md = htmlToMarkdown(
      "<style>p{}</style><script>alert(1)</script><p><b>Hi</b> <a href='javascript:alert(2)'>click</a> *not bold* <img src=x onerror=alert(3) alt='pic'></p><iframe src='https://evil'></iframe>",
    );
    expect(md).toBe("**Hi** click \\*not bold\\* pic");
  });

  it("reads Google Docs styling and leaves plain or code-editor HTML to the plain paste", () => {
    expect(
      htmlToMarkdown(
        '<b style="font-weight:normal" id="docs-internal-guid-1"><p><span style="font-weight:700">Bold</span> <span style="font-style:italic">it</span></p></b>',
      ),
    ).toBe("**Bold** *it*");
    expect(htmlToMarkdown("<p>Just words</p>")).toBeNull();
    expect(
      htmlToMarkdown(
        '<div style="white-space: pre;"><div><span style="color:#f00">const</span> <b>x</b></div></div>',
      ),
    ).toBeNull();
    expect(htmlToMarkdown(`<b>${"x".repeat(RICH_PASTE_MAX_HTML)}</b>`)).toBeNull();
    expect(htmlToMarkdown("")).toBeNull();
  });

  it("the composer inserts the Markdown at the caret; plain text pastes natively", async () => {
    const box = await composer();
    fireEvent.input(box, { target: { value: "Before  after" } });
    box.setSelectionRange(7, 7);
    const rich = paste(box, { "text/html": "<b>bold</b>", "text/plain": "bold" });
    expect(rich.defaultPrevented).toBe(true);
    expect(box.value).toBe("Before **bold** after");
    const plain = paste(box, { "text/plain": "plain" });
    expect(plain.defaultPrevented).toBe(false);
  });
});

describe("Think toggle", () => {
  it("is shown only for a reasoning model", async () => {
    await composer();
    expect(screen.queryByTestId("think-toggle")).toBeNull();
  });

  it("is a pressed toggle, on by default; each send carries the choice", async () => {
    const box = await composer({ reasoning: true });
    const toggle = screen.getByRole("button", { name: "Think" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await sendText(box, "quick one");
    expect(posts[0]).toMatchObject({ content: "quick one", think: false });
  });

  it("a model without reasoning sends no think field", async () => {
    const box = await composer();
    await sendText(box, "hello");
    expect(posts[0]).not.toHaveProperty("think");
  });
});

describe("dictation", () => {
  it("is offered only where the browser has speech recognition, and types what it hears", async () => {
    await composer();
    expect(screen.queryByTestId("dictate")).toBeNull();
    cleanup();

    const instances: FakeRecognition[] = [];
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = true;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      started = false;
      constructor() {
        instances.push(this);
      }
      start() {
        this.started = true;
      }
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const box = await composer();
    fireEvent.input(box, { target: { value: "Hello" } });
    box.setSelectionRange(5, 5);
    const mic = screen.getByRole("button", { name: "Dictate" });
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(mic);
    const recognition = instances[0];
    expect(recognition?.started).toBe(true);
    expect(recognition?.interimResults).toBe(false);
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    // The first use says where the audio may go.
    expect(screen.getByText(/may send audio to its vendor/)).toBeTruthy();
    act(() => {
      recognition?.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: "world " } }],
      });
    });
    expect(box.value).toBe("Hello world");
    fireEvent.click(mic);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    // A refused microphone is explained.
    fireEvent.click(mic);
    act(() => {
      instances[1]?.onerror?.({ error: "not-allowed" });
      instances[1]?.onend?.();
    });
    expect(screen.getByText("Dictation needs permission to use the microphone.")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });
});
