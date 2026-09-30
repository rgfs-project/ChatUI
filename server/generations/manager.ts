import { ErrorCode } from "@shared/errors";
import { AccountClosedError } from "../storage/account.ts";
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
import {
  ProviderError,
  type ChatRequest,
  type ContinuationMessages,
  type Provider,
  type Sampling,
  type ToolDefinition,
} from "../providers/types.ts";
import type { ProposalPreview } from "@shared/memories";
import { TOOL_RESULTS, type StreamedCall } from "../chat/memory-tools.ts";
import type { CheckpointStore, GenerationCheckpoint } from "../storage/checkpoints.ts";
import type { MemorySnapshotEntry } from "../storage/memories.ts";
import type { ProposalRecord } from "../storage/proposals.ts";
import type { StagedCapture } from "../artifacts/capture.ts";

/** Calls tracked per generation at all; later fragments are ignored (bounded memory). */
const MAX_TRACKED_CALLS = 32;

/**
 * Proposal tools for one generation (Phase 13b, contracts §4.3). Supplied by
 * the send path only for server-verified tool-capable models.
 */
export interface ToolSession {
  tools: readonly ToolDefinition[];
  /** Per-generation call cap; later calls are invalid. */
  maxCalls: number;
  /** Per-call argument bound (UTF-8 bytes), enforced while streaming. */
  maxArgumentBytes: number;
  /**
   * Validates the completed calls (reads only; no locks, no network) and
   * returns one fixed result per call, the staged records and SSE previews.
   */
  record(calls: readonly StreamedCall[]): Promise<{
    results: { id: string; content: string }[];
    staged: ProposalRecord[];
    previews: ProposalPreview[];
  }>;
  /** Whether the continuation's messages plus `maxTokens` of output fit the context. */
  fits(continuation: ContinuationMessages, maxTokens: number): Promise<boolean>;
}

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
  /** Staged proposals; persisted only for a `completed` outcome (contracts §4.3). */
  proposals: ProposalRecord[];
  /** Staged source captures (Phase 13c); only a `completed` outcome has any. */
  captures: StagedCapture[];
}

/**
 * Writes the terminal outcome to canonical storage exactly once (INV-07) and
 * returns the new conversation revision, or null when the write was discarded
 * (e.g. the conversation was deleted meanwhile).
 */
export type PersistOutcome = (outcome: GenerationOutcome) => Promise<string | null>;

export interface GenerationManagerOptions {
  logger: Logger;
  maxOutputTokens: number;
  generationMaxMs: number;
  /** Global admission limit (contracts §4). */
  maxActiveGenerations: number;
  /** Per-user admission limit (Phase 4, INV-62). */
  maxActivePerUser?: number;
  /** Per-provider admission limits (Phase 5); a missing entry means 1. */
  providerLimits?: Record<string, number>;
  /** Checkpoint store (Phase 6); without it nothing is checkpointed (unit tests). */
  checkpoints?: CheckpointStore;
  /** Checkpoint cadence while running (plus every state transition). */
  checkpointMs?: number;
  /** Replay ring buffer size per generation (SSE_REPLAY_EVENTS). */
  replayEvents?: number;
  /** Terminal generations are kept this long for re-observation, then evicted. */
  retentionMs?: number;
  /** At most this many terminal generations are retained (oldest evicted first). */
  maxRetained?: number;
  /** Seconds advertised in Retry-After when admission is full. */
  retryAfterSeconds?: number;
  now?: () => Date;
}

/** Identity recorded in the checkpoint (never read as conversation history). */
export interface CheckpointIdentity {
  userId: string;
  operationKey: string;
  providerId: string;
  model: string;
}

interface Generation {
  id: string;
  providerId: string;
  provider: Provider;
  /** Owner: other users get GENERATION_NOT_FOUND (INV-15). */
  userId: string;
  assistantMessageId: string;
  conversationKey: string;
  conversationId: string;
  operationKey: string;
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
  /** Ring buffer of the most recent events for replay (INV-20). */
  events: GenerationEvent[];
  observers: Set<GenerationObserver>;
  controller: AbortController;
  maxTimer: NodeJS.Timeout | undefined;
  evictTimer: NodeJS.Timeout | undefined;
  persist: PersistOutcome;
  /** Checkpoint needs a write (content changed since the last one). */
  dirty: boolean;
  lastCheckpointAt: number;
  /** Serializes this generation's checkpoint writes. */
  writes: Promise<void>;
  /** Resolves once the terminal outcome is persisted and published. */
  settled: Promise<void>;
  settle: () => void;
  memorySnapshot: MemorySnapshotEntry[] | undefined;
  /** Staged proposals (Phase 13b) and their SSE previews. */
  proposals: ProposalRecord[];
  previews: ProposalPreview[];
  continuation: ContinuationMessages | null;
  /** Wall-clock start, for the continuation's remaining time. */
  startedAtMs: number;
  /** Stages source captures from the final text (Phase 13c). */
  capture: ((content: string) => StagedCapture[]) | undefined;
}

type AbortReason = "cancel" | "max" | "shutdown";

/** A held admission slot for one conversation, taken under its lock. */
export interface Reservation {
  readonly conversationKey: string;
  readonly userId: string;
  readonly providerId: string;
  release(): void;
}

/** Where an observer resumes (contracts §5, INV-20). */
export type Cursor = number | undefined;

/**
 * Server-owned generations. The server runs each generation to exactly one
 * terminal state (INV-05) independently of any observer: closing an SSE
 * connection never cancels it (INV-06). At most one non-terminal generation
 * exists per conversation (INV-13). Progress is checkpointed so a restart can
 * write the partial reply once (INV-21); observers resume by replay or resync
 * (INV-20).
 */
export class GenerationManager {
  private readonly generations = new Map<string, Generation>();
  /** conversationKey → generation id (or a reservation marker) and its owner. */
  private readonly active = new Map<string, { id: string; userId: string; providerId: string }>();
  private readonly providerLimits = new Map<string, number>();
  private readonly options: GenerationManagerOptions;
  private readonly retentionMs: number;
  private readonly maxRetained: number;
  private readonly retryAfterSeconds: number;
  private readonly replayEvents: number;
  private readonly checkpointMs: number;
  private readonly now: () => Date;
  private readonly flushTimer: NodeJS.Timeout | undefined;
  private maxActive: number;
  private closed = false;

  constructor(options: GenerationManagerOptions) {
    this.options = options;
    this.maxActive = options.maxActiveGenerations;
    for (const [id, limit] of Object.entries(options.providerLimits ?? {}))
      this.providerLimits.set(id, limit);
    this.retentionMs = options.retentionMs ?? 10 * 60_000;
    this.maxRetained = options.maxRetained ?? 200;
    this.retryAfterSeconds = options.retryAfterSeconds ?? 5;
    this.replayEvents = options.replayEvents ?? 2_000;
    this.checkpointMs = options.checkpointMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    if (options.checkpoints) {
      // One timer for all running generations: at most one write per
      // generation per interval, never one per token.
      this.flushTimer = setInterval(
        () => {
          this.flushDue();
        },
        Math.max(50, Math.floor(this.checkpointMs / 2)),
      );
      this.flushTimer.unref();
    }
  }

  get maxActiveGenerations(): number {
    return this.maxActive;
  }

  /** Applies a discovered or configured global admission limit. */
  setMaxActiveGenerations(limit: number): void {
    this.maxActive = Math.max(1, Math.floor(limit));
  }

  private perUserOverride: number | undefined;

  /** Instance setting (Phase 10) over MAX_ACTIVE_GENERATIONS_PER_USER; undefined restores it. */
  setMaxActivePerUser(limit: number | undefined): void {
    this.perUserOverride = limit === undefined ? undefined : Math.max(1, Math.floor(limit));
  }

  /** Sets one provider's admission limit (config, else discovered slots, else 1). */
  setProviderLimit(providerId: string, limit: number): void {
    this.providerLimits.set(providerId, Math.max(1, Math.floor(limit)));
  }

  providerLimit(providerId: string): number {
    return this.providerLimits.get(providerId) ?? 1;
  }

  /** Non-terminal generations plus held reservations. */
  get activeCount(): number {
    return this.active.size;
  }

  /** The non-terminal generation (or reservation) for a conversation, if any. */
  activeFor(conversationKey: string): string | undefined {
    return this.active.get(conversationKey)?.id;
  }

  private count(predicate: (entry: { userId: string; providerId: string }) => boolean): number {
    let n = 0;
    for (const entry of this.active.values()) if (predicate(entry)) n++;
    return n;
  }

  /** Throws RATE_LIMITED when no admission slot is free (checked before any work). */
  assertAdmission(userId?: string, providerId?: string): void {
    const perUser =
      this.perUserOverride ?? this.options.maxActivePerUser ?? Number.POSITIVE_INFINITY;
    if (
      this.closed ||
      this.active.size >= this.maxActive ||
      (userId !== undefined && this.count((e) => e.userId === userId) >= perUser) ||
      // A busy provider rejects only its own starts (contracts §4).
      (providerId !== undefined &&
        this.count((e) => e.providerId === providerId) >= this.providerLimit(providerId))
    ) {
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
  reserve(userId: string, conversationKey: string, providerId: string): Reservation {
    this.assertIdle(conversationKey);
    this.assertAdmission(userId, providerId);
    const marker = `reserved:${conversationKey}`;
    this.active.set(conversationKey, { id: marker, userId, providerId });
    let released = false;
    return {
      conversationKey,
      userId,
      providerId,
      release: () => {
        if (released) return;
        released = true;
        if (this.active.get(conversationKey)?.id === marker) this.active.delete(conversationKey);
      },
    };
  }

  /** The `running` checkpoint written under the acceptance lock (§4.1 step 5). */
  initialCheckpoint(input: {
    generationId: string;
    assistantMessageId: string;
    conversationId: string;
    identity: CheckpointIdentity;
    memorySnapshot?: MemorySnapshotEntry[] | undefined;
  }): GenerationCheckpoint {
    const now = this.now().toISOString();
    return {
      version: 1,
      generationId: input.generationId,
      userId: input.identity.userId,
      conversationId: input.conversationId,
      assistantMessageId: input.assistantMessageId,
      operationKey: input.identity.operationKey,
      providerId: input.identity.providerId,
      model: input.identity.model,
      state: "running",
      content: "",
      reasoning: "",
      lastEventId: 0,
      createdAt: now,
      updatedAt: now,
      outcome: null,
      ...(input.memorySnapshot ? { memorySnapshot: input.memorySnapshot } : {}),
    };
  }

  /** Starts completion work for an accepted send, consuming the reservation. */
  launch(
    reservation: Reservation,
    input: {
      generationId: string;
      assistantMessageId: string;
      conversationId: string;
      provider: Provider;
      model: string;
      operationKey?: string;
      messages: PromptMessage[];
      /** Loads attachment bytes for media parts at request time (Phase 12). */
      loadMedia?: ChatRequest["loadMedia"];
      persist: PersistOutcome;
      /** Per-send output cap and sampling (instance/model settings, Phase 10). */
      maxTokens?: number;
      sampling?: Sampling | undefined;
      /** Proposal tools (Phase 13b); omitted for models without verified tool support. */
      tools?: ToolSession | undefined;
      memorySnapshot?: MemorySnapshotEntry[] | undefined;
      /** Source capture (Phase 13c): run on the final text of a completed reply only. */
      capture?: ((content: string) => StagedCapture[]) | undefined;
    },
  ): void {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const generation: Generation = {
      id: input.generationId,
      providerId: reservation.providerId,
      provider: input.provider,
      userId: reservation.userId,
      assistantMessageId: input.assistantMessageId,
      conversationKey: reservation.conversationKey,
      conversationId: input.conversationId,
      operationKey: input.operationKey ?? "",
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
      events: [],
      observers: new Set(),
      controller: new AbortController(),
      maxTimer: undefined,
      evictTimer: undefined,
      persist: input.persist,
      dirty: false,
      lastCheckpointAt: Date.now(),
      writes: Promise.resolve(),
      settled,
      settle,
      memorySnapshot: input.memorySnapshot,
      proposals: [],
      previews: [],
      continuation: null,
      startedAtMs: Date.now(),
      capture: input.capture,
    };
    this.generations.set(generation.id, generation);
    this.active.set(reservation.conversationKey, {
      id: generation.id,
      userId: reservation.userId,
      providerId: reservation.providerId,
    });
    generation.maxTimer = setTimeout(() => {
      this.abort(generation, "max");
    }, this.options.generationMaxMs);
    generation.maxTimer.unref();
    void this.run(generation, input.messages, {
      maxTokens: input.maxTokens ?? this.options.maxOutputTokens,
      sampling: input.sampling,
      loadMedia: input.loadMedia,
      tools: input.tools,
    });
  }

  private async run(
    generation: Generation,
    messages: PromptMessage[],
    request: {
      maxTokens: number;
      sampling: Sampling | undefined;
      loadMedia?: ChatRequest["loadMedia"];
      tools?: ToolSession | undefined;
    },
  ): Promise<void> {
    const signal = generation.controller.signal;
    const session = request.tools;
    const base = {
      model: generation.model,
      messages,
      ...(request.sampling ? { sampling: request.sampling } : {}),
      ...(request.loadMedia ? { loadMedia: request.loadMedia } : {}),
    };
    const pass: StreamPass = { started: false, calls: new Map(), usedTokens: undefined };
    try {
      await this.stream(
        generation,
        { ...base, maxTokens: request.maxTokens, ...(session ? { tools: session.tools } : {}) },
        pass,
        session,
        false,
      );
      if (signal.aborted || generation.decided) return;
      if (session && pass.calls.size > 0)
        await this.continueAfterCalls(generation, base, request.maxTokens, pass, session);
      // Re-read after the awaits: a cancel may have landed meanwhile.
      if (!aborted(generation)) this.finish(generation, "completed");
    } catch (error) {
      if (signal.aborted) {
        // abort() already decided the terminal state (or shutdown left it running).
      } else if (error instanceof ProviderError) {
        // Provider interruption and inactivity timeouts end here.
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

  /** One provider request's events into the generation (the first or the continuation). */
  private async stream(
    generation: Generation,
    request: ChatRequest,
    pass: StreamPass,
    session: ToolSession | undefined,
    continuation: boolean,
  ): Promise<void> {
    const signal = generation.controller.signal;
    // The continuation's text joins the earlier text with one blank line.
    let contentJoined = !continuation || generation.content === "";
    let reasoningJoined = !continuation || generation.reasoning === "";
    const stream = generation.provider.streamChat(request, signal);
    for await (const event of stream) {
      if (generation.decided || signal.aborted) break; // late chunks are dropped
      switch (event.type) {
        case "start":
          pass.started = true;
          this.transitionToStreaming(generation);
          break;
        case "content": {
          this.transitionToStreaming(generation);
          const text = contentJoined ? event.text : `${separator(generation.content)}${event.text}`;
          contentJoined = true;
          generation.content += text;
          generation.dirty = true;
          this.emit(generation, { type: "delta", data: { content: text } });
          break;
        }
        case "reasoning": {
          this.transitionToStreaming(generation);
          const text = reasoningJoined
            ? event.text
            : `${separator(generation.reasoning)}${event.text}`;
          reasoningJoined = true;
          generation.reasoning += text;
          generation.dirty = true;
          this.emit(generation, { type: "delta", data: { reasoning: text } });
          break;
        }
        case "tool_call":
          // Tool calls count only when tools were offered (never in the continuation).
          if (session && !continuation) this.collectCall(pass, session, event);
          break;
        case "finish":
          generation.finishReason = event.reason;
          break;
        case "usage":
          pass.usedTokens = event.completionTokens;
          break;
      }
    }
  }

  /** Accumulates a streamed call fragment within the call and argument bounds. */
  private collectCall(
    pass: StreamPass,
    session: ToolSession,
    event: { index: number; id?: string; name?: string; arguments?: string },
  ): void {
    let call = pass.calls.get(event.index);
    if (!call) {
      if (pass.calls.size >= MAX_TRACKED_CALLS) return;
      call = {
        index: event.index,
        id: "",
        name: "",
        arguments: "",
        oversized: false,
        overCap: pass.calls.size >= session.maxCalls,
      };
      pass.calls.set(event.index, call);
    }
    if (event.id && !call.id) call.id = event.id.slice(0, 128);
    if (event.name && !call.name) call.name = event.name.slice(0, 128);
    if (event.arguments && !call.oversized) {
      if (
        Buffer.byteLength(call.arguments) + Buffer.byteLength(event.arguments) >
        session.maxArgumentBytes
      ) {
        call.oversized = true;
        call.arguments = "";
      } else call.arguments += event.arguments;
    }
  }

  /**
   * Records the calls' outcomes and issues exactly one continuation request
   * (contracts §4.3): the same prompt plus the tool-call message and one
   * fixed result per call, no tools offered, the remaining output tokens and
   * time. Skipped when either is exhausted, when the messages don't fit the
   * context, or when the provider rejects tool results; the reply then ends
   * with the text so far.
   */
  private async continueAfterCalls(
    generation: Generation,
    base: Omit<ChatRequest, "maxTokens">,
    maxTokens: number,
    pass: StreamPass,
    session: ToolSession,
  ): Promise<void> {
    const calls = [...pass.calls.values()]
      .sort((a, b) => a.index - b.index)
      .map((call) => ({ ...call, id: call.id || `call_${String(call.index)}` }));
    let recorded: Awaited<ReturnType<ToolSession["record"]>>;
    try {
      recorded = await session.record(calls);
    } catch (error) {
      // Recording is best effort: the calls become invalid, the answer stands.
      this.options.logger.warn(
        { err: error, generationId: generation.id },
        "recording proposal calls failed",
      );
      recorded = {
        results: calls.map((call) => ({ id: call.id, content: TOOL_RESULTS.invalid })),
        staged: [],
        previews: [],
      };
    }
    if (generation.decided) return;
    generation.proposals = recorded.staged;
    generation.previews = recorded.previews;
    if (recorded.previews.length > 0)
      this.emit(generation, { type: "proposals", data: { proposals: recorded.previews } });
    const continuation: ContinuationMessages = {
      assistantContent: generation.content,
      calls: calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      results: recorded.results,
    };
    generation.continuation = continuation;
    void this.checkpoint(generation, "running");
    // Output already produced: the provider's count, else one token per byte.
    const used =
      pass.usedTokens ??
      Buffer.byteLength(generation.content) +
        Buffer.byteLength(generation.reasoning) +
        calls.reduce((sum, call) => sum + Buffer.byteLength(call.arguments), 0);
    const remainingTokens = maxTokens - used;
    const remainingMs = this.options.generationMaxMs - (Date.now() - generation.startedAtMs);
    const log = (reason: string) => {
      this.options.logger.info(
        { generationId: generation.id, reason, calls: calls.length },
        "continuation skipped",
      );
    };
    if (remainingTokens <= 0 || remainingMs <= 0) {
      log(remainingTokens <= 0 ? "output tokens exhausted" : "time exhausted");
      return;
    }
    if (!(await session.fits(continuation, remainingTokens))) {
      log("does not fit the context");
      return;
    }
    if (decided(generation)) return;
    const second: StreamPass = { started: false, calls: new Map(), usedTokens: undefined };
    generation.finishReason = null;
    try {
      await this.stream(
        generation,
        { ...base, maxTokens: remainingTokens, continuation },
        second,
        session,
        true,
      );
    } catch (error) {
      // A provider that refuses tool-result messages answers before streaming.
      if (
        error instanceof ProviderError &&
        !second.started &&
        (error.kind === "http" || error.kind === "context_overflow")
      ) {
        log("provider rejected the tool results");
        generation.finishReason = "tool_calls";
        return;
      }
      throw error;
    }
  }

  /**
   * Ends a generation for a server-side reason and aborts the provider request.
   * The terminal state is decided immediately, without waiting for the
   * provider. Shutdown decides nothing: the generation stays `running` in its
   * checkpoint and the next start writes it as `interrupted` (INV-21).
   */
  private abort(generation: Generation, reason: AbortReason): void {
    if (generation.decided) return;
    generation.controller.abort(reason);
    if (reason === "shutdown") return;
    if (reason === "max") {
      this.finish(generation, "timed_out", {
        code: ErrorCode.PROVIDER_TIMEOUT,
        message: "The generation exceeded the maximum allowed time",
      });
    } else {
      this.finish(generation, "cancelled");
    }
  }

  private transitionToStreaming(generation: Generation): void {
    if (generation.state !== "pending" || generation.decided) return;
    generation.state = "streaming";
    this.emit(generation, { type: "state", data: { state: "streaming" } });
    void this.checkpoint(generation, "running"); // every state transition
  }

  private checkpointOf(
    generation: Generation,
    state: GenerationCheckpoint["state"],
    outcome: GenerationOutcome | null,
  ): GenerationCheckpoint {
    return {
      version: 1,
      generationId: generation.id,
      userId: generation.userId,
      conversationId: generation.conversationId,
      assistantMessageId: generation.assistantMessageId,
      operationKey: generation.operationKey,
      providerId: generation.providerId,
      model: generation.model,
      state,
      content: outcome?.content ?? generation.content,
      reasoning: outcome?.reasoning ?? generation.reasoning,
      lastEventId: generation.seq,
      createdAt: generation.createdAt,
      updatedAt: this.now().toISOString(),
      outcome: outcome
        ? {
            state: outcome.state,
            content: outcome.content,
            reasoning: outcome.reasoning,
            finishReason: outcome.finishReason,
            error: outcome.error,
            finishedAt: outcome.finishedAt,
            ...(outcome.proposals.length > 0 ? { proposals: outcome.proposals } : {}),
            ...(outcome.captures.length > 0 ? { captures: outcome.captures } : {}),
          }
        : null,
      ...(generation.memorySnapshot ? { memorySnapshot: generation.memorySnapshot } : {}),
      ...(generation.proposals.length > 0 ? { proposals: generation.proposals } : {}),
      ...(generation.continuation ? { continuation: generation.continuation } : {}),
    };
  }

  /** Queues an atomic checkpoint write (serialized per generation). */
  private checkpoint(
    generation: Generation,
    state: GenerationCheckpoint["state"],
    outcome: GenerationOutcome | null = null,
  ): Promise<void> {
    const store = this.options.checkpoints;
    if (!store) return Promise.resolve();
    const snapshot = this.checkpointOf(generation, state, outcome);
    generation.dirty = false;
    generation.lastCheckpointAt = Date.now();
    generation.writes = generation.writes
      .then(() => store.write(snapshot))
      .catch((error: unknown) => {
        this.options.logger.error(
          { err: error, generationId: generation.id },
          "checkpoint write failed",
        );
      });
    return generation.writes;
  }

  /** Writes checkpoints of running generations whose content changed, at most once per interval. */
  private flushDue(): void {
    const due = Date.now() - this.checkpointMs;
    for (const generation of this.generations.values()) {
      if (!generation.decided && generation.dirty && generation.lastCheckpointAt <= due) {
        void this.checkpoint(generation, "running");
      }
    }
  }

  /**
   * The single guarded terminal decision (INV-05): the first caller wins and
   * every later call is a no-op. The terminal sequence then runs in order:
   * `terminal-decided` checkpoint (outcome recorded) → canonical Markdown
   * write, exactly once (INV-07) → `terminal` checkpoint → publish the state
   * and the terminal event carrying the new revision.
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
      proposals: generation.proposals,
      captures: [],
    };
    // Only a successful, complete reply is captured (INV-40); a failing
    // capture never changes the reply's outcome.
    if (state === "completed" && generation.capture) {
      try {
        outcome.captures = generation.capture(generation.content);
      } catch (captureError) {
        this.options.logger.warn(
          { err: captureError, generationId: generation.id },
          "source capture failed",
        );
      }
    }
    void (async () => {
      let revision: string | null = null;
      try {
        await this.checkpoint(generation, "terminal-decided", outcome);
        revision = await generation.persist(outcome);
        await this.checkpoint(generation, "terminal", outcome);
      } catch (persistError) {
        if (persistError instanceof AccountClosedError) {
          // The account is being closed: its terminal write is skipped, not
          // retried at restart (INV-61).
          await this.checkpoint(generation, "terminal", outcome).catch(() => undefined);
          this.options.logger.info(
            { generationId: generation.id },
            "terminal write skipped: account closed",
          );
        } else {
          this.options.logger.error(
            { err: persistError, generationId: generation.id },
            "persisting the reply failed",
          );
        }
      }
      generation.state = state;
      generation.error = error;
      generation.finishReason = outcome.finishReason;
      generation.finishedAt = outcome.finishedAt;
      generation.revision = revision;
      if (this.active.get(generation.conversationKey)?.id === generation.id) {
        this.active.delete(generation.conversationKey);
      }
      // Proposals are actionable only for a canonically complete reply (§4.3).
      const proposalIds =
        state === "completed" && revision !== null
          ? generation.proposals.filter((p) => p.status === "pending").map((p) => p.id)
          : [];
      this.emit(generation, {
        type: "terminal",
        data: { state, finishReason: outcome.finishReason, error, revision, proposalIds },
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
    generation.events.push(full);
    if (generation.events.length > this.replayEvents) generation.events.shift();
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

  /** Looks up a generation; another owner's generation is indistinguishable from none. */
  private require(id: string, userId?: string): Generation {
    const generation = this.generations.get(id);
    if (!generation || (userId !== undefined && generation.userId !== userId)) {
      throw new AppError(ErrorCode.GENERATION_NOT_FOUND, "Generation not found");
    }
    return generation;
  }

  snapshot(id: string, userId?: string): GenerationSnapshot {
    const g = this.require(id, userId);
    return {
      generationId: g.id,
      assistantMessageId: g.assistantMessageId,
      conversationId: g.conversationId,
      providerId: g.providerId,
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
      ...(g.previews.length > 0 ? { proposals: g.previews } : {}),
    };
  }

  /** Waits until a generation's terminal outcome is persisted (tests, cancel). */
  async settled(id: string): Promise<void> {
    await this.require(id).settled;
  }

  /** Explicit user cancellation. Idempotent; resolves once the outcome is persisted. */
  async cancel(id: string, userId?: string): Promise<GenerationSnapshot> {
    const generation = this.require(id, userId);
    this.abort(generation, "cancel");
    await generation.settled;
    return this.snapshot(id);
  }

  /** Cancels every running generation of a user (disabled or closed account). */
  cancelForUser(userId: string): void {
    for (const generation of this.generations.values()) {
      if (generation.userId !== userId) continue;
      this.abort(generation, "cancel");
      for (const observer of generation.observers) observer.close();
      generation.observers.clear();
    }
  }

  /**
   * Cancels a user's generations, waits until each has settled (its terminal
   * write done or skipped) and forgets them: afterwards every read or stream
   * of those ids is GENERATION_NOT_FOUND (INV-17). Never holds a lock or the
   * account barrier while waiting.
   */
  async cancelAndForgetUser(userId: string): Promise<void> {
    this.cancelForUser(userId);
    const mine = [...this.generations.values()].filter((g) => g.userId === userId);
    await Promise.all(mine.map((g) => g.settled));
    for (const generation of mine) {
      clearTimeout(generation.evictTimer);
      this.generations.delete(generation.id);
    }
  }

  /**
   * Observes a generation (INV-20). Without a cursor the observer gets a
   * `snapshot`, then live events. With a cursor inside the replay window it
   * gets exactly the missed events; a cursor that is older than the window,
   * unknown or in the future gets one `resync` event with the full snapshot.
   * There is never a silent gap. A terminal generation's stream closes after
   * the replay/snapshot. Returns an unsubscribe function, which never affects
   * the generation (INV-06).
   */
  observe(id: string, observer: GenerationObserver, userId?: string, cursor?: Cursor): () => void {
    const generation = this.require(id, userId);
    const oldest = generation.events[0]?.id ?? generation.seq + 1;
    if (cursor === undefined) {
      observer.send({ type: "snapshot", id: generation.seq, data: this.snapshot(id) });
    } else if (cursor > generation.seq || cursor < oldest - 1) {
      observer.send({ type: "resync", id: generation.seq, data: this.snapshot(id) });
    } else {
      for (const event of generation.events) if (event.id > cursor) observer.send(event);
    }
    if (isTerminalState(generation.state)) {
      observer.close();
      return () => undefined;
    }
    generation.observers.add(observer);
    return () => {
      generation.observers.delete(observer);
    };
  }

  /**
   * Graceful shutdown (an optimization only): stop admitting, stop provider
   * streams, write the latest progress of running generations as `running`
   * checkpoints (the next start writes them as `interrupted`), let terminal
   * sequences already under way finish within a bounded time, close observers.
   */
  async shutdown(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    const pending: Promise<void>[] = [];
    for (const generation of this.generations.values()) {
      clearTimeout(generation.evictTimer);
      if (generation.decided) {
        pending.push(generation.settled);
      } else {
        this.abort(generation, "shutdown");
        clearTimeout(generation.maxTimer);
        pending.push(this.checkpoint(generation, "running"));
      }
    }
    await Promise.race([
      Promise.all(pending),
      new Promise((resolve) => {
        setTimeout(resolve, timeoutMs).unref();
      }),
    ]);
    for (const generation of this.generations.values()) {
      for (const observer of generation.observers) observer.close();
      generation.observers.clear();
    }
  }
}

/** Per-request streaming state. */
interface StreamPass {
  /** The provider accepted the request (response headers). */
  started: boolean;
  calls: Map<number, StreamedCall>;
  /** Completion tokens reported by the provider's usage chunk. */
  usedTokens: number | undefined;
}

/** Current flags, read fresh after an await (a cancel or timeout may have landed). */
function decided(generation: Generation): boolean {
  return generation.decided;
}
function aborted(generation: Generation): boolean {
  return generation.controller.signal.aborted;
}

/** What joins earlier text and a continuation's text: exactly one blank line. */
function separator(text: string): string {
  if (text.endsWith("\n\n")) return "";
  return text.endsWith("\n") ? "\n" : "\n\n";
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
