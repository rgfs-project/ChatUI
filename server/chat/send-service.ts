import { randomUUID } from "node:crypto";
import type { SkillDto } from "@shared/skills";
import type { SkillsStore } from "../storage/skills.ts";
import { expandSkill } from "./skills.ts";
import type { ResolvedModelSettings, SettingsStore } from "../admin/settings.ts";
import type { Sampling } from "../providers/types.ts";
import { ErrorCode } from "@shared/errors";
import type { StartGenerationRequest, StartGenerationResponse } from "@shared/generations";
import { AppError } from "../errors.ts";
import type { ModelCatalog } from "../generations/catalog.ts";
import type { GenerationManager, GenerationOutcome } from "../generations/manager.ts";
import type { Logger } from "../logger.ts";
import type { Provider } from "../providers/types.ts";
import { type ConversationStore } from "../storage/conversations.ts";
import {
  NEW_CONVERSATION_TITLE,
  normalizeBody,
  serializeConversation,
  type AssistantStatus,
  type Block,
  type ConversationModel,
} from "../storage/markdown.ts";
import { sha256Hex, type OperationRecord, type OperationStore } from "../storage/operations.ts";
import type { CheckpointStore } from "../storage/checkpoints.ts";
import { resolvePendingRecord } from "../storage/recovery.ts";
import {
  assemblePrompt,
  ContextTooLargeError,
  type AssembledPrompt,
  type TokenCounter,
} from "./prompt.ts";
import { counterFor } from "./token-counter.ts";

const DAY_MS = 86_400_000;

const STATUS: Record<GenerationOutcome["state"], AssistantStatus> = {
  completed: "complete",
  cancelled: "cancelled",
  failed: "failed",
  timed_out: "timed_out",
};

export interface SendHooks {
  /** Test hooks that simulate a crash at the two §4.1 step 4 boundaries. */
  afterPendingRecord?: () => void | Promise<void>;
  afterMarkdownWrite?: () => void | Promise<void>;
  /** After the committed record and the `running` checkpoint (crash-before-launch tests). */
  afterCommit?: () => void | Promise<void>;
  /** Test hook between the unlocked preflight and the locked recheck. */
  beforeRecheck?: () => void | Promise<void>;
}

export interface SendServiceOptions {
  store: ConversationStore;
  /** Generation checkpoints (Phase 6): `running` is written under the acceptance lock. */
  checkpoints?: CheckpointStore;
  operations: OperationStore;
  catalog: ModelCatalog;
  generations: GenerationManager;
  logger: Logger;
  maxOutputTokens: number;
  operationRetentionMs: number;
  contextTrimStep: number | undefined;
  templateOverheadTokens: number;
  now?: () => Date;
  hooks?: SendHooks;
  /** Overrides token counting (tests). */
  counterFor?: (providerId: string, model: string) => Promise<TokenCounter>;
  /** Instance and per-model settings (Phase 10): visibility, prompts, sampling, limits. */
  settings?: SettingsStore;
  /** The sender's skills ("/name" messages are expanded in the prompt). */
  skills?: SkillsStore;
}

/** Who is sending: the username feeds prompt templates, the role model visibility. */
export interface Sender {
  username: string;
  role: "user" | "admin";
}

function resultOf(record: OperationRecord): StartGenerationResponse {
  return {
    conversationId: record.conversationId,
    generationId: record.generationId,
    userMessageId: record.userMessageId,
    assistantMessageId: record.assistantMessageId,
  };
}

/**
 * Send acceptance (contracts §4.1) for the local user. Every contract error
 * except INTERNAL is raised before acceptance begins (step 4); from step 4 on,
 * any failure is INTERNAL because the commit may already have happened.
 */
export class SendService {
  private readonly o: SendServiceOptions;
  private readonly now: () => Date;
  /** Same-key requests in flight: later ones wait for the first (§4.1). */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(options: SendServiceOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
  }

  static payloadHash(
    request: Pick<StartGenerationRequest, "conversationId" | "providerId" | "model" | "content">,
  ): string {
    return sha256Hex(
      JSON.stringify({
        conversationId: request.conversationId ?? null,
        providerId: request.providerId,
        model: request.model,
        content: normalizeBody(request.content),
      }),
    );
  }

  async send(
    userId: string,
    request: StartGenerationRequest,
    sender: Sender = { username: "", role: "user" },
  ): Promise<StartGenerationResponse> {
    const flightKey = `${userId}:${request.operationKey}`;
    // Wait for an in-flight request with the same key, then decide from its record.
    for (;;) {
      const inflight = this.inflight.get(flightKey);
      if (!inflight) break;
      await inflight.catch(() => undefined);
    }
    const work = this.accept(userId, request, sender);
    this.inflight.set(flightKey, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(flightKey) === work) this.inflight.delete(flightKey);
    }
  }

  /** Step 1: the operation key decides first, before admission/model/provider checks. */
  private async checkKey(
    userId: string,
    request: StartGenerationRequest,
    payloadHash: string,
  ): Promise<StartGenerationResponse | undefined> {
    const record = await this.o.operations.read(userId, request.operationKey);
    if (record) {
      if (record.payloadHash !== payloadHash) {
        throw new AppError(
          ErrorCode.OPERATION_KEY_MISMATCH,
          "This operation key was already used for a different request",
        );
      }
      if (record.status === "committed") return resultOf(record);
      // A pending record with nothing in flight is an unresolved recovery conflict.
      throw new AppError(ErrorCode.INTERNAL, "The outcome of this send is not known yet");
    }
    return undefined;
  }

  private assertFresh(request: StartGenerationRequest): void {
    const issued = Date.parse(request.operationIssuedAt);
    const now = this.now().getTime();
    if (
      Number.isNaN(issued) ||
      issued < now - (this.o.operationRetentionMs - DAY_MS) ||
      issued > now + DAY_MS
    ) {
      throw new AppError(
        ErrorCode.OPERATION_EXPIRED,
        "This send is too old to retry; check the conversation and send again",
      );
    }
  }

  private async accept(
    userId: string,
    request: StartGenerationRequest,
    sender: Sender,
  ): Promise<StartGenerationResponse> {
    const payloadHash = SendService.payloadHash(request);
    const known = await this.checkKey(userId, request, payloadHash);
    if (known) return known;
    this.assertFresh(request);

    // Cheap rejections before any provider contact.
    const content = normalizeBody(request.content);
    const conversationId = request.conversationId ?? randomUUID();
    const conversationKey = `${userId}/${conversationId}`;
    this.o.generations.assertAdmission();
    if (request.conversationId) this.o.generations.assertIdle(conversationKey);
    // The browser's (provider, model) pair is untrusted: validate it (INV-18).
    const model = await this.o.catalog.resolve(request.providerId, request.model);
    // Hidden models exist only for admins (Phase 10).
    if (sender.role !== "admin" && this.o.settings?.isHidden(model.providerId, model.id))
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    const provider = this.o.catalog.provider(model.providerId);
    // Prompt-relevant settings are a revision too (contracts §4.1).
    const settingsFor = () =>
      this.o.settings?.resolve(model.providerId, model.id, {
        username: sender.username,
        now: this.now(),
      });

    // Read once per send: every attempt assembles the same skills.
    const skills = (await this.o.skills?.enabled(userId)) ?? new Map<string, SkillDto>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = settingsFor();
      // Step 1–2: authorized snapshot under a short lock, then preflight unlocked.
      const snapshot = request.conversationId
        ? await this.o.store.withLock(userId, conversationId, () =>
            this.readExisting(userId, conversationId),
          )
        : null;
      const prompt = await this.preflight(
        snapshot?.model ?? null,
        content,
        provider,
        model.providerId,
        model.id,
        model.contextTokens,
        resolved,
        skills,
      );
      await this.o.hooks?.beforeRecheck?.();

      // Step 3–4: recheck and commit under the conversation lock.
      const outcome = await this.o.store.withLock(userId, conversationId, async () => {
        const current = request.conversationId
          ? await this.readExisting(userId, conversationId)
          : null;
        if (
          !request.conversationId &&
          (await this.o.store.readUnlocked(userId, conversationId)).kind !== "missing"
        ) {
          throw new AppError(ErrorCode.CONFLICT, "Conversation id collision; retry");
        }
        if ((current?.revision ?? null) !== (snapshot?.revision ?? null)) return "changed" as const;
        if ((settingsFor()?.revision ?? null) !== (resolved?.revision ?? null))
          return "changed" as const;
        const again = await this.checkKey(userId, request, payloadHash);
        if (again) return { response: again, launch: undefined };
        const reservation = this.o.generations.reserve(userId, conversationKey, model.providerId);
        return this.commit(userId, {
          request,
          payloadHash,
          conversationId,
          content,
          provider,
          providerId: model.providerId,
          model: model.id,
          current,
          prompt,
          reservation,
          sampling: resolved?.sampling,
        });
      });
      if (outcome !== "changed") {
        // Completion work (network I/O) starts only after the lock is released.
        outcome.launch?.();
        return outcome.response;
      }
    }
    throw new AppError(
      ErrorCode.CONFLICT,
      "The conversation changed while sending; reload and try again",
    );
  }

  /** Reserved output tokens: the instance setting, else MAX_OUTPUT_TOKENS. */
  private maxOutputTokens(): number {
    return this.o.settings?.get().generation?.maxOutputTokens ?? this.o.maxOutputTokens;
  }

  private async readExisting(userId: string, conversationId: string) {
    const read = await this.o.store.readUnlocked(userId, conversationId);
    if (read.kind === "missing") throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    if (read.kind === "malformed") {
      throw new AppError(
        ErrorCode.CONVERSATION_MALFORMED,
        "This conversation file is malformed and cannot be changed",
      );
    }
    return read.conversation;
  }

  /** Step 2 (no locks held): prompt assembly and context budget, from canonical data only. */
  private async preflight(
    current: ConversationModel | null,
    content: string,
    provider: Provider,
    providerId: string,
    model: string,
    contextTokens: number,
    resolved: ResolvedModelSettings | undefined,
    skills: ReadonlyMap<string, SkillDto>,
  ): Promise<AssembledPrompt> {
    const draft: ConversationModel = current ?? {
      title: NEW_CONVERSATION_TITLE,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      blocks: [],
    };
    const withUser: ConversationModel = {
      ...draft,
      blocks: [...draft.blocks, { type: "user", id: randomUUID(), body: content }],
    };
    const budget = Math.max(0, contextTokens - this.maxOutputTokens());
    const counter = this.o.counterFor
      ? await this.o.counterFor(providerId, model)
      : await counterFor(provider, model, this.o.templateOverheadTokens);
    try {
      return await assemblePrompt(withUser, {
        budget,
        trimStep: this.o.contextTrimStep ?? Math.max(1, Math.floor(budget * 0.25)),
        counter,
        instructions: resolved?.instructions,
        contextBlock: resolved?.contextBlock,
        expandUser: skills.size > 0 ? (body) => expandSkill(body, skills) : undefined,
      });
    } catch (error) {
      if (error instanceof ContextTooLargeError) {
        throw new AppError(
          ErrorCode.CONTEXT_TOO_LARGE,
          "The message is too long for the model's context window",
        );
      }
      throw error;
    }
  }

  /** Step 4, under the conversation lock: record → user block → committed → launch. */
  private async commit(
    userId: string,
    input: {
      request: StartGenerationRequest;
      payloadHash: string;
      conversationId: string;
      content: string;
      provider: Provider;
      providerId: string;
      model: string;
      current: { model: ConversationModel; revision: string } | null;
      prompt: AssembledPrompt;
      reservation: ReturnType<GenerationManager["reserve"]>;
      sampling: Sampling | undefined;
    },
  ): Promise<{ response: StartGenerationResponse; launch: (() => void) | undefined }> {
    const { conversationId, reservation } = input;
    let pending: OperationRecord | undefined;
    try {
      const now = this.now().toISOString();
      const ids = {
        generationId: randomUUID(),
        userMessageId: randomUUID(),
        assistantMessageId: randomUUID(),
      };
      const base: ConversationModel = input.current?.model ?? {
        title: NEW_CONVERSATION_TITLE,
        createdAt: now,
        updatedAt: now,
        blocks: [],
      };
      const next = this.o.store.appendBlocks(base, [
        { type: "user", id: ids.userMessageId, time: now, body: input.content },
      ]);
      const record: OperationRecord = {
        version: 1,
        operationKey: input.request.operationKey,
        payloadHash: input.payloadHash,
        conversationId,
        ...ids,
        beforeHash: input.current?.revision ?? null,
        afterHash: sha256Hex(serializeConversation(next)),
        status: "pending",
        terminalWritten: false,
        issuedAt: input.request.operationIssuedAt,
        createdAt: now,
        committedAt: null,
      };
      await this.o.operations.write(userId, record);
      pending = record;
      await this.o.hooks?.afterPendingRecord?.();
      await this.o.store.writeUnlocked(userId, conversationId, next);
      await this.o.hooks?.afterMarkdownWrite?.();
      await this.o.operations.write(userId, {
        ...record,
        status: "committed",
        committedAt: this.now().toISOString(),
      });
      // Same locked step (contracts §4.1 step 5): a crash from here on is
      // recovered from this checkpoint as an `interrupted` reply.
      await this.o.checkpoints?.write(
        this.o.generations.initialCheckpoint({
          ...ids,
          conversationId,
          identity: {
            userId,
            operationKey: record.operationKey,
            providerId: input.providerId,
            model: input.model,
          },
        }),
      );
      await this.o.hooks?.afterCommit?.();

      const launch = () => {
        this.o.generations.launch(reservation, {
          ...ids,
          conversationId,
          provider: input.provider,
          model: input.model,
          operationKey: record.operationKey,
          messages: input.prompt.messages,
          maxTokens: this.maxOutputTokens(),
          sampling: input.sampling,
          persist: (outcome) =>
            this.persistOutcome(
              userId,
              conversationId,
              input.providerId,
              input.model,
              record,
              outcome,
            ),
        });
      };
      return { response: { conversationId, ...ids }, launch };
    } catch (error) {
      reservation.release();
      this.o.logger.error({ err: error }, "send acceptance failed");
      if (pending) {
        // Decide the record now by hashes, as startup recovery would, so a
        // retry with the same key gets a definite answer. Before Phase 6 a
        // committed-but-unlaunched user block simply stays unanswered.
        await resolvePendingRecord(
          this.o.store.dataPaths,
          this.o.operations,
          userId,
          pending,
          this.now(),
        ).catch(() => undefined);
      }
      throw new AppError(ErrorCode.INTERNAL, "The send could not be completed");
    }
  }

  /**
   * Terminal write (INV-07): the reasoning block (if any) and the assistant
   * block, appended exactly once under the conversation lock. A deleted or
   * malformed conversation discards the write; nothing is resurrected.
   */
  private persistOutcome(
    userId: string,
    conversationId: string,
    providerId: string,
    model: string,
    record: OperationRecord,
    outcome: GenerationOutcome,
  ): Promise<string | null> {
    return this.o.store.withLock(userId, conversationId, async () => {
      const read = await this.o.store.readUnlocked(userId, conversationId);
      const markWritten = () =>
        this.o.operations
          .read(userId, record.operationKey)
          .then((current) =>
            current
              ? this.o.operations.write(userId, { ...current, terminalWritten: true })
              : undefined,
          );
      if (read.kind === "missing") {
        this.o.logger.info(
          { generationId: record.generationId },
          "reply discarded: conversation was deleted",
        );
        await markWritten();
        return null;
      }
      if (read.kind === "malformed") {
        this.o.logger.warn(
          { generationId: record.generationId },
          "reply discarded: conversation file is malformed",
        );
        return null;
      }
      const conversation = read.conversation;
      if (
        conversation.model.blocks.some(
          (block) => block.type === "assistant" && block.id === record.assistantMessageId,
        )
      ) {
        return conversation.revision; // already written
      }
      const blocks: Block[] = [];
      const reasoning = normalizeBody(outcome.reasoning);
      if (reasoning !== "")
        blocks.push({ type: "reasoning", id: record.assistantMessageId, body: reasoning });
      blocks.push({
        type: "assistant",
        id: record.assistantMessageId,
        status: STATUS[outcome.state],
        provider: providerId,
        model,
        time: outcome.finishedAt,
        body: normalizeBody(outcome.content),
      });
      const written = await this.o.store.writeUnlocked(
        userId,
        conversationId,
        this.o.store.appendBlocks(conversation.model, blocks),
      );
      await markWritten();
      return written.revision;
    });
  }
}
