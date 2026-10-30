import { randomUUID } from "node:crypto";
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
import { exchangeOrThrow } from "./mutations.ts";
import { removedUsers, touchesIrregular } from "./turns.ts";
import { expandSystemPrompt, type Sampling, type SettingsStore } from "../admin/settings.ts";
import { prepareExpansion } from "../attachments/expand.ts";
import type { AttachmentMeta, AttachmentStore } from "../attachments/store.ts";
import type { PreferencesStore } from "../storage/preferences.ts";

const DAY_MS = 86_400_000;

interface ModelConfig {
  instructions: string | null;
  context: string | null;
  sampling: Sampling;
  maxTokens: number;
}

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
  /** Admin settings (Phase 10): hidden models, per-model prompts and sampling, limits. */
  settings?: SettingsStore;
  /** True once an account is closing: its late terminal writes are skipped (contracts §6). */
  isClosing?: (userId: string) => Promise<boolean>;
  /** Attachments (Phase 12): ownership, pending state, linking and prompt expansion. */
  attachments?: AttachmentStore;
  /** `historyImages` is a prompt-relevant preference (§4.1). */
  preferences?: PreferencesStore;
  attachmentLimits?: {
    maxPerMessage: number;
    maxInlineTextBytes: number;
    mediaTokenReserve: number;
    maxPromptMediaParts: number;
  };
}

const DEFAULT_ATTACHMENT_LIMITS = {
  maxPerMessage: 10,
  maxInlineTextBytes: 100_000,
  mediaTokenReserve: 0,
  maxPromptMediaParts: 8,
};

/** Regenerating an existing user turn (Phase 13a, contracts §4.2). */
export interface RegenerateRequest {
  conversationId: string;
  messageId: string;
  providerId: string;
  model: string;
  expectedRevision: string;
  operationKey: string;
  operationIssuedAt: string;
}

/** Who is sending: role decides hidden-model access; username fills {{username}}. */
export interface Sender {
  role: "user" | "admin";
  username: string;
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
    request: Pick<
      StartGenerationRequest,
      "conversationId" | "providerId" | "model" | "content" | "attachmentIds"
    >,
  ): string {
    return sha256Hex(
      JSON.stringify({
        conversationId: request.conversationId ?? null,
        providerId: request.providerId,
        model: request.model,
        content: normalizeBody(request.content),
        // Absent when empty, so records from before Phase 12 keep their hash.
        ...(request.attachmentIds?.length ? { attachmentIds: request.attachmentIds } : {}),
      }),
    );
  }

  private get limits() {
    return this.o.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
  }

  /** Each id must be this user's and still pending (unknown and foreign look the same). */
  private async pendingAttachments(
    userId: string,
    ids: readonly string[],
  ): Promise<AttachmentMeta[]> {
    if (ids.length === 0) return [];
    if (!this.o.attachments || ids.length > this.limits.maxPerMessage) {
      throw new AppError(
        ErrorCode.VALIDATION,
        `A message can carry at most ${String(this.limits.maxPerMessage)} files`,
      );
    }
    const metas: AttachmentMeta[] = [];
    for (const id of ids) {
      const meta = await this.o.attachments.get(userId, id);
      if (!meta) throw new AppError(ErrorCode.NOT_FOUND, "An attached file is no longer available");
      if (meta.messageId !== null)
        throw new AppError(ErrorCode.CONFLICT, "An attached file was already sent in a message");
      if (meta.saved)
        throw new AppError(ErrorCode.CONFLICT, "Files from the Library can't be attached yet");
      metas.push(meta);
    }
    return metas;
  }

  private async historyImages(userId: string): Promise<"include" | "omit"> {
    return (await this.o.preferences?.get(userId))?.historyImages ?? "include";
  }

  async send(
    userId: string,
    request: StartGenerationRequest,
    sender: Sender = { role: "user", username: "" },
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
    request: Pick<StartGenerationRequest, "operationKey">,
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

  private assertFresh(request: Pick<StartGenerationRequest, "operationIssuedAt">): void {
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
    // A model hidden by an admin does not exist for anyone else (Phase 10).
    if (sender.role !== "admin" && this.o.settings?.isHidden(model.providerId, model.id)) {
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    }
    const provider = this.o.catalog.provider(model.providerId);
    const attachmentIds = request.attachmentIds ?? [];
    const attached = await this.pendingAttachments(userId, attachmentIds);
    // Images and audio only reach a server-verified model with that modality (INV-44).
    for (const kind of ["image", "audio"] as const) {
      if (
        attached.some((meta) => meta.kind === kind) &&
        !model.capabilities.inputModalities.includes(kind)
      ) {
        throw new AppError(
          ErrorCode.MODEL_CAPABILITY_UNSUPPORTED,
          kind === "image"
            ? "The selected model can't view images; choose a model with vision"
            : "The selected model can't listen to audio; choose a model with audio input",
        );
      }
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      // Prompt-relevant settings revision (§4.1): rechecked under the lock below.
      const settingsRevision = this.o.settings?.revision ?? null;
      const config = this.modelConfig(model.providerId, model.id, sender);
      const historyImages = await this.historyImages(userId);
      // Step 1–2: authorized snapshot under a short lock, then preflight unlocked.
      const snapshot = request.conversationId
        ? await this.o.store.withLock(userId, conversationId, () =>
            this.readExisting(userId, conversationId),
          )
        : null;
      const prompt = await this.preflight(userId, snapshot?.model ?? null, content, attachmentIds, {
        provider,
        providerId: model.providerId,
        model: model.id,
        contextTokens: model.contextTokens,
        modalities: model.capabilities.inputModalities,
        historyImages,
        config,
      });
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
        if ((this.o.settings?.revision ?? null) !== settingsRevision) return "changed" as const;
        if ((await this.historyImages(userId)) !== historyImages) return "changed" as const;
        // Attachment locks follow the conversation lock (contracts §2 global order).
        const commitWith = async () => {
          const again = await this.checkKey(userId, request, payloadHash);
          if (again) return { response: again, launch: undefined };
          const metas = await this.pendingAttachments(userId, attachmentIds);
          const reservation = this.o.generations.reserve(userId, conversationKey, model.providerId);
          return this.commit(userId, {
            request,
            payloadHash,
            conversationId,
            content,
            attachments: metas,
            provider,
            providerId: model.providerId,
            model: model.id,
            current,
            prompt,
            reservation,
            config,
          });
        };
        return this.o.attachments && attachmentIds.length > 0
          ? this.o.attachments.withLocks(userId, attachmentIds, commitWith)
          : commitWith();
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

  /**
   * Regenerate user turn `messageId` (contracts §4.2): one fresh provider
   * contact and the replacement prompt are checked before anything is
   * removed; then, under the lock and at `expectedRevision`, every block
   * after that user block is dropped and a generation starts with fresh ids.
   * The user block is never duplicated. Idempotent by operation key.
   */
  async regenerate(
    userId: string,
    request: RegenerateRequest,
    sender: Sender = { role: "user", username: "" },
  ): Promise<StartGenerationResponse> {
    const flightKey = `${userId}:${request.operationKey}`;
    for (;;) {
      const inflight = this.inflight.get(flightKey);
      if (!inflight) break;
      await inflight.catch(() => undefined);
    }
    const work = this.acceptRegeneration(userId, request, sender);
    this.inflight.set(flightKey, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(flightKey) === work) this.inflight.delete(flightKey);
    }
  }

  private async acceptRegeneration(
    userId: string,
    request: RegenerateRequest,
    sender: Sender,
  ): Promise<StartGenerationResponse> {
    const { conversationId, messageId } = request;
    const payloadHash = sha256Hex(
      JSON.stringify({
        regenerate: messageId,
        conversationId,
        providerId: request.providerId,
        model: request.model,
        expectedRevision: request.expectedRevision,
      }),
    );
    const keyed = request;
    const known = await this.checkKey(userId, keyed, payloadHash);
    if (known) return known;
    this.assertFresh(keyed);
    const conversationKey = `${userId}/${conversationId}`;
    this.o.generations.assertAdmission();
    this.o.generations.assertIdle(conversationKey);
    // A fresh provider contact before anything is truncated (§4.1 step 2).
    await this.o.catalog.contact(request.providerId);
    const model = await this.o.catalog.resolve(request.providerId, request.model);
    if (sender.role !== "admin" && this.o.settings?.isHidden(model.providerId, model.id)) {
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    }
    const provider = this.o.catalog.provider(model.providerId);
    const settingsRevision = this.o.settings?.revision ?? null;
    const config = this.modelConfig(model.providerId, model.id, sender);
    const historyImages = await this.historyImages(userId);

    const snapshot = await this.o.store.withLock(userId, conversationId, async () => {
      const current = await this.readExisting(userId, conversationId);
      if (current.revision !== request.expectedRevision)
        throw new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
      return current;
    });
    const { layout, exchange } = exchangeOrThrow(snapshot.model, messageId);
    if (touchesIrregular(layout, exchange.start, snapshot.model.blocks.length)) {
      throw new AppError(
        ErrorCode.VALIDATION,
        "This part of the conversation has replies without a matching message and can't be changed",
      );
    }
    const attachmentIds = exchange.user.attachments ?? [];
    const store = this.o.attachments;
    const metas = store ? await Promise.all(attachmentIds.map((id) => store.get(userId, id))) : [];
    for (const kind of ["image", "audio"] as const) {
      if (
        metas.some((meta) => meta?.kind === kind) &&
        !model.capabilities.inputModalities.includes(kind)
      ) {
        throw new AppError(
          ErrorCode.MODEL_CAPABILITY_UNSUPPORTED,
          kind === "image"
            ? "The selected model can't view images; choose a model with vision"
            : "The selected model can't listen to audio; choose a model with audio input",
        );
      }
    }
    const truncated: ConversationModel = {
      ...snapshot.model,
      blocks: snapshot.model.blocks.slice(0, exchange.start + 1),
    };
    const prompt = await this.preflight(
      userId,
      { ...snapshot.model, blocks: snapshot.model.blocks.slice(0, exchange.start) },
      exchange.user.body,
      attachmentIds,
      {
        provider,
        providerId: model.providerId,
        model: model.id,
        contextTokens: model.contextTokens,
        modalities: model.capabilities.inputModalities,
        historyImages,
        config,
      },
    );
    await this.o.hooks?.beforeRecheck?.();

    const outcome = await this.o.store.withLock(userId, conversationId, async () => {
      const current = await this.readExisting(userId, conversationId);
      if (
        current.revision !== snapshot.revision ||
        (this.o.settings?.revision ?? null) !== settingsRevision ||
        (await this.historyImages(userId)) !== historyImages
      ) {
        throw new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
      }
      const again = await this.checkKey(userId, keyed, payloadHash);
      if (again) return { response: again, launch: undefined, removed: [] };
      const reservation = this.o.generations.reserve(userId, conversationKey, model.providerId);
      const committed = await this.commit(userId, {
        request: keyed,
        payloadHash,
        conversationId,
        content: exchange.user.body,
        attachments: [],
        provider,
        providerId: model.providerId,
        model: model.id,
        current,
        prompt,
        reservation,
        config,
        regenerate: { userMessageId: messageId, truncated },
      });
      return { ...committed, removed: removedUsers(current.model.blocks, truncated.blocks) };
    });
    outcome.launch?.();
    // Files of the removed later turns go after the canonical write (§7).
    const dropped = outcome.removed.flatMap((block) => block.attachments ?? []);
    if (dropped.length > 0) await this.o.attachments?.deleteIds(userId, conversationId, dropped);
    return outcome.response;
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

  /** Per-model prompt, sampling and output cap from the admin settings (Phase 10). */
  private modelConfig(providerId: string, modelId: string, sender: Sender): ModelConfig {
    const settings = this.o.settings?.get();
    const entry = this.o.settings?.forModel(providerId, modelId);
    const expanded = expandSystemPrompt(entry?.systemPrompt ?? null, {
      username: sender.username,
      now: this.now(),
      timeZone: settings?.timeZone ?? "UTC",
    });
    return {
      instructions: expanded.system,
      context: expanded.context,
      sampling: entry?.sampling ?? {},
      maxTokens: Math.min(this.o.maxOutputTokens, settings?.maxOutputTokens ?? Infinity),
    };
  }

  /** Step 2 (no locks held): prompt assembly and context budget, from canonical data only. */
  private async preflight(
    userId: string,
    current: ConversationModel | null,
    content: string,
    attachmentIds: string[],
    target: {
      provider: Provider;
      providerId: string;
      model: string;
      contextTokens: number;
      modalities: readonly ("text" | "image" | "audio")[];
      historyImages: "include" | "omit";
      config: ModelConfig;
    },
  ): Promise<AssembledPrompt> {
    const { provider, providerId, model, contextTokens, config } = target;
    const draft: ConversationModel = current ?? {
      title: NEW_CONVERSATION_TITLE,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      blocks: [],
    };
    const withUser: ConversationModel = {
      ...draft,
      blocks: [
        ...draft.blocks,
        {
          type: "user",
          id: randomUUID(),
          body: content,
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
        },
      ],
    };
    const budget = Math.max(0, contextTokens - config.maxTokens);
    const counter = this.o.counterFor
      ? await this.o.counterFor(providerId, model)
      : await counterFor(
          provider,
          model,
          this.o.templateOverheadTokens,
          this.limits.mediaTokenReserve,
        );
    const expand = this.o.attachments
      ? await prepareExpansion(withUser, {
          store: this.o.attachments,
          userId,
          modalities: target.modalities,
          historyImages: target.historyImages,
          maxInlineTextBytes: this.limits.maxInlineTextBytes,
          maxPromptMediaParts: this.limits.maxPromptMediaParts,
          logger: this.o.logger,
        })
      : undefined;
    try {
      return await assemblePrompt(withUser, {
        budget,
        trimStep: this.o.contextTrimStep ?? Math.max(1, Math.floor(budget * 0.25)),
        counter,
        instructions: config.instructions,
        context: config.context,
        ...(expand ? { expand } : {}),
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
      request: Pick<StartGenerationRequest, "operationKey" | "operationIssuedAt">;
      payloadHash: string;
      conversationId: string;
      content: string;
      attachments: AttachmentMeta[];
      provider: Provider;
      providerId: string;
      model: string;
      current: { model: ConversationModel; revision: string } | null;
      prompt: AssembledPrompt;
      reservation: ReturnType<GenerationManager["reserve"]>;
      config: ModelConfig;
      /** Regeneration (§4.2): keep this user block, drop everything after it. */
      regenerate?: { userMessageId: string; truncated: ConversationModel };
    },
  ): Promise<{ response: StartGenerationResponse; launch: (() => void) | undefined }> {
    const { conversationId, reservation } = input;
    let pending: OperationRecord | undefined;
    try {
      const now = this.now().toISOString();
      const ids = {
        generationId: randomUUID(),
        userMessageId: input.regenerate?.userMessageId ?? randomUUID(),
        assistantMessageId: randomUUID(),
      };
      const base: ConversationModel = input.current?.model ?? {
        title: NEW_CONVERSATION_TITLE,
        createdAt: now,
        updatedAt: now,
        blocks: [],
      };
      const attachmentIds = input.attachments.map((meta) => meta.id);
      const next = input.regenerate
        ? { ...input.regenerate.truncated, updatedAt: now }
        : this.o.store.appendBlocks(base, [
            {
              type: "user",
              id: ids.userMessageId,
              time: now,
              body: input.content,
              ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
            },
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
      // Linked after the Markdown: a crash in between is repaired by startup reconciliation.
      if (input.attachments.length > 0)
        await this.o.attachments?.linkUnlocked(
          userId,
          input.attachments,
          conversationId,
          ids.userMessageId,
        );
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
          maxTokens: input.config.maxTokens,
          sampling: input.config.sampling,
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
      // Rechecked under the lock: a closing account's late writes are skipped.
      if (await this.o.isClosing?.(userId)) {
        this.o.logger.info(
          { generationId: record.generationId },
          "reply discarded: account closing",
        );
        return null;
      }
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
