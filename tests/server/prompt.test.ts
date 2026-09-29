import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anchorsFor,
  assemblePrompt,
  ContextTooLargeError,
  estimateCounter,
  historyGroups,
  normalizeRoles,
  type PromptMessage,
  type TokenCounter,
} from "../../server/chat/prompt.ts";
import { ProviderTokenCounter } from "../../server/chat/token-counter.ts";
import { createLlamaCppProvider } from "../../server/providers/llamacpp.ts";
import type { Block, ConversationModel } from "../../server/storage/markdown.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";

const T = "2026-01-01T00:00:00.000Z";
const id = () => randomUUID();
const model = (blocks: Block[]): ConversationModel => ({
  title: "t",
  createdAt: T,
  updatedAt: T,
  blocks,
});
const user = (body: string): Block => ({ type: "user", id: id(), body });
const assistant = (body: string, status: "complete" | "failed" = "complete"): Block => ({
  type: "assistant",
  id: id(),
  status,
  body,
});

/** Counts one token per character, no overhead: easy arithmetic for window tests. */
const charCounter: TokenCounter = {
  exact: false,
  countGroup: (messages) => Promise.resolve(messages.reduce((n, m) => n + m.content.length, 0)),
  countPrompt: (messages) => Promise.resolve(messages.reduce((n, m) => n + m.content.length, 0)),
};

describe("prompt assembly from canonical storage (contracts §4)", () => {
  it("sends system blocks first, never reasoning, and skips empty assistant bodies", () => {
    const a = id();
    const groups = historyGroups(
      model([
        { type: "system", id: id(), body: "sys1" },
        user("q1"),
        { type: "reasoning", id: a, body: "secret thoughts" },
        { type: "assistant", id: a, status: "complete", body: "a1" },
        { type: "system", id: id(), body: "sys2" },
        user("q2"),
        assistant("", "failed"),
        user("q3"),
      ]),
    );
    expect(groups.system.map((m) => m.content)).toEqual(["sys1", "sys2"]);
    expect(JSON.stringify(groups)).not.toContain("secret thoughts");
    expect(groups.groups).toEqual([
      [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ],
      [{ role: "user", content: "q2" }],
      [{ role: "user", content: "q3" }],
    ]);
  });

  it("merges consecutive user turns after a failed reply (provider prompt only)", async () => {
    const prompt = await assemblePrompt(
      model([user("first"), assistant("", "failed"), user("second")]),
      {
        budget: 1_000,
        trimStep: 100,
        counter: charCounter,
      },
    );
    expect(prompt.messages).toEqual([{ role: "user", content: "first\n\nsecond" }]);
  });

  it("drops leading assistant history that has no user turn", () => {
    expect(historyGroups(model([assistant("imported"), user("q")])).groups).toEqual([
      [{ role: "user", content: "q" }],
    ]);
  });

  it("merges adjacent same-role messages with two newlines, preserving order", () => {
    const merged = normalizeRoles([
      { role: "system", content: "a" },
      { role: "system", content: "b" },
      { role: "user", content: "c" },
    ] satisfies PromptMessage[]);
    expect(merged).toEqual([
      { role: "system", content: "a\n\nb" },
      { role: "user", content: "c" },
    ]);
  });

  it("CONTEXT_TOO_LARGE when system + newest user message alone exceed the budget", async () => {
    await expect(
      assemblePrompt(
        model([{ type: "system", id: id(), body: "x".repeat(60) }, user("y".repeat(50))]),
        {
          budget: 100,
          trimStep: 25,
          counter: charCounter,
        },
      ),
    ).rejects.toBeInstanceOf(ContextTooLargeError);
  });

  it("never drops the newest user message and never splits a group", async () => {
    const blocks: Block[] = [];
    for (let i = 0; i < 10; i++)
      blocks.push(
        user(`u${String(i)}`.padEnd(20, ".")),
        assistant(`a${String(i)}`.padEnd(20, ".")),
      );
    blocks.push(user("newest"));
    const prompt = await assemblePrompt(model(blocks), {
      budget: 130,
      trimStep: 40,
      counter: charCounter,
    });
    expect(prompt.messages.at(-1)).toEqual({ role: "user", content: "newest" });
    expect(prompt.messages[0]?.role).toBe("user");
    expect(prompt.promptTokens).toBeLessThanOrEqual(130);
  });

  it("anchored truncation keeps the window start (and prompt prefix) fixed until history grows by ~K", async () => {
    const budget = 200;
    const K = 50;
    const blocks: Block[] = [];
    const starts: number[] = [];
    const prefixes: string[] = [];
    for (let turn = 0; turn < 30; turn++) {
      blocks.push(user(`question ${String(turn)} `.padEnd(10, "?")));
      const prompt = await assemblePrompt(model(blocks), {
        budget,
        trimStep: K,
        counter: charCounter,
      });
      starts.push(prompt.windowStart);
      prefixes.push(JSON.stringify(prompt.messages[0]));
      blocks.push(assistant(`answer ${String(turn)} `.padEnd(10, "!")));
    }
    const moves = starts.filter((start, i) => i > 0 && start !== starts[i - 1]).length;
    // Each group is 20 tokens and K = 50, so the start moves every ~2.5 turns once
    // truncation begins, not on every turn.
    const truncatedTurns = starts.filter((s) => s > 0).length;
    expect(truncatedTurns).toBeGreaterThan(10);
    expect(moves).toBeLessThan(truncatedTurns / 2);
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] === starts[i - 1]) expect(prefixes[i]).toBe(prefixes[i - 1]);
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1] ?? 0);
    }
  });

  it("anchors are the boundaries where cumulative history first reaches each multiple of K", () => {
    expect(anchorsFor([10, 10, 10, 10, 10, 10], 25)).toEqual([3, 5]);
    expect(anchorsFor([60, 1, 1], 25)).toEqual([1]);
  });

  it("re-checks the formatted prompt and moves the window when the template adds tokens", async () => {
    const templated: TokenCounter = {
      exact: true,
      countGroup: (messages) => charCounter.countGroup(messages),
      // Template adds 10 tokens per message that group arithmetic did not predict.
      countPrompt: (messages) =>
        Promise.resolve(messages.reduce((n, m) => n + m.content.length + 10, 0)),
    };
    const blocks = [user("a".repeat(30)), assistant("b".repeat(30)), user("c".repeat(30))];
    const prompt = await assemblePrompt(model(blocks), {
      budget: 95,
      trimStep: 1_000,
      counter: templated,
    });
    expect(prompt.windowStart).toBe(1);
    expect(prompt.promptTokens).toBeLessThanOrEqual(95);
  });
});

describe("context budget counting", () => {
  let llama: MockLlama;
  beforeAll(async () => {
    llama = await startMockLlama();
  });
  afterAll(async () => {
    await llama.close();
  });

  // Real token counts observed live by the Phase 2 probe (docs/provider-notes.md).
  const observed = [
    { text: "The quick brown fox jumps over the lazy dog.", tokens: 10 },
    { text: "Grüße aus München — こんにちは世界 — Привет мир — مرحبا بالعالم", tokens: 16 },
    { text: "👋🏽 🎉🚀 👨‍👩‍👧‍👦 🇩🇪", tokens: 15 },
    { text: "function add(a: number, b: number): number {\n  return a + b; // sum\n}", tokens: 24 },
  ];

  it("the byte-based fallback never under-counts the probe's real token counts", async () => {
    const estimate = estimateCounter(0);
    for (const sample of observed) {
      expect(
        await estimate.countGroup([{ role: "user", content: sample.text }]),
      ).toBeGreaterThanOrEqual(sample.tokens);
    }
  });

  it("the fallback adds template overhead per message", async () => {
    const estimate = estimateCounter(16);
    expect(
      await estimate.countPrompt([
        { role: "user", content: "abc" },
        { role: "assistant", content: "de" },
      ]),
    ).toBe(3 + 2 + 32);
  });

  it("exact counting goes through the model's chat template and tokenizer", async () => {
    const provider = createLlamaCppProvider({
      baseUrl: llama.url,
      apiKey: undefined,
      timeoutMs: 5_000,
      maxResponseBytes: 1024 * 1024,
    });
    const counter = new ProviderTokenCounter(provider, MOCK_MODELS.chat, 4);
    for (const sample of observed) {
      const messages: PromptMessage[] = [{ role: "user", content: sample.text }];
      const formatted = await counter.countPrompt(messages);
      const templated = `<|user|>\n${sample.text}<|end|>\n<|assistant|>\n`;
      expect(formatted).toBe(Math.ceil(Buffer.byteLength(templated) / 3));
      expect(await counter.countGroup(messages)).toBe(
        Math.ceil(Buffer.byteLength(sample.text) / 3) + 4,
      );
    }
    const apply = llama.requests.filter((r) => r.path === "/apply-template");
    expect(apply.length).toBe(observed.length);
  });
});
