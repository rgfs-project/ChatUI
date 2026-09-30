/**
 * Deterministic in-process llama-server double speaking the format observed by
 * scripts/probe-provider.ts (docs/provider-notes.md). The model id selects the
 * scenario. Used by Vitest and by scripts/verify.ts, so it has no path aliases.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_MODELS = {
  chat: "mock-chat",
  slow: "mock-slow",
  hang: "mock-hang",
  noResponse: "mock-no-response",
  error500: "mock-500",
  invalid: "mock-invalid",
  overflow: "mock-overflow",
  huge: "mock-huge",
  earlyEnd: "mock-early-end",
  flood: "mock-flood",
  length: "mock-length",
  long: "mock-long",
  /** Streams `richAnswer()`: math, code and Markdown (Phase 14 rendering). */
  rich: "mock-rich",
  /** Reports image and audio input (Phase 12) and describes the parts it received. */
  vision: "mock-vision",
  /**
   * Proposal tools (Phase 13b), driven by markers in the last user message:
   * `[[create Name|text]]`, `[[update Name|text]]`, `[[forget Name]]`,
   * `[[bad]]` (malformed arguments), `[[unknown]]` (a tool not offered),
   * `[[huge]]` (oversized arguments), `[[big N]]` (a create with N bytes of
   * content that is not in the prompt), `[[many N]]` (N create calls),
   * `[[calls-only]]` (no text before the calls), `[[exhaust]]` (reports all
   * output tokens used), `[[reject-continuation]]` (400 on tool results),
   * `[[hang-continuation]]` (the continuation stalls), `[[fail-continuation]]`
   * (the continuation stream breaks). A request with `role: "tool"` messages
   * is the continuation.
   */
  tools: "mock-tools",
} as const;

interface ToolMarker {
  kind: string;
  name: string;
  text: string;
}

export function toolMarkers(text: string): ToolMarker[] {
  return [...text.matchAll(/\[\[([a-z-]+)(?: ([^\]|]*))?(?:\|([^\]]*))?\]\]/g)].map((m) => ({
    kind: m[1] ?? "",
    name: (m[2] ?? "").trim(),
    text: m[3] ?? "",
  }));
}

/** Text of a message without the markers. */
function withoutMarkers(text: string): string {
  return text.replace(/\[\[[^\]]*\]\]/g, "").trim();
}

/** A long Markdown answer (fences, tables, nested lists) for UI streaming tests. */
export function longAnswer(): string {
  const sections: string[] = [];
  for (let s = 1; s <= 8; s++) {
    sections.push(
      `## Section ${String(s)}`,
      "",
      `Paragraph ${String(s)} explains *one* idea with **emphasis** and \`inline code\`. `.repeat(
        3,
      ),
      "",
      "```ts",
      ...Array.from(
        { length: 8 },
        (_, i) => `const value${String(s)}_${String(i)} = ${String(i)};`,
      ),
      "```",
      "",
      "| key | value |",
      "| --- | ----- |",
      ...Array.from({ length: 4 }, (_, i) => `| k${String(i)} | v${String(i)} |`),
      "",
      "- item one",
      "  - nested item",
      "    1. deep item",
      "- item two",
      "",
    );
  }
  sections.push("LONG-ANSWER-END");
  return sections.join("\n");
}

/**
 * An answer with inline and display math, fenced and unknown-language code,
 * dollar amounts and a table (Phase 14 rendering tests). Paragraphs first, so
 * a test can select text in finished blocks while the rest streams.
 */
export function richAnswer(): string {
  const sections: string[] = [
    "RICH-FIRST paragraph: the mass-energy relation is $E = mc^2$ and it costs $5 and $10 to print.",
    "",
    "A second paragraph with \\(a^2 + b^2 = c^2\\) inline.",
    "",
    "$$",
    "\\int_0^1 x^2 \\, dx = \\frac{1}{3}",
    "$$",
    "",
    "```python",
    "def square(x):",
    '    return x * x  # "quoted"',
    "```",
    "",
    "```unknownlang",
    "plain <b>text</b> here",
    "```",
    "",
    "| symbol | meaning |",
    "| --- | --- |",
    "| $\\pi$ | ratio |",
    "",
  ];
  for (let i = 0; i < 12; i++)
    sections.push(
      `Paragraph ${String(i)} continues with $x_{${String(i)}}^2$ and **bold** words to add length to the reply.`,
      "",
    );
  sections.push("RICH-ANSWER-END");
  return sections.join("\n");
}

/** Upstream error text that must never reach a ChatUI client (INV-04). */
export const UPSTREAM_SECRET = "UPSTREAM-SECRET-DETAIL-7f3a";

export interface MockLlamaOptions {
  /** Simulate a server without /tokenize (forces the byte estimate). */
  noTokenize?: boolean;
  /** Interface to listen on (default 127.0.0.1); verify:compose uses 0.0.0.0. */
  host?: string;
  apiKey?: string;
  /** Reported as /props total_slots; omit to mimic router mode (none reported). */
  slots?: number;
  /** Delay between chunks for mock-slow. */
  chunkDelayMs?: number;
  /** Number of content chunks for mock-slow. */
  slowChunks?: number;
  /** Bytes per chunk and chunk count for mock-flood. */
  floodChunkBytes?: number;
  floodChunks?: number;
  /** Delay between chunks for mock-chat (the browser demo streams visibly). */
  chatChunkDelayMs?: number;
  /** Delay between chunks for mock-long (default 10 ms, ~40 chars per chunk). */
  longChunkDelayMs?: number;
  /** Delay between chunks for mock-rich (default 80 ms, 24 chars per chunk: ~6 s). */
  richChunkDelayMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

export interface MockLlama {
  url: string;
  requests: RecordedRequest[];
  /** Number of chat streams whose client connection is still open. */
  openStreams: () => number;
  close: () => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return {
    choices: [{ finish_reason: finish, index: 0, delta }],
    created: 1_790_000_000,
    id: "chatcmpl-mock",
    model,
    system_fingerprint: "b0000-mock",
    object: "chat.completion.chunk",
  };
}

function usageChunk(model: string, completionTokens = 5) {
  return {
    choices: [],
    created: 1_790_000_000,
    id: "chatcmpl-mock",
    model,
    system_fingerprint: "b0000-mock",
    object: "chat.completion.chunk",
    usage: {
      completion_tokens: completionTokens,
      prompt_tokens: 12,
      total_tokens: 17,
      prompt_tokens_details: { cached_tokens: 3 },
    },
    timings: { cache_n: 3, prompt_n: 9, prompt_ms: 10, predicted_n: 5, predicted_ms: 20 },
  };
}

type MockContent = string | { type: string; text?: string }[];

function textOf(content: MockContent | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n\n");
}

function lastUser(body: unknown): { role: string; content: MockContent } | undefined {
  const messages =
    (body as { messages?: { role: string; content: MockContent }[] } | undefined)?.messages ?? [];
  return [...messages].reverse().find((m) => m.role === "user");
}

function lastUserText(body: unknown): string {
  return textOf(lastUser(body)?.content);
}

/** Media parts across the whole request, by OpenAI part type. */
export function mediaParts(body: unknown): { images: number; audio: number } {
  const messages = (body as { messages?: { content: MockContent }[] } | undefined)?.messages ?? [];
  let images = 0;
  let audio = 0;
  for (const m of messages)
    if (Array.isArray(m.content))
      for (const part of m.content) {
        if (part.type === "image_url") images++;
        if (part.type === "input_audio") audio++;
      }
  return { images, audio };
}

export async function startMockLlama(options: MockLlamaOptions = {}): Promise<MockLlama> {
  const requests: RecordedRequest[] = [];
  let open = 0;

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    let text = "";
    for await (const part of req) text += String(part);
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://mock");
      const body = await readBody(req);
      requests.push({
        method: req.method ?? "",
        path: url.pathname,
        authorization: req.headers.authorization,
        body,
      });

      if (url.pathname === "/health") {
        json(res, 200, { status: "ok" });
        return;
      }
      if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
        json(res, 401, {
          error: {
            message: `Invalid API Key ${UPSTREAM_SECRET}`,
            type: "authentication_error",
            code: 401,
          },
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        json(res, 200, {
          object: "list",
          data: Object.values(MOCK_MODELS).map((id, index) => ({
            id,
            object: "model",
            owned_by: "llamacpp",
            created: 1_790_000_000,
            status: {
              value: index === 0 ? "loaded" : "unloaded",
              args: ["/app/llama-server", "--model", `/secret/path/${id}.gguf`],
            },
            ...(index === 0 ? { meta: { n_ctx: 32_768, n_params: 123 } } : {}),
            ...(id === MOCK_MODELS.vision
              ? {
                  architecture: {
                    input_modalities: ["text", "image", "audio"],
                    output_modalities: ["text"],
                  },
                }
              : {}),
          })),
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/props") {
        json(
          res,
          200,
          options.slots === undefined
            ? { role: "router" }
            : { total_slots: options.slots, default_generation_settings: { n_ctx: 32_768 } },
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/tokenize") {
        if (options.noTokenize) {
          json(res, 404, { error: { message: "Not Found", type: "not_found_error", code: 404 } });
          return;
        }
        // Deterministic stand-in tokenizer: one token per 3 UTF-8 bytes (rounded up).
        const raw = (body as { content?: unknown } | undefined)?.content;
        const content = typeof raw === "string" ? raw : "";
        const count = Math.ceil(Buffer.byteLength(content) / 3);
        json(res, 200, { tokens: Array.from({ length: count }, (_, i) => i) });
        return;
      }
      if (req.method === "POST" && url.pathname === "/apply-template") {
        const messages =
          (body as { messages?: { role: string; content: string }[] } | undefined)?.messages ?? [];
        // Media parts never reach apply-template (ChatUI counts them by reserve).
        if (messages.some((m) => typeof m.content !== "string")) {
          json(res, 400, { error: { message: "non-text content", type: "invalid_request_error" } });
          return;
        }
        const prompt =
          messages.map((m) => `<|${m.role}|>\n${m.content}<|end|>\n`).join("") + "<|assistant|>\n";
        json(res, 200, { prompt });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await chat(req, res, body);
        return;
      }
      json(res, 404, { error: { message: "Not Found", type: "not_found_error", code: 404 } });
    })();
  });

  async function chat(req: IncomingMessage, res: ServerResponse, body: unknown) {
    const model = (body as { model?: string } | undefined)?.model ?? "";
    if (!Object.values(MOCK_MODELS).includes(model as never)) {
      json(res, 400, {
        error: {
          code: 400,
          message: `model '${model}' not found ${UPSTREAM_SECRET}`,
          type: "invalid_request_error",
        },
      });
      return;
    }
    if (model === MOCK_MODELS.error500) {
      json(res, 500, {
        error: { code: 500, message: `boom ${UPSTREAM_SECRET}`, type: "server_error" },
      });
      return;
    }
    if (model === MOCK_MODELS.overflow) {
      json(res, 400, {
        error: {
          code: 400,
          message: `request (999999 tokens) exceeds the available context size ${UPSTREAM_SECRET}`,
          type: "exceed_context_size_error",
          n_prompt_tokens: 999_999,
          n_ctx: 32_768,
        },
      });
      return;
    }
    if (model === MOCK_MODELS.noResponse) {
      open++;
      req.socket.once("close", () => open--);
      return; // never answers
    }

    const toolMessages = (
      (body as { messages?: { role: string }[] } | undefined)?.messages ?? []
    ).filter((m) => m.role === "tool");
    const markers = toolMarkers(lastUserText(body));
    if (
      model === MOCK_MODELS.tools &&
      toolMessages.length > 0 &&
      markers.some((m) => m.kind === "reject-continuation")
    ) {
      json(res, 400, {
        error: {
          code: 400,
          message: `tool role not supported ${UPSTREAM_SECRET}`,
          type: "invalid_request_error",
        },
      });
      return;
    }

    open++;
    const stream = { closed: false };
    res.once("close", () => {
      stream.closed = true;
      open--;
    });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (data: unknown) => {
      if (!stream.closed)
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    };
    const finish = (reason = "stop", completionTokens = 5) => {
      send(chunk(model, {}, reason));
      send(usageChunk(model, completionTokens));
      send("[DONE]");
      res.end();
    };

    send(chunk(model, { role: "assistant", content: null }));
    switch (model) {
      case MOCK_MODELS.chat: {
        const delay = options.chatChunkDelayMs ?? 0;
        for (const piece of ["Considering ", "the request."]) {
          send(chunk(model, { reasoning_content: piece }));
          if (delay) await sleep(delay);
        }
        const words = `Echo: ${lastUserText(body)}`.split(/(?<= )/);
        for (const word of words) {
          if (stream.closed) return;
          send(chunk(model, { content: word }));
          if (delay) await sleep(delay);
        }
        finish();
        return;
      }
      case MOCK_MODELS.vision: {
        const { images, audio } = mediaParts(body);
        send(
          chunk(model, {
            content: `Saw ${String(images)} image(s) and ${String(audio)} audio part(s). ${lastUserText(body)}`,
          }),
        );
        finish();
        return;
      }
      case MOCK_MODELS.tools: {
        if (toolMessages.length > 0) {
          if (markers.some((m) => m.kind === "hang-continuation")) {
            send(chunk(model, { content: "Partial continuation " }));
            return; // then silence
          }
          send(chunk(model, { reasoning_content: "Continuing." }));
          send(chunk(model, { content: `Continued after ${String(toolMessages.length)} ` }));
          if (markers.some((m) => m.kind === "fail-continuation")) {
            res.end();
            return;
          }
          send(chunk(model, { content: "result(s)." }));
          finish();
          return;
        }
        const calls: { name: string; arguments: string }[] = [];
        for (const marker of markers) {
          const args = (value: Record<string, string>) => JSON.stringify(value);
          if (marker.kind === "create" || marker.kind === "update")
            calls.push({
              name: `propose_memory_${marker.kind}`,
              arguments: args({ name: marker.name, content: marker.text }),
            });
          else if (marker.kind === "forget")
            calls.push({ name: "propose_memory_forget", arguments: args({ name: marker.name }) });
          else if (marker.kind === "bad")
            calls.push({ name: "propose_memory_create", arguments: '{"name": "Broken", ' });
          else if (marker.kind === "unknown")
            calls.push({ name: "delete_everything", arguments: "{}" });
          else if (marker.kind === "huge")
            calls.push({
              name: "propose_memory_create",
              arguments: args({ name: "Huge", content: "z".repeat(20_000) }),
            });
          else if (marker.kind === "big")
            calls.push({
              name: "propose_memory_create",
              arguments: args({ name: "Big", content: "b".repeat(Number(marker.name || "1000")) }),
            });
          else if (marker.kind === "many")
            for (let i = 0; i < Number(marker.name || "2"); i++)
              calls.push({
                name: "propose_memory_create",
                arguments: args({
                  name: `Note ${String(i + 1)}`,
                  content: `Fact ${String(i + 1)}.`,
                }),
              });
        }
        if (calls.length === 0) {
          send(chunk(model, { content: `Echo: ${lastUserText(body)}` }));
          finish();
          return;
        }
        send(chunk(model, { reasoning_content: "Thinking." }));
        if (!markers.some((m) => m.kind === "calls-only"))
          send(chunk(model, { content: `Noted: ${withoutMarkers(lastUserText(body))}` }));
        calls.forEach((call, index) => {
          const half = Math.floor(call.arguments.length / 2);
          send(
            chunk(model, {
              tool_calls: [
                {
                  index,
                  id: `call_${String(index)}`,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments.slice(0, half) },
                },
              ],
            }),
          );
          send(
            chunk(model, {
              tool_calls: [{ index, function: { arguments: call.arguments.slice(half) } }],
            }),
          );
        });
        finish("tool_calls", markers.some((m) => m.kind === "exhaust") ? 1_000_000 : 5);
        return;
      }
      case MOCK_MODELS.slow: {
        const count = options.slowChunks ?? 20;
        // A message with a fenced block is echoed first (artifact tests, Phase 13c).
        if (lastUserText(body).includes("```"))
          send(chunk(model, { content: `${lastUserText(body)}\n\n` }));
        for (let i = 0; i < count; i++) {
          if (stream.closed) return;
          send(chunk(model, { content: `part${String(i)} ` }));
          await sleep(options.chunkDelayMs ?? 50);
        }
        finish();
        return;
      }
      case MOCK_MODELS.long: {
        const text = longAnswer();
        for (let i = 0; i < text.length && !stream.closed; i += 40) {
          send(chunk(model, { content: text.slice(i, i + 40) }));
          await sleep(options.longChunkDelayMs ?? 10);
        }
        finish();
        return;
      }
      case MOCK_MODELS.rich: {
        const text = richAnswer();
        for (let i = 0; i < text.length && !stream.closed; i += 24) {
          send(chunk(model, { content: text.slice(i, i + 24) }));
          await sleep(options.richChunkDelayMs ?? 80);
        }
        finish();
        return;
      }
      case MOCK_MODELS.length:
        send(chunk(model, { content: "Truncated" }));
        finish("length");
        return;
      case MOCK_MODELS.hang:
        send(chunk(model, { content: "partial " }));
        return; // then silence
      case MOCK_MODELS.invalid:
        send(chunk(model, { content: "ok " }));
        send(`{not json ${UPSTREAM_SECRET}`);
        res.end();
        return;
      case MOCK_MODELS.earlyEnd:
        send(chunk(model, { content: "cut " }));
        if (lastUserText(body).includes("```"))
          send(chunk(model, { content: `\n${lastUserText(body)}` }));
        res.end();
        return;
      case MOCK_MODELS.huge: {
        const big = "x".repeat(64 * 1024);
        for (let i = 0; i < 64 && !stream.closed; i++) send(chunk(model, { content: big }));
        finish();
        return;
      }
      case MOCK_MODELS.flood: {
        const piece = "y".repeat(options.floodChunkBytes ?? 32 * 1024);
        for (let i = 0; i < (options.floodChunks ?? 200) && !stream.closed; i++) {
          send(chunk(model, { content: piece }));
          if (i % 20 === 0) await sleep(1);
        }
        finish();
        return;
      }
      default:
        finish();
    }
  }

  await new Promise<void>((resolve) => server.listen(0, options.host ?? "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    openStreams: () => open,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
