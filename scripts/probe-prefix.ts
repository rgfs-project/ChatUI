/**
 * Live prompt-prefix reuse probe (Phase 9). Runs a multi-turn conversation
 * against a real llama.cpp server the way ChatUI's prompt assembly does
 * (append-only history, no volatile values in the prefix) and records, per
 * turn, prompt tokens processed vs. reused from the cache and time to first
 * token. Credentials come from the environment only; nothing is written.
 *
 *   LLAMA_BASE_URL=http://host:8080 LLAMA_API_KEY=… LLAMA_MODEL="Gemma 4" \
 *     node scripts/probe-prefix.ts [turns=4]
 */
export {};

const baseUrl = (process.env.LLAMA_BASE_URL ?? "").replace(/\/$/, "");
const apiKey = process.env.LLAMA_API_KEY;
const model = process.env.LLAMA_MODEL;
const turns = Number(process.argv[2] ?? 4);
if (!baseUrl || !model) {
  process.stderr.write("set LLAMA_BASE_URL and LLAMA_MODEL (and LLAMA_API_KEY if required)\n");
  process.exit(2);
}

interface Turn {
  turn: number;
  promptTokens: number;
  processed: number;
  cached: number;
  ttftMs: number;
  totalMs: number;
}

const messages: { role: "user" | "assistant"; content: string }[] = [];
const results: Turn[] = [];
const background =
  "Background notes for this conversation: " +
  Array.from(
    { length: 60 },
    (_, i) => `fact ${String(i)} is that item ${String(i)} weighs ${String(i * 3)} grams.`,
  ).join(" ");

for (let turn = 0; turn < turns; turn++) {
  messages.push({
    role: "user",
    content:
      turn === 0
        ? `${background}\nQuestion 1: what does item 7 weigh? Answer in one short sentence.`
        : `Question ${String(turn + 1)}: what does item ${String(turn * 11)} weigh? One short sentence.`,
  });
  const started = performance.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 48,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${String(res.status)}`);
  let ttft = NaN;
  let answer = "";
  let usage: { prompt_tokens?: number } = {};
  let timings: { prompt_n?: number; cache_n?: number } = {};
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const data = JSON.parse(line.slice(6)) as {
        choices?: { delta?: { content?: string; reasoning_content?: string } }[];
        usage?: typeof usage;
        timings?: typeof timings;
      };
      const delta = data.choices?.[0]?.delta;
      if (Number.isNaN(ttft) && (delta?.content || delta?.reasoning_content))
        ttft = performance.now() - started;
      answer += delta?.content ?? "";
      if (data.usage) usage = data.usage;
      if (data.timings) timings = data.timings;
    }
  }
  messages.push({ role: "assistant", content: answer });
  results.push({
    turn: turn + 1,
    promptTokens: usage.prompt_tokens ?? NaN,
    processed: timings.prompt_n ?? NaN,
    cached: timings.cache_n ?? NaN,
    ttftMs: Math.round(ttft),
    totalMs: Math.round(performance.now() - started),
  });
  process.stderr.write(`turn ${String(turn + 1)} done\n`);
}
process.stdout.write(`${JSON.stringify({ model, results }, null, 2)}\n`);
