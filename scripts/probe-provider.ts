/**
 * Provider probe (Phase 2): records what a live llama-server actually does.
 * Gated on LLAMA_BASE_URL; LLAMA_API_KEY is optional and never printed.
 *
 *   LLAMA_BASE_URL=http://host:8080 LLAMA_API_KEY=... node scripts/probe-provider.ts [model]
 *
 * Only the named (or first loaded) model is exercised, so the probe never
 * forces a router-mode server to load or evict other models. Output is a JSON
 * report of shapes, counts and timings; it contains no credentials and only
 * short, truncated upstream messages.
 */
export {};

const baseUrl = process.env.LLAMA_BASE_URL?.replace(/\/+$/, "");
const apiKey = process.env.LLAMA_API_KEY;
if (!baseUrl) {
  process.stderr.write("LLAMA_BASE_URL is not set; nothing to probe.\n");
  process.exit(2);
}

type Json = Record<string, unknown>;
const report: Record<string, unknown> = { probedAt: new Date().toISOString() };

function headers(withKey = true): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (withKey && apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/** Recursively lists the keys (not values) of a JSON value. */
function shape(value: unknown, depth = 0): unknown {
  if (depth > 4) return typeof value;
  if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

/** The upstream `error.message` string, if any (truncated; for the report only). */
function upstreamMessage(json: unknown, fallback = ""): string {
  const error = (json as Json | undefined)?.error as Json | undefined;
  return typeof error?.message === "string" ? error.message : fallback;
}

const short = (text: string, n = 160) => (text.length > n ? `${text.slice(0, n)}…` : text);

async function request(
  path: string,
  init: RequestInit & { withKey?: boolean; timeoutMs?: number } = {},
): Promise<{ status: number; json?: unknown; text?: string; ms: number; error?: string }> {
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: headers(init.withKey ?? true),
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    try {
      return { status: res.status, json: JSON.parse(text) as unknown, ms };
    } catch {
      return { status: res.status, text: short(text), ms };
    }
  } catch (error) {
    return {
      status: 0,
      ms: Math.round(performance.now() - started),
      error: (error as Error).message,
    };
  }
}

async function streamChat(body: Json, timeoutMs = 180_000) {
  const started = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const result = {
    status: res.status,
    contentType: res.headers.get("content-type"),
    chunkShapes: [] as unknown[],
    finishReasons: [] as unknown[],
    sawDone: false,
    sawUsage: false,
    sawTimings: false,
    reasoningChars: 0,
    contentChars: 0,
    chunks: 0,
    ttftMs: undefined as number | undefined,
    totalMs: 0,
    lastTimings: undefined as unknown,
    lastUsage: undefined as unknown,
    errorBody: undefined as unknown,
    sampleContent: "",
  };
  if (!res.ok || !res.body) {
    const text = await res.text();
    try {
      result.errorBody = shape(JSON.parse(text));
      result.sampleContent = short(text, 300);
    } catch {
      result.sampleContent = short(text, 300);
    }
    return result;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const seen = new Set<string>();
  for await (const part of res.body) {
    buffer += decoder.decode(part, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        result.sawDone = true;
        continue;
      }
      const chunk = JSON.parse(data) as Json;
      result.chunks++;
      const key = JSON.stringify(shape(chunk));
      if (!seen.has(key)) {
        seen.add(key);
        result.chunkShapes.push(shape(chunk));
      }
      const choice = (chunk.choices as Json[] | undefined)?.[0];
      const delta = choice?.delta as Json | undefined;
      if (typeof delta?.content === "string" && delta.content) {
        result.ttftMs ??= Math.round(performance.now() - started);
        result.contentChars += delta.content.length;
        if (result.sampleContent.length < 200) result.sampleContent += delta.content;
      }
      if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
        result.ttftMs ??= Math.round(performance.now() - started);
        result.reasoningChars += delta.reasoning_content.length;
      }
      if (choice?.finish_reason) result.finishReasons.push(choice.finish_reason);
      if (chunk.usage) {
        result.sawUsage = true;
        result.lastUsage = chunk.usage;
      }
      if (chunk.timings) {
        result.sawTimings = true;
        result.lastTimings = chunk.timings;
      }
    }
  }
  result.totalMs = Math.round(performance.now() - started);
  return result;
}

// 1. Models and auth.
const models = await request("/v1/models");
report.models = {
  status: models.status,
  shape: shape(models.json),
  ids: ((models.json as Json | undefined)?.data as Json[] | undefined)?.map((m) => ({
    id: m.id,
    status: (m.status as Json | undefined)?.value,
    n_ctx: (m.meta as Json | undefined)?.n_ctx,
    input: (m.architecture as Json | undefined)?.input_modalities,
  })),
};
const noKey = await request("/v1/models", { withKey: false });
report.authWithoutKey = { status: noKey.status, body: noKey.json ? shape(noKey.json) : noKey.text };
const badKeyRes = await fetch(`${baseUrl}/v1/models`, {
  headers: { Authorization: "Bearer definitely-wrong" },
});
report.authWrongKey = { status: badKeyRes.status };
const healthNoKey = await request("/health", { withKey: false });
report.healthWithoutKey = { status: healthNoKey.status, body: healthNoKey.json };

const list = ((models.json as Json | undefined)?.data as Json[] | undefined) ?? [];
const loaded = list.find((m) => (m.status as Json | undefined)?.value === "loaded") ?? list[0];
const model = process.argv[2] ?? (loaded?.id as string | undefined);
report.probedModel = model;
if (!model) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(1);
}
const q = `?model=${encodeURIComponent(model)}`;

// 2. Props / context / slots (router mode may need ?model=).
for (const path of ["/props", `/props${q}`]) {
  const res = await request(path);
  const json = res.json as Json | undefined;
  const dgs = json?.default_generation_settings as Json | undefined;
  report[`props ${path}`] = {
    status: res.status,
    keys: json ? Object.keys(json) : res.text,
    total_slots: json?.total_slots,
    n_ctx: dgs?.n_ctx ?? (dgs?.params as Json | undefined)?.n_ctx,
    role: json?.role,
    modalities: json?.modalities,
    hasChatTemplate: typeof json?.chat_template === "string",
    error: res.error,
  };
}
for (const path of ["/slots", `/slots${q}`]) {
  const res = await request(path);
  report[`slots ${path}`] = {
    status: res.status,
    count: Array.isArray(res.json) ? res.json.length : undefined,
    n_ctx: Array.isArray(res.json) ? (res.json as Json[]).map((s) => s.n_ctx) : undefined,
    shape: Array.isArray(res.json) ? undefined : shape(res.json ?? res.text),
  };
}

// 3. Tokenize and chat-template application.
const samples = {
  english: "The quick brown fox jumps over the lazy dog.",
  multilingual: "Grüße aus München — こんにちは世界 — Привет мир — مرحبا بالعالم",
  emoji: "👋🏽 🎉🚀 👨‍👩‍👧‍👦 🇩🇪",
  code: "function add(a: number, b: number): number {\n  return a + b; // sum\n}",
};
const tokenCounts: Record<string, unknown> = {};
for (const [name, content] of Object.entries(samples)) {
  const res = await request(`/tokenize${q}`, {
    method: "POST",
    body: JSON.stringify({ content, model }),
  });
  const tokens = (res.json as Json | undefined)?.tokens;
  tokenCounts[name] = {
    status: res.status,
    tokens: Array.isArray(tokens) ? tokens.length : undefined,
    utf8Bytes: Buffer.byteLength(content),
    tokensLeBytes: Array.isArray(tokens) ? tokens.length <= Buffer.byteLength(content) : undefined,
  };
}
report.tokenize = tokenCounts;
const messages = [
  { role: "system", content: "You are concise." },
  { role: "user", content: samples.multilingual },
];
const applied = await request(`/apply-template${q}`, {
  method: "POST",
  body: JSON.stringify({ messages, model }),
});
const prompt = (applied.json as Json | undefined)?.prompt;
report.applyTemplate = {
  status: applied.status,
  shape: shape(applied.json ?? applied.text),
  promptChars: typeof prompt === "string" ? prompt.length : undefined,
};
if (typeof prompt === "string") {
  const t = await request(`/tokenize${q}`, {
    method: "POST",
    body: JSON.stringify({ content: prompt, add_special: true, parse_special: true, model }),
  });
  const tokens = (t.json as Json | undefined)?.tokens;
  report.formattedPromptTokens = Array.isArray(tokens) ? tokens.length : { status: t.status };
}

// 4. Streaming shape, reasoning, finish reasons, usage/timings.
const base = {
  model,
  messages: [
    { role: "system", content: "You are a probe. Answer in at most ten words." },
    { role: "user", content: "Name one primary colour." },
  ],
  max_tokens: 256,
  stream_options: { include_usage: true },
};
report.stream = await streamChat(base);
report.streamLengthLimited = await streamChat({ ...base, max_tokens: 4 });

// 5. Prompt-cache reuse: same long prefix twice.
const longPrefix = `Reference notes:\n${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(120)}`;
const reuse = (question: string) => ({
  model,
  messages: [
    { role: "system", content: longPrefix },
    { role: "user", content: question },
  ],
  max_tokens: 8,
  stream_options: { include_usage: true },
});
const first = await streamChat(reuse("Reply with the single word: one."));
const second = await streamChat(reuse("Reply with the single word: two."));
report.promptCache = {
  first: { ttftMs: first.ttftMs, timings: first.lastTimings, usage: first.lastUsage },
  second: { ttftMs: second.ttftMs, timings: second.lastTimings, usage: second.lastUsage },
};

// 6. Errors: unknown model, oversized prompt.
const unknown = await request("/v1/chat/completions", {
  method: "POST",
  body: JSON.stringify({
    model: "probe-no-such-model",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
  }),
});
report.unknownModel = {
  status: unknown.status,
  shape: shape(unknown.json ?? unknown.text),
  message: short(upstreamMessage(unknown.json, unknown.text ?? "")),
  type: ((unknown.json as Json | undefined)?.error as Json | undefined)?.type,
};
const nCtx = Number(
  (report[`props /props${q}`] as Json).n_ctx ??
    (report.models as { ids?: { id: unknown; n_ctx: unknown }[] }).ids?.find((m) => m.id === model)
      ?.n_ctx ??
    0,
);
if (nCtx > 0) {
  const huge = "word ".repeat(Math.ceil(nCtx * 1.3));
  const overflow = await request("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model, messages: [{ role: "user", content: huge }], max_tokens: 1 }),
    timeoutMs: 60_000,
  });
  report.oversizedPrompt = {
    nCtx,
    promptChars: huge.length,
    status: overflow.status,
    ms: overflow.ms,
    error: overflow.error,
    shape: shape(overflow.json ?? overflow.text),
    type: ((overflow.json as Json | undefined)?.error as Json | undefined)?.type,
    message: short(upstreamMessage(overflow.json)),
  };
} else {
  report.oversizedPrompt = "UNVERIFIED: context length not discovered";
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
