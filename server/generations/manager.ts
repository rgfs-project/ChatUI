import { randomUUID } from "node:crypto";
import { ErrorCode } from "@shared/errors";
import {
  isTerminalState,
  type ChatMessage,
  type GenerationError,
  type GenerationEvent,
  type GenerationSnapshot,
  type GenerationState,
  type TerminalState,
} from "@shared/generations";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { ProviderError, type Provider } from "../providers/types.ts";
import type { ModelCatalog } from "./catalog.ts";

/** Receives events for one generation. Must never block (INV-06, INV-62). */
export interface GenerationObserver {
  send(event: GenerationEvent): void;
  /** Called once after the terminal event, or on manager shutdown. */
  close(): void;
}

export interface GenerationManagerOptions {
  provider: Provider;
  catalog: ModelCatalog;
  logger: Logger;
  maxOutputTokens: number;
  generationMaxMs: number;
  /** Global admission limit (contracts §4). */
  maxActiveGenerations: number;
  /** Terminal generations are kept this long for re-observation, then evicted. */
  retentionMs?: number;
  /** At most this many terminal generations are retained (oldest evicted first). */
  maxRetained?: number;
  /** Seconds advertised in Retry-After when admission is full. */
  retryAfterSeconds?: number;
  now?: () => Date;
}

interface Generation {
  id: string;
  assistantMessageId: string;
  model: string;
  state: GenerationState;
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: GenerationError | null;
  createdAt: string;
  finishedAt: string | null;
  seq: number;
  observers: Set<GenerationObserver>;
  controller: AbortController;
  maxTimer: NodeJS.Timeout | undefined;
  evictTimer: NodeJS.Timeout | undefined;
}

type AbortReason = "cancel" | "max" | "shutdown";

/**
 * In-memory, server-owned generations (Phase 2). The server runs each
 * generation to exactly one terminal state (INV-05) independently of any
 * observer: closing an SSE connection never cancels it (INV-06).
 */
export class GenerationManager {
  private readonly generations = new Map<string, Generation>();
  private readonly retentionMs: number;
  private readonly maxRetained: number;
  private readonly retryAfterSeconds: number;
  private readonly now: () => Date;
  private reserved = 0;
  private maxActive: number;
  private closed = false;

  private readonly options: GenerationManagerOptions;

  constructor(options: GenerationManagerOptions) {
    this.options = options;
    this.maxActive = options.maxActiveGenerations;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.maxRetained = options.maxRetained ?? 200;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
    this.now = options.now ?? (() => new Date());
  }

  get activeCount(): number {
    let count = 0;
    for (const generation of this.generations.values()) {
      if (!isTerminalState(generation.state)) count++;
    }
    return count;
  }

  get maxActiveGenerations(): number {
    return this.maxActive;
  }

  /** Applies a discovered admission limit (e.g. the provider's parallel slots). */
  setMaxActiveGenerations(limit: number): void {
    this.maxActive = Math.max(1, Math.floor(limit));
  }

  private assertAdmission(): void {
    if (this.closed || this.activeCount + this.reserved >= this.maxActive) {
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        "Too many generations are running; try again shortly",
        undefined,
        { "Retry-After": String(this.retryAfterSeconds) },
      );
    }
  }

  /**
   * Admits and starts a generation. Admission is checked before any work and
   * again after model validation; the slot is reserved while validating.
   */
  async start(input: { model: string; messages: ChatMessage[] }): Promise<{
    generationId: string;
    assistantMessageId: string;
  }> {
    this.assertAdmission();
    this.reserved++;
    let model: string;
    try {
      model = (await this.options.catalog.resolve(input.model)).id;
    } finally {
      this.reserved--;
    }
    this.assertAdmission();

    const generation: Generation = {
      id: randomUUID(),
      assistantMessageId: randomUUID(),
      model,
      state: "pending",
      content: "",
      reasoning: "",
      finishReason: null,
      error: null,
      createdAt: this.now().toISOString(),
      finishedAt: null,
      seq: 0,
      observers: new Set(),
      controller: new AbortController(),
      maxTimer: undefined,
      evictTimer: undefined,
    };
    this.generations.set(generation.id, generation);
    generation.maxTimer = setTimeout(() => {
      this.abort(generation, "max");
    }, this.options.generationMaxMs);
    generation.maxTimer.unref();

    void this.run(generation, input.messages);
    return { generationId: generation.id, assistantMessageId: generation.assistantMessageId };
  }

  private async run(generation: Generation, messages: ChatMessage[]): Promise<void> {
    const signal = generation.controller.signal;
    try {
      const stream = this.options.provider.streamChat(
        { model: generation.model, messages, maxTokens: this.options.maxOutputTokens },
        signal,
      );
      for await (const event of stream) {
        if (isTerminalState(generation.state)) break; // late chunks are dropped
        switch (event.type) {
          case "start":
            this.transitionToStreaming(generation);
            break;
          case "content":
            this.transitionToStreaming(generation);
            generation.content += event.text;
            this.emit(generation, { type: "delta", data: { content: event.text } });
            break;
          case "reasoning":
            this.transitionToStreaming(generation);
            generation.reasoning += event.text;
            this.emit(generation, { type: "delta", data: { reasoning: event.text } });
            break;
          case "finish":
            generation.finishReason = event.reason;
            break;
          case "usage":
            break;
        }
      }
      this.finish(generation, "completed");
    } catch (error) {
      if (signal.aborted) {
        // abort() already recorded the terminal state; nothing left to do.
      } else if (error instanceof ProviderError) {
        this.finish(
          generation,
          error.code === ErrorCode.PROVIDER_TIMEOUT ? "timed_out" : "failed",
          {
            code: error.code,
            message: error.message,
          },
        );
      } else {
        this.options.logger.error({ err: error, generationId: generation.id }, "generation failed");
        this.finish(generation, "failed", {
          code: ErrorCode.INTERNAL,
          message: "The generation failed",
        });
      }
    }
  }

  /**
   * Ends a generation for a server-side reason and aborts the provider request.
   * The terminal state is recorded immediately, without waiting for the
   * provider to notice the abort.
   */
  private abort(generation: Generation, reason: AbortReason): void {
    if (isTerminalState(generation.state)) return;
    generation.controller.abort(reason);
    if (reason === "max") {
      this.finish(generation, "timed_out", {
        code: ErrorCode.PROVIDER_TIMEOUT,
        message: "The generation exceeded the maximum allowed time",
      });
    } else if (reason === "shutdown") {
      this.finish(generation, "failed", {
        code: ErrorCode.INTERNAL,
        message: "The server shut down during the generation",
      });
    } else {
      this.finish(generation, "cancelled");
    }
  }

  private transitionToStreaming(generation: Generation): void {
    if (generation.state !== "pending") return;
    generation.state = "streaming";
    this.emit(generation, { type: "state", data: { state: "streaming" } });
  }

  /**
   * The single guarded terminal transition (INV-05): the first caller wins;
   * every later call is a no-op, so cancel/complete races produce exactly one
   * terminal state and one terminal event.
   */
  private finish(
    generation: Generation,
    state: TerminalState,
    error: GenerationError | null = null,
  ): boolean {
    if (isTerminalState(generation.state)) return false;
    generation.state = state;
    generation.error = error;
    if (state !== "completed") generation.finishReason = null;
    generation.finishedAt = this.now().toISOString();
    clearTimeout(generation.maxTimer);
    if (!generation.controller.signal.aborted)
      generation.controller.abort("cancel" satisfies AbortReason);
    this.emit(generation, {
      type: "terminal",
      data: { state, finishReason: generation.finishReason, error },
    });
    for (const observer of generation.observers) observer.close();
    generation.observers.clear();
    this.scheduleEviction(generation);
    return true;
  }

  private emit(generation: Generation, event: DistributiveOmit<GenerationEvent, "id">): void {
    generation.seq++;
    const full = { ...event, id: generation.seq };
    for (const observer of generation.observers) observer.send(full);
  }

  private scheduleEviction(generation: Generation): void {
    generation.evictTimer = setTimeout(() => {
      this.generations.delete(generation.id);
    }, this.retentionMs);
    generation.evictTimer.unref();
    const terminal = [...this.generations.values()].filter((g) => isTerminalState(g.state));
    for (const old of terminal.slice(0, Math.max(0, terminal.length - this.maxRetained))) {
      clearTimeout(old.evictTimer);
      this.generations.delete(old.id);
    }
  }

  private require(id: string): Generation {
    const generation = this.generations.get(id);
    if (!generation) throw new AppError(ErrorCode.GENERATION_NOT_FOUND, "Generation not found");
    return generation;
  }

  snapshot(id: string): GenerationSnapshot {
    const g = this.require(id);
    return {
      generationId: g.id,
      assistantMessageId: g.assistantMessageId,
      model: g.model,
      state: g.state,
      content: g.content,
      reasoning: g.reasoning,
      finishReason: g.finishReason,
      error: g.error,
      createdAt: g.createdAt,
      finishedAt: g.finishedAt,
      lastEventId: g.seq,
    };
  }

  /** Explicit user cancellation. Idempotent: a terminal generation is returned unchanged. */
  cancel(id: string): GenerationSnapshot {
    const generation = this.require(id);
    this.abort(generation, "cancel");
    return this.snapshot(id);
  }

  /**
   * Observes a generation: the observer receives the current snapshot, then
   * live events. Returns an unsubscribe function, which never affects the
   * generation itself (INV-06).
   */
  observe(id: string, observer: GenerationObserver): () => void {
    const generation = this.require(id);
    observer.send({ type: "snapshot", id: generation.seq, data: this.snapshot(id) });
    if (isTerminalState(generation.state)) {
      observer.close();
      return () => undefined;
    }
    generation.observers.add(observer);
    return () => {
      generation.observers.delete(observer);
    };
  }

  /** Stops admitting, ends active generations and closes all observers. */
  shutdown(): void {
    this.closed = true;
    for (const generation of this.generations.values()) {
      this.abort(generation, "shutdown");
      for (const observer of generation.observers) observer.close();
      generation.observers.clear();
      clearTimeout(generation.evictTimer);
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
