import { describe, expect, it } from "vitest";
import type { GenerationEvent } from "@shared/generations";
import { ModelCatalog } from "../../server/generations/catalog.ts";
import { GenerationManager } from "../../server/generations/manager.ts";
import type { Provider, ProviderEvent } from "../../server/providers/types.ts";
import { captureLogger } from "./helpers.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A provider whose single stream finishes exactly when the test releases it. */
function gatedProvider() {
  const gate = deferred();
  const provider: Provider = {
    listModels: () => Promise.resolve([{ id: "m", contextTokens: 100, status: "loaded" }]),
    discoverSlots: () => Promise.resolve(undefined),
    async *streamChat(): AsyncGenerator<ProviderEvent> {
      yield { type: "start" };
      yield { type: "content", text: "hi" };
      await gate.promise;
      yield { type: "finish", reason: "stop" };
    },
  };
  return { provider, gate };
}

function manager(provider: Provider) {
  return new GenerationManager({
    provider,
    catalog: new ModelCatalog(provider, 100),
    logger: captureLogger().logger,
    maxOutputTokens: 10,
    generationMaxMs: 10_000,
    maxActiveGenerations: 10,
  });
}

describe("generation state machine", () => {
  it("INV-05: exactly one terminal state under a cancel/complete race", async () => {
    for (let i = 0; i < 25; i++) {
      const { provider, gate } = gatedProvider();
      const generations = manager(provider);
      const { generationId } = await generations.start({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      });
      const events: GenerationEvent[] = [];
      generations.observe(generationId, { send: (e) => events.push(e), close: () => undefined });
      await new Promise((resolve) => setImmediate(resolve));
      // Release completion and cancel in the same tick, in alternating order.
      if (i % 2 === 0) {
        gate.resolve();
        generations.cancel(generationId);
      } else {
        generations.cancel(generationId);
        gate.resolve();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      const terminalEvents = events.filter((e) => e.type === "terminal");
      expect(terminalEvents).toHaveLength(1);
      const state = generations.snapshot(generationId).state;
      expect(["completed", "cancelled"]).toContain(state);
      expect(terminalEvents[0]?.type === "terminal" && terminalEvents[0].data.state).toBe(state);
    }
  });

  it("walks pending → streaming → completed and emits increasing event ids", async () => {
    const { provider, gate } = gatedProvider();
    const generations = manager(provider);
    const { generationId } = await generations.start({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(generations.snapshot(generationId).state).toBe("pending");
    const events: GenerationEvent[] = [];
    let closed = 0;
    generations.observe(generationId, { send: (e) => events.push(e), close: () => closed++ });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events.map((e) => e.type)).toEqual(["snapshot", "state", "delta", "terminal"]);
    expect(events.map((e) => e.id)).toEqual([0, 1, 2, 3]);
    expect(closed).toBe(1);
    expect(generations.snapshot(generationId)).toMatchObject({
      state: "completed",
      content: "hi",
      lastEventId: 3,
    });
  });

  it("an observer that unsubscribes does not affect the generation (INV-06)", async () => {
    const { provider, gate } = gatedProvider();
    const generations = manager(provider);
    const { generationId } = await generations.start({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    const unsubscribe = generations.observe(generationId, {
      send: () => undefined,
      close: () => undefined,
    });
    unsubscribe();
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(generations.snapshot(generationId).state).toBe("completed");
  });

  it("shutdown fails active generations, closes observers and stops admission", async () => {
    const { provider } = gatedProvider();
    const generations = manager(provider);
    const { generationId } = await generations.start({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    let closed = false;
    generations.observe(generationId, { send: () => undefined, close: () => (closed = true) });
    generations.shutdown();
    expect(closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(generations.snapshot(generationId)).toMatchObject({
      state: "failed",
      error: { code: "INTERNAL" },
    });
    await expect(
      generations.start({ model: "m", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });
});
