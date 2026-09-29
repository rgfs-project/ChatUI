import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { GenerationEvent } from "@shared/generations";
import { GenerationManager, type GenerationOutcome } from "../../server/generations/manager.ts";
import type { Provider, ProviderEvent } from "../../server/providers/types.ts";
import { captureLogger } from "./helpers.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A provider whose single stream finishes exactly when the test releases it (ignores aborts). */
function gatedProvider() {
  const gate = deferred();
  const provider: Provider = {
    listModels: () => Promise.resolve([{ id: "m", contextTokens: 100, status: "loaded" }]),
    discoverSlots: () => Promise.resolve(undefined),
    tokenize: () => Promise.resolve(1),
    applyTemplate: () => Promise.resolve(""),
    async *streamChat(): AsyncGenerator<ProviderEvent> {
      yield { type: "start" };
      yield { type: "content", text: "hi" };
      await gate.promise;
      yield { type: "finish", reason: "stop" };
    },
  };
  return { provider, gate };
}

/** The test provider behind each manager (generations carry their provider). */
const providerOf = new WeakMap<GenerationManager, Provider>();

function manager(provider: Provider, maxActiveGenerations = 10) {
  const generations = new GenerationManager({
    logger: captureLogger().logger,
    maxOutputTokens: 10,
    generationMaxMs: 10_000,
    maxActiveGenerations,
    providerLimits: { p: 100 },
  });
  providerOf.set(generations, provider);
  return generations;
}

function launch(
  generations: GenerationManager,
  persisted: GenerationOutcome[] = [],
  conversationKey = "u/c",
) {
  const generationId = randomUUID();
  generations.launch(generations.reserve("u", conversationKey, "p"), {
    generationId,
    assistantMessageId: randomUUID(),
    conversationId: randomUUID(),
    provider: providerOf.get(generations) as Provider,
    model: "m",
    messages: [{ role: "user", content: "x" }],
    persist: (outcome) => {
      persisted.push(outcome);
      return Promise.resolve("rev-1");
    },
  });
  return generationId;
}

describe("generation state machine", () => {
  it("INV-05/INV-07: exactly one terminal state and one persisted outcome under a cancel/complete race", async () => {
    for (let i = 0; i < 25; i++) {
      const { provider, gate } = gatedProvider();
      const generations = manager(provider);
      const persisted: GenerationOutcome[] = [];
      const id = launch(generations, persisted);
      const events: GenerationEvent[] = [];
      generations.observe(id, { send: (e) => events.push(e), close: () => undefined });
      await new Promise((resolve) => setImmediate(resolve));
      let cancelled: Promise<unknown>;
      if (i % 2 === 0) {
        gate.resolve();
        cancelled = generations.cancel(id);
      } else {
        cancelled = generations.cancel(id);
        gate.resolve();
      }
      await cancelled;
      await generations.settled(id);
      const terminalEvents = events.filter((e) => e.type === "terminal");
      expect(terminalEvents).toHaveLength(1);
      expect(persisted).toHaveLength(1);
      const state = generations.snapshot(id).state;
      expect(["completed", "cancelled"]).toContain(state);
      expect(persisted[0]?.state).toBe(state);
    }
  });

  it("walks pending → streaming → completed; the terminal event carries the revision", async () => {
    const { provider, gate } = gatedProvider();
    const generations = manager(provider);
    const id = launch(generations);
    expect(generations.snapshot(id).state).toBe("pending");
    const events: GenerationEvent[] = [];
    let closed = 0;
    generations.observe(id, { send: (e) => events.push(e), close: () => closed++ });
    gate.resolve();
    await generations.settled(id);
    expect(events.map((e) => e.type)).toEqual(["snapshot", "state", "delta", "terminal"]);
    expect(events.map((e) => e.id)).toEqual([0, 1, 2, 3]);
    expect(events.at(-1)).toMatchObject({ data: { state: "completed", revision: "rev-1" } });
    expect(closed).toBe(1);
    expect(generations.snapshot(id)).toMatchObject({
      state: "completed",
      content: "hi",
      revision: "rev-1",
    });
  });

  it("INV-13: one non-terminal generation per conversation; the slot frees at the terminal state", async () => {
    const { provider, gate } = gatedProvider();
    const generations = manager(provider);
    const id = launch(generations, [], "u/one");
    expect(() => generations.reserve("u", "u/one", "p")).toThrow(
      expect.objectContaining({ code: "GENERATION_IN_PROGRESS" }) as Error,
    );
    expect(() => generations.reserve("u", "u/two", "p")).not.toThrow();
    gate.resolve();
    await generations.settled(id);
    expect(generations.activeFor("u/one")).toBeUndefined();
  });

  it("INV-62: the per-user cap limits one user without blocking another", () => {
    const generations = new GenerationManager({
      logger: captureLogger().logger,
      maxOutputTokens: 10,
      generationMaxMs: 10_000,
      maxActiveGenerations: 10,
      maxActivePerUser: 2,
      providerLimits: { p: 100 },
    });
    generations.reserve("alice", "alice/a", "p");
    generations.reserve("alice", "alice/b", "p");
    expect(() => generations.reserve("alice", "alice/c", "p")).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }) as Error,
    );
    expect(() => generations.reserve("bob", "bob/a", "p")).not.toThrow();
  });

  it("a saturated provider rejects its own starts while another provider still accepts", () => {
    const generations = new GenerationManager({
      logger: captureLogger().logger,
      maxOutputTokens: 10,
      generationMaxMs: 10_000,
      maxActiveGenerations: 10,
      providerLimits: { a: 1, b: 1 },
    });
    generations.reserve("u", "u/1", "a");
    expect(() => generations.reserve("u", "u/2", "a")).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }) as Error,
    );
    expect(() => generations.reserve("u", "u/3", "b")).not.toThrow();
  });

  it("admission counts reservations and running generations", () => {
    const { provider } = gatedProvider();
    const generations = manager(provider, 1);
    const reservation = generations.reserve("u", "u/a", "p");
    expect(() => generations.reserve("u", "u/b", "p")).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }) as Error,
    );
    reservation.release();
    expect(() => generations.reserve("u", "u/b", "p")).not.toThrow();
  });

  it("an observer that unsubscribes does not affect the generation (INV-06)", async () => {
    const { provider, gate } = gatedProvider();
    const generations = manager(provider);
    const id = launch(generations);
    const unsubscribe = generations.observe(id, { send: () => undefined, close: () => undefined });
    unsubscribe();
    gate.resolve();
    await generations.settled(id);
    expect(generations.snapshot(id).state).toBe("completed");
  });

  it("shutdown fails active generations (persisting them), closes observers and stops admission", async () => {
    const { provider } = gatedProvider();
    const generations = manager(provider);
    const persisted: GenerationOutcome[] = [];
    const id = launch(generations, persisted);
    let closed = false;
    generations.observe(id, { send: () => undefined, close: () => (closed = true) });
    await generations.shutdown();
    expect(closed).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(generations.snapshot(id)).toMatchObject({
      state: "failed",
      error: { code: "INTERNAL" },
    });
    expect(() => generations.reserve("u", "u/x", "p")).toThrow(
      expect.objectContaining({ code: "RATE_LIMITED" }) as Error,
    );
  });
});
