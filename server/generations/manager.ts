import { ErrorCode } from "@shared/errors";
import {
  isTerminalState,
  type GenerationError,
  type GenerationEvent,
  type GenerationSnapshot,
  type GenerationState,
  type TerminalState,
} from "@shared/generations";
import type { PromptMessage } from "../chat/prompt.ts";
import { AppError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { ProviderError, type Provider } from "../providers/types.ts";

/** Receives events for one generation. Must never block (INV-06, INV-62). */
export interface GenerationObserver {
  send(event: GenerationEvent): void;
  /** Called once after the terminal event, or on manager shutdown. */
  close(): void;
}

/** What the terminal sequence hands to persistence. */
export interface GenerationOutcome {
  state: TerminalState;
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: GenerationError | null;
  finishedAt: string;
}

/**
 * Writes the terminal outcome to canonical storage exactly once (INV-07) and
 * returns the new conversation revision, or null when the write was discarded
 * (e.g. the conversation was deleted meanwhile).
 */
export type PersistOutcome = (outcome: GenerationOutcome) => Promise<string | null>;

export interface GenerationManagerOptions {
  provider: Provider;
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
  conversationKey: string;
  conversationId: string;
  model: string;
  state: GenerationState;
  /** Set by the first terminal decision; guards INV-05 while persisting. */
  decided: boolean;
  content: string;
  reasoning: string;
  finishReason: string | null;
  error: GenerationError | null;
  createdAt: string;
  finishedAt: string | null;
  revision: string | null;
  seq: number;
  observers: Set<GenerationObserver>;
  controller: AbortController;
  maxTimer: NodeJS.Timeout | undefined;
  evictTimer: NodeJS.Timeout | undefined;
  persist: PersistOutcome;
  /** Resolves once the terminal outcome is persisted and published. */
  settled: Promise<void>;
  settle: () => void;
}

type AbortReason = "cancel" | "max" | "shutdown";

/** A held admission slot for one conversation, taken under its lock. */
export interface Reservation {
  readonly conversationKey: string;
  release(): void;
}

/**
 * Server-owned generations. The server runs each generation to exactly one
 * terminal state (INV-05) independently of any observer: closing an SSE
 * connection never cancels it (INV-06). At most one non-terminal generation
 * exists per conversation (INV-13).
 */
export class GenerationManager {
  private readonly generations = new Map<string, Generation>();
  /** conversationKey → generation id or a reservation marker. */
  private readonly active = new Map<string, string>();
  private readonly options: GenerationManagerOptions;
  private readonly retentionMs: number;
  private readonly maxRetained: number;
  private readonly retryAfterSeconds: number;
  private readonly now: () => Date;
  private maxActive: number;
  private closed = false;

  constructor(options: GenerationManagerOptions) {
    this.options = options;
    this.maxActive = options.maxActiveGenerations;
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.maxRetained = options.maxRetained ?? 200;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
    this.now = options.now ?? (() => new Date());
  }

  get maxActiveGenerations(): number {
    return this.maxActive;
  }

  /** Applies a discovered admission limit (e.g. the provider's parallel slots). */
  setMaxActiveGenerations(limit: number): void {
    this.maxActive = Math.max(1, Math.floor(limit));
  }

  /** Non-terminal generations plus held reservations. */
  get activeCount(): number {
    return this.active.size;
  }

  /** The non-terminal generation (or reservation) for a conversation, if any. */
  activeFor(conversationKey: string): string | undefined {
    return this.active.get(conversationKey);
  }

  /** Throws RATE_LIMITED when no admission slot is free (checked before any work). */
  assertAdmission(): void {
    if (this.closed || this.active.size >= this.maxActive) {
      throw new AppError(
        ErrorCode.RATE_LIMITED,
        "Too many generations are running; try again shortly",
        undefined,
        { "Retry-After": String(this.retryAfterSeconds) },
      );
    }
  }

  /** Throws GENERATION_IN_PROGRESS when the conversation already has a run. */
  assertIdle(conversationKey: string): void {
    if (this.active.has(conversationKey)) {
      throw new AppError(
        ErrorCode.GENERATION_IN_PROGRESS,
        "A reply is already being generated in this conversation",
      );
    }
  }

  /** Reserves the conversation's single slot and a global slot (contracts §4.1 step 4). */
  reserve(conversationKey: string): Reservation {
    this.assertIdle(conversationKey);
    this.assertAdmission();
    const marker = `reserved:${conversationKey}`;
    this.active.set(conversationKey, marker);
    let released = false;
    return {
      conversationKey,
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(conversationKey) === marker) this.active.delete(conversationKey);
      },
    };
  }

  /** Starts completion work for an accepted send, consuming the reservation. */
  launch(
    reservation: Reservation,
    input: {
      generationId: string;
      assistantMessageId: string;
      conversationId: string;
      model: string;
      messages: PromptMessage[];
      persist: PersistOutcome;
    },
  ): void {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const generation: Generation = {
      id: input.generationId,
      assistantMessageId: input.assistantMessageId,
      conversationKey: reservation.conversationKey,
      conversationId: input.conversationId,
      model: input.model,
      state: "pending",
      decided: false,
      content: "",
      reasoning: "",
      finishReason: null,
      error: null,
      createdAt: this.now().toISOString(),
      finishedAt: null,
      revision: null,
      seq: 0,
      observers: new Set(),
      controller: new AbortController(),
      maxTimer: undefined,
      evictTimer: undefined,
      persist: input.persist,
      settled,
      settle,
    };
    this.generations.set(generation.id, generation);
    this.active.set(reservation.conversationKey, generation.id);
    generation.maxTimer = setTimeout(() => {
      this.abort(generation, "max");
    }, this.options.generationMaxMs);
    generation.maxTimer.unref();
    void this.run(generation, input.messages);
  }

  private async run(generation: Generation, messages: PromptMessage[]): Promise<void> {
    const signal = generation.controller.signal;
    try {
      const stream = this.options.provider.streamChat(
        { model: generation.model, messages, maxTokens: this.options.maxOutputTokens },
        signal,
      );
      for await (const event of stream) {
        if (generation.decided) break; // late chunks are dropped
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
        // abort() already decided the terminal state.
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
   * The terminal state is decided immediately, without waiting for the
   * provider to notice the abort.
   */
  private abort(generation: Generation, reason: AbortReason): void {
    if (generation.decided) return;
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
    if (generation.state !== "pending" || generation.decided) return;
    generation.state = "streaming";
    this.emit(generation, { type: "state", data: { state: "streaming" } });
  }

  /**
   * The single guarded terminal decision (INV-05): the first caller wins and
   * every later call is a no-op, so cancel/complete races produce exactly one
   * terminal state. The outcome is persisted (INV-07) before the terminal
   * state and event are published, so the event can carry the new revision.
   */
  private finish(
    generation: Generation,
    state: TerminalState,
    error: GenerationError | null = null,
  ): void {
    if (generation.decided) return;
    generation.decided = true;
    clearTimeout(generation.maxTimer);
    if (!generation.controller.signal.aborted)
      generation.controller.abort("cancel" satisfies AbortReason);
    const outcome: GenerationOutcome = {
      state,
      content: generation.content,
      reasoning: generation.reasoning,
      finishReason: state === "completed" ? generation.finishReason : null,
      error,
      finishedAt: this.now().toISOString(),
    };
    void (async () => {
      let revision: string | null = null;
      try {
        revision = await generation.persist(outcome);
      } catch (persistError) {
        this.options.logger.error(
          { err: persistError, generationId: generation.id },
          "persisting the reply failed",
        );
      }
      generation.state = state;
      generation.error = error;
      generation.finishReason = outcome.finishReason;
      generation.finishedAt = outcome.finishedAt;
      generation.revision = revision;
      if (this.active.get(generation.conversationKey) === generation.id)
        this.active.delete(generation.conversationKey);
      this.emit(generation, {
        type: "terminal",
        data: { state, finishReason: outcome.finishReason, error, revision },
      });
      for (const observer of generation.observers) observer.close();
      generation.observers.clear();
      this.scheduleEviction(generation);
      generation.settle();
    })();
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
      conversationId: g.conversationId,
      model: g.model,
      state: g.state,
      content: g.content,
      reasoning: g.reasoning,
      finishReason: g.finishReason,
      error: g.error,
      createdAt: g.createdAt,
      finishedAt: g.finishedAt,
      revision: g.revision,
      lastEventId: g.seq,
    };
  }

  /** Waits until a generation's terminal outcome is persisted (tests, cancel). */
  async settled(id: string): Promise<void> {
    await this.require(id).settled;
  }

  /** Explicit user cancellation. Idempotent; resolves once the outcome is persisted. */
  async cancel(id: string): Promise<GenerationSnapshot> {
    const generation = this.require(id);
    this.abort(generation, "cancel");
    await generation.settled;
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

  /** Stops admitting, ends active generations and waits for their outcomes to persist. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const pending: Promise<void>[] = [];
    for (const generation of this.generations.values()) {
      this.abort(generation, "shutdown");
      pending.push(generation.settled);
      clearTimeout(generation.evictTimer);
    }
    await Promise.all(pending);
    for (const generation of this.generations.values()) {
      for (const observer of generation.observers) observer.close();
      generation.observers.clear();
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
