import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatUiApp } from "../../server/create-app.ts";
import { MOCK_MODELS, startMockLlama, type MockLlama } from "../support/mock-llama.ts";
import {
  localProvider,
  providerConfig,
  signIn,
  tempDataDir,
  testApp,
  writeProviders,
  type TestSession,
} from "./helpers.ts";

let llama: MockLlama;
beforeAll(async () => {
  llama = await startMockLlama({ slots: 4 });
});
afterAll(async () => {
  await llama.close();
});

const servers: { server: Server; chatui: ChatUiApp }[] = [];
afterEach(async () => {
  for (const { server, chatui } of servers.splice(0)) {
    await chatui.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

async function serve(reasoning: boolean) {
  const dataDir = tempDataDir();
  writeProviders(dataDir, [
    localProvider(llama.url, {
      capabilities: { inputModalities: ["text"], reasoning, tools: false },
    }),
  ]);
  const { chatui } = testApp({
    config: { dataDir, provider: providerConfig({ baseUrl: llama.url }) },
  });
  await chatui.ready;
  const server = createServer(chatui.handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ server, chatui });
  const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { base, user: await signIn(base, chatui, "alice") };
}

/** Sends one message and returns the provider request body it caused, and the stored reply. */
async function sendWith(base: string, who: TestSession, extra: Record<string, unknown>) {
  const before = llama.requests.length;
  const res = await fetch(`${base}/api/generations`, {
    method: "POST",
    headers: { ...who.headers(true), "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: "local",
      model: MOCK_MODELS.chat,
      content: "hello",
      operationKey: crypto.randomUUID(),
      operationIssuedAt: new Date().toISOString(),
      ...extra,
    }),
  });
  expect(res.status).toBe(202);
  const started = (await res.json()) as { conversationId: string; generationId: string };
  await (
    await fetch(`${base}/api/generations/${started.generationId}/stream`, {
      headers: who.headers(),
    })
  ).text();
  const body = llama.requests.slice(before).find((r) => r.path === "/v1/chat/completions")
    ?.body as Record<string, unknown>;
  const conversation = (await (
    await fetch(`${base}/api/conversations/${started.conversationId}`, { headers: who.headers() })
  ).json()) as { messages: { role: string; reasoning: string | null }[] };
  return { body, reply: conversation.messages.at(-1) };
}

describe("Think toggle (Phase 15)", () => {
  it("a reasoning model gets enable_thinking from the send; the reply follows it", async () => {
    const { base, user } = await serve(true);
    const off = await sendWith(base, user, { think: false });
    expect(off.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(off.reply?.reasoning).toBeNull();
    const on = await sendWith(base, user, { think: true });
    expect(on.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(on.reply?.reasoning).toBe("Considering the request.");
    // Without the field the model's default applies.
    const plain = await sendWith(base, user, {});
    expect(plain.body).not.toHaveProperty("chat_template_kwargs");
  });

  it("a model without reasoning never gets the field", async () => {
    const { base, user } = await serve(false);
    const sent = await sendWith(base, user, { think: false });
    expect(sent.body).not.toHaveProperty("chat_template_kwargs");
  });

  it("think must be a boolean", async () => {
    const { base, user } = await serve(true);
    const res = await fetch(`${base}/api/generations`, {
      method: "POST",
      headers: { ...user.headers(true), "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "local",
        model: MOCK_MODELS.chat,
        content: "hello",
        operationKey: crypto.randomUUID(),
        operationIssuedAt: new Date().toISOString(),
        think: "yes",
      }),
    });
    expect(res.status).toBe(400);
  });
});
