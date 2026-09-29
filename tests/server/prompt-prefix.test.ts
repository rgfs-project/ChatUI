import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import { providerConfig, signIn, testApp, type TestSession } from "./helpers.ts";

/**
 * Prompt-prefix stability (Phase 9, contracts §4 item 6): measured on the
 * *formatted* prompt (the model's chat template applied, as llama.cpp's
 * prompt cache compares it). Unless the window start moves to a new anchor,
 * each prompt must extend the previous prompt minus its trailing generation
 * prompt, so only the last reply and the new message are reprocessed.
 */

let llama: MockLlama;
let server: Server;
let chatui: ChatUiApp;
let base: string;
let session: TestSession;

beforeAll(async () => {
  llama = await startMockLlama();
  ({ chatui } = testApp({ config: { provider: providerConfig({ baseUrl: llama.url }) } }));
  await chatui.ready;
  server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  session = await signIn(base, chatui);
});

afterAll(async () => {
  await chatui.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await llama.close();
});

/** The mock's chat template (see tests/support/mock-llama.ts /apply-template). */
function formatted(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `<|${m.role}|>\n${m.content}<|end|>\n`).join("") + "<|assistant|>\n";
}
const GENERATION_PROMPT = "<|assistant|>\n";

async function send(conversationId: string | undefined, content: string): Promise<string> {
  const res = await fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { ...session.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(conversationId ? { conversationId } : {}),
      providerId: "local",
      model: MOCK_MODELS.chat,
      content,
      operationKey: randomUUID(),
      operationIssuedAt: new Date().toISOString(),
    }),
  });
  const body = (await res.json()) as { conversationId: string; generationId: string };
  expect(res.status).toBe(202);
  await vi.waitFor(
    async () => {
      const g = (await (
        await fetch(`${base}/api/generations/${body.generationId}`, { headers: session.headers() })
      ).json()) as { state: string };
      expect(g.state).toBe("completed");
    },
    { timeout: 10_000, interval: 20 },
  );
  return body.conversationId;
}

function prompts(): string[] {
  return llama.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => formatted((r.body as { messages: { role: string; content: string }[] }).messages));
}

describe("prompt-prefix stability across turns (formatted prompt)", () => {
  it("each turn reuses the previous formatted prompt as its prefix, except at rare anchored window moves", async () => {
    const before = prompts().length;
    let conversationId: string | undefined;
    // ~1k mock tokens per message (~2k per exchange with the echoed reply), so
    // the 32k context truncates after ~16 turns and each anchor step (K = 25%
    // of the budget, ~8k tokens) spans ~4 turns.
    const turns = 32;
    for (let turn = 0; turn < turns; turn++)
      conversationId = await send(
        conversationId,
        `turn ${String(turn)} ${"lorem ipsum dolor ".repeat(170)}`,
      );
    const sent = prompts().slice(before);
    expect(sent).toHaveLength(turns);
    let reused = 0;
    let moved = 0;
    for (let i = 1; i < sent.length; i++) {
      const previous = (sent[i - 1] ?? "").slice(0, -GENERATION_PROMPT.length);
      if ((sent[i] ?? "").startsWith(previous)) reused++;
      else moved++;
    }
    // Truncation did happen (otherwise this proves nothing about anchors)…
    expect(sent.at(-1)?.startsWith(sent[0]?.slice(0, 200) ?? "")).toBe(false);
    // …and the window start moved on only a minority of turns.
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan((turns - 1) / 4);
    expect(reused + moved).toBe(turns - 1);
    // 32 real sends through the app: allow for slower CI runners.
  }, 60_000);
});
