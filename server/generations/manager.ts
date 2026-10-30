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
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type ProviderMessage,
} from "../providers/types.ts";
import type { CheckpointStore, GenerationCheckpoint } from "../storage/checkpoints.ts";
import type { StagedProposal } from "../storage/proposals.ts";
import {
  ARTIFACTS_PER_GENERATION,
  fencedCaptures,
  type StagedArtifact,
} from "../artifacts/store.ts";
import {
  MAX_ARGUMENT_BYTES,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from "../tools/session.ts";

/**
 * The shared tool loop of one generation (D2 amendment to contracts §4.3).
 * Tool-call and result messages live only in memory and the checkpoint; they
 * are never written to Markdown or replayed on later turns.
 */
export interface ToolLoop {
  definitions: ToolDefinition[];
  /** Tool rounds allowed; the request after the last round offers no tools. */
  maxRounds: number;
  execute(calls: readonly ToolCall[]): Promise<ToolResult[]>;
  used(): string[];
  staged(): StagedProposal[];
  artifacts(): StagedArtifact[];
  previews(): { tool: string; name: string }[];
  /** Whether a follow-up request with these messages fits the context budget. */
  fits(messages: ProviderMessage[]): Promise<boolean>;
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
  /** Tools the reply used, in order of first use (saved as chips). */
  tools: string[];
  /** Validated and suppressed memory suggestions, written only for a complete reply. */
  proposals: StagedProposal[];
  /** Files to capture (Phase 13c): `create_file` calls, then `file=` fences; complete replies only. */
  artifacts: StagedArtifact[];
  /** Milliseconds from the first reasoning to the first answer text (Phase 14b), if it reasoned. */
  thoughtMs: number | null;
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
  /** Live tool activity (SSE `tool`) and the session behind it. */
  toolActivity: { callId: string; name: string; state: "running" | "done" | "error" }[];
  loop: ToolLoop | null;
  /** First reasoning and first answer text (ms since epoch), for "Thought for …". */
  reasoningAt: number | null;
  contentAt: number | null;
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
    const perUser = this.options.maxActivePerUser ?? Number.POSITIVE_INFINITY;
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
      persist: PersistOutcome;
      /** Per-generation output cap (admin limit ≤ environment) and sampling (Phase 10). */
      maxTokens?: number;
      sampling?: ChatRequest["sampling"];
      think?: boolean;
      /** The shared tool loop, for tool-capable models (D2). */
      tools?: ToolLoop;
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
      toolActivity: [],
      loop: input.tools ?? null,
      reasoningAt: null,
      contentAt: null,
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
      maxTokens: Math.min(
        input.maxTokens ?? this.options.maxOutputTokens,
        this.options.maxOutputTokens,
      ),
      ...(input.sampling ? { sampling: input.sampling } : {}),
      ...(input.think !== undefined ? { think: input.think } : {}),
    });
  }

  private async run(
    generation: Generation,
    initial: ProviderMessage[],
    limits: { maxTokens: number; sampling?: ChatRequest["sampling"]; think?: boolean },
  ): Promise<void> {
    const signal = generation.controller.signal;
    const loop = generation.loop;
    let messages = initial;
    let round = 0;
    let outputTokens = 0;
    // A function, so checks after an await are not narrowed away.
    const stopped = () => generation.decided || signal.aborted;
    // Whether the current follow-up request has produced anything yet.
    let roundStarted = false;
    try {
      for (;;) {
        const offer = loop !== null && round < loop.maxRounds;
        const remaining = limits.maxTokens - outputTokens;
        // Text before tool calls and the follow-up text are joined by one blank line.
        let contentGap = generation.content !== "";
        let reasoningGap = generation.reasoning !== "";
        let roundText = "";
        let roundChars = 0;
        let usage: number | null = null;
        roundStarted = false;
        const calls = new Map<
          number,
          { id: string; name: string; args: string; oversized: boolean }
        >();
        const stream = generation.provider.streamChat(
          {
            model: generation.model,
            messages,
            maxTokens: remaining,
            ...(limits.sampling ? { sampling: limits.sampling } : {}),
            ...(limits.think !== undefined ? { think: limits.think } : {}),
            ...(offer ? { tools: loop.definitions } : {}),
          },
          signal,
        );
        for await (const event of stream) {
          if (generation.decided || signal.aborted) break; // late chunks are dropped
          if (event.type !== "start") roundStarted = true;
          switch (event.type) {
            case "start":
              this.transitionToStreaming(generation);
              break;
            case "content": {
              this.transitionToStreaming(generation);
              generation.contentAt ??= Date.now();
              const text = contentGap ? `\n\n${event.text}` : event.text;
              contentGap = false;
              generation.content += text;
              roundText += event.text;
              roundChars += event.text.length;
              generation.dirty = true;
              this.emit(generation, { type: "delta", data: { content: text } });
              break;
            }
            case "reasoning": {
              this.transitionToStreaming(generation);
              generation.reasoningAt ??= Date.now();
              const text = reasoningGap ? `\n\n${event.text}` : event.text;
              reasoningGap = false;
              generation.reasoning += text;
              roundChars += event.text.length;
              generation.dirty = true;
              this.emit(generation, { type: "delta", data: { reasoning: text } });
              break;
            }
            case "tool_call": {
              if (!offer) break; // tools were not offered: ignored
              this.transitionToStreaming(generation);
              const call = calls.get(event.index) ?? {
                id: "",
                name: "",
                args: "",
                oversized: false,
              };
              if (event.id && !call.id) call.id = event.id;
              if (event.name && !call.name) call.name = event.name;
              if (event.arguments) {
                if (call.args.length + event.arguments.length > MAX_ARGUMENT_BYTES)
                  call.oversized = true;
                else call.args += event.arguments;
              }
              calls.set(event.index, call);
              break;
            }
            case "finish":
              generation.finishReason = event.reason;
              break;
            case "usage":
              usage = event.completionTokens;
              break;
          }
        }
        if (signal.aborted) return;
        outputTokens += usage ?? Math.ceil(roundChars / 4);
        // Calls without an id or a name are incomplete: never run, never answered.
        const complete = [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => call)
          .filter((call) => call.id !== "" && call.name !== "");
        if (!offer || complete.length === 0) break;
        const toolCalls: ToolCall[] = complete.map((call) => ({
          id: call.id,
          name: call.name,
          // Oversized arguments are invalid (contracts §4.3).
          arguments: call.oversized ? "\u0000" : call.args,
        }));
        for (const call of toolCalls) this.toolEvent(generation, call.id, call.name, "running");
        const before = loop.previews().length;
        const results = await loop.execute(toolCalls);
        if (stopped()) return;
        for (const result of results)
          this.toolEvent(generation, result.callId, result.name, result.ok ? "done" : "error");
        if (loop.previews().length !== before)
          this.emit(generation, { type: "proposals", data: { previews: loop.previews() } });
        generation.dirty = true;
        round++;
        // The follow-up gets only what is left of the output budget.
        if (limits.maxTokens - outputTokens <= 0) break;
        const next: ProviderMessage[] = [
          ...messages,
          {
            role: "assistant",
            content: roundText === "" ? null : roundText,
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          ...results.map((result) => ({
            role: "tool" as const,
            tool_call_id: result.callId,
            content: result.content,
          })),
        ];
        // A follow-up that cannot fit is skipped: the reply ends with the text so far.
        if (!(await loop.fits(next))) break;
        if (stopped()) return;
        generation.finishReason = null;
        messages = next;
      }
      if (!stopped()) this.finish(generation, "completed");
    } catch (error) {
      if (signal.aborted) {
        // abort() already decided the terminal state (or shutdown left it running).
      } else if (
        error instanceof ProviderError &&
        round > 0 &&
        !roundStarted &&
        (error.kind === "http" || error.kind === "context_overflow")
      ) {
        // The provider rejected the tool-loop follow-up (§4.3): the reply ends
        // with the text it already has.
        this.options.logger.warn(
          { generationId: generation.id, kind: error.kind },
          "tool follow-up rejected by the provider; ending with the text so far",
        );
        this.finish(generation, "completed");
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

  /** Tool files first, then `file=` fences of the visible text, with consecutive capture indexes. */
  private captures(generation: Generation): StagedArtifact[] {
    const fromTools = generation.loop?.artifacts() ?? [];
    return [...fromTools, ...fencedCaptures(generation.content, fromTools.length)].slice(
      0,
      ARTIFACTS_PER_GENERATION,
    );
  }

  private toolEvent(
    generation: Generation,
    callId: string,
    name: string,
    state: "running" | "done" | "error",
  ): void {
    const entry = { callId: callId.slice(0, 100), name: name.slice(0, 64), state };
    const index = generation.toolActivity.findIndex((t) => t.callId === entry.callId);
    if (index >= 0) generation.toolActivity[index] = entry;
    else if (generation.toolActivity.length < 32) generation.toolActivity.push(entry);
    this.emit(generation, { type: "tool", data: entry });
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
            tools: outcome.tools,
            proposals: outcome.proposals,
            artifacts: outcome.artifacts,
            thoughtMs: outcome.thoughtMs,
          }
        : null,
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
      tools: generation.loop?.used() ?? [],
      // Staged suggestions count only for a complete reply (contracts §4.3).
      proposals: state === "completed" ? (generation.loop?.staged() ?? []) : [],
      artifacts: state === "completed" ? this.captures(generation) : [],
      thoughtMs:
        generation.reasoningAt === null
          ? null
          : Math.min(
              86_400_000,
              Math.max(0, (generation.contentAt ?? Date.now()) - generation.reasoningAt),
            ),
    };
    void (async () => {
      let revision: string | null = null;
      try {
        await this.checkpoint(generation, "terminal-decided", outcome);
        revision = await generation.persist(outcome);
        await this.checkpoint(generation, "terminal", outcome);
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
      if (this.active.get(generation.conversationKey)?.id === generation.id) {
        this.active.delete(generation.conversationKey);
      }
      this.emit(generation, {
        type: "terminal",
        data: {
          state,
          finishReason: outcome.finishReason,
          error,
          revision,
          proposalIds:
            state === "completed" && revision !== null
              ? outcome.proposals.filter((p) => p.status === "pending").map((p) => p.id)
              : [],
        },
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
      tools: [...g.toolActivity],
      proposals: g.loop?.previews() ?? [],
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
  /** Non-terminal generations of one account (account closure waits for zero). */
  activeCountForUser(userId: string): number {
    return this.count((entry) => entry.userId === userId);
  }

  cancelForUser(userId: string): void {
    for (const generation of this.generations.values()) {
      if (generation.userId !== userId) continue;
      this.abort(generation, "cancel");
      for (const observer of generation.observers) observer.close();
      generation.observers.clear();
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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
