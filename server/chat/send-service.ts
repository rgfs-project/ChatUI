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
import { attachmentRefs, truncateAfter } from "./turns.ts";
import type { RegenerateRequest } from "@shared/conversations";
import type { ModelDto } from "@shared/generations";
import type { AttachmentMeta, AttachmentStore } from "../storage/attachments.ts";
import type { PreferencesStore } from "../storage/preferences.ts";
import type { MediaPart, UserAttachments } from "./prompt.ts";
import type { MemoryConfig } from "../config.ts";
import {
  memorySection,
  memorySetRevision,
  selectForPrompt,
  type MemorySnapshotEntry,
  type MemoryStore,
} from "../storage/memories.ts";
import type { ToolSession } from "../generations/manager.ts";
import type { ProposalRecord } from "../storage/proposals.ts";
import { continuationCost, type ProposalService } from "./proposals.ts";
import { MEMORY_TOOLS } from "./memory-tools.ts";

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
  /** After the attachments are linked, before the record is committed. */
  afterAttachmentLink?: () => void | Promise<void>;
  /** After the committed record and the `running` checkpoint (crash-before-launch tests). */
  afterCommit?: () => void | Promise<void>;
  /** Test hook between the unlocked preflight and the locked recheck. */
  beforeRecheck?: () => void | Promise<void>;
  /** After the terminal assistant write, before the proposals are written. */
  afterAssistantWrite?: () => void | Promise<void>;
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
  /** Attachments (Phase 12): linked on send, expanded into the prompt. */
  attachments?: AttachmentStore;
  /** `historyImages` is a prompt-relevant preference (contracts §4.1). */
  preferences?: PreferencesStore;
  /** Approved memories (Phase 13b): included in the system instructions within their budget. */
  memories?: MemoryStore;
  /** Proposal-only memory tools (Phase 13b), offered to tool-capable models. */
  proposals?: ProposalService;
  memoryConfig?: MemoryConfig;
}

/** The approved notes a prompt includes and the whole set's revision (contracts §4.1 step 2). */
interface MemoryContext {
  revision: string | null;
  section: string | undefined;
  snapshot: MemorySnapshotEntry[];
}

/** What step 2 hands to the commit: the prompt plus the tool budget facts. */
interface Preflight {
  prompt: AssembledPrompt;
  counter: TokenCounter;
  contextTokens: number;
  /** Proposal tools are offered (a verified tool-capable model). */
  tools: boolean;
  memory: MemoryContext;
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
        // Only present when sent, so earlier records keep their hashes.
        ...(request.attachmentIds?.length ? { attachmentIds: request.attachmentIds } : {}),
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
    // Hidden models exist only for admins (Phase 10).
    if (sender.role !== "admin" && this.o.settings?.isHidden(model.providerId, model.id))
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    const provider = this.o.catalog.provider(model.providerId);
    // Attachments (contracts §7): owned and pending in the step-1 snapshot, and
    // a model that can read them (INV-44), before anything is persisted.
    const attachmentIds = request.attachmentIds ?? [];
    const store = this.o.attachments;
    if (attachmentIds.length > 0) {
      if (!store) throw new AppError(ErrorCode.VALIDATION, "Attachments are not available");
      const max = store.effective().maxPerMessage;
      if (attachmentIds.length > max)
        throw new AppError(
          ErrorCode.VALIDATION,
          `A message can have at most ${String(max)} attachments`,
        );
      this.assertCapable(await store.requirePending(userId, attachmentIds), model);
    }
    // Prompt-relevant settings are a revision too (contracts §4.1).
    const settingsFor = () =>
      this.o.settings?.resolve(model.providerId, model.id, {
        username: sender.username,
        now: this.now(),
      });

    // Read once per send: every attempt assembles the same skills.
    const skills = (await this.o.skills?.enabled(userId)) ?? new Map<string, SkillDto>();
    const historyMedia = async () =>
      (await this.o.preferences?.get(userId))?.historyImages ?? "include";
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = settingsFor();
      const mediaPolicy = await historyMedia();
      const memory = await this.memoryContext(userId, model);
      // Step 1–2: authorized snapshot under a short lock, then preflight unlocked.
      const snapshot = request.conversationId
        ? await this.o.store.withLock(userId, conversationId, () =>
            this.readExisting(userId, conversationId),
          )
        : null;
      const prompt = await this.preflight(
        this.withNewUser(snapshot?.model ?? null, content, attachmentIds),
        provider,
        model,
        resolved,
        skills,
        await this.expansion(userId, snapshot?.model ?? null, attachmentIds, model, mediaPolicy),
        memory,
      );
      await this.o.hooks?.beforeRecheck?.();

      // Step 3–4: recheck and commit under the conversation lock, then the
      // attachment locks in ascending id order (contracts §2).
      const outcome = await this.o.store.withLock(userId, conversationId, () =>
        this.withAttachmentLocks(userId, attachmentIds, async () => {
          const current = request.conversationId
            ? await this.readExisting(userId, conversationId)
            : null;
          if (
            !request.conversationId &&
            (await this.o.store.readUnlocked(userId, conversationId)).kind !== "missing"
          ) {
            throw new AppError(ErrorCode.CONFLICT, "Conversation id collision; retry");
          }
          if ((current?.revision ?? null) !== (snapshot?.revision ?? null))
            return "changed" as const;
          if ((settingsFor()?.revision ?? null) !== (resolved?.revision ?? null))
            return "changed" as const;
          if ((await historyMedia()) !== mediaPolicy) return "changed" as const;
          if ((await this.memoryRevision(userId)) !== memory.revision) return "changed" as const;
          const again = await this.checkKey(userId, request, payloadHash);
          if (again) return { response: again, launch: undefined };
          const metas =
            store && attachmentIds.length > 0
              ? await store.requirePending(userId, attachmentIds)
              : [];
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
            attachments: metas,
          });
        }),
      );
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

  static regeneratePayloadHash(request: RegenerateRequest & { conversationId: string }): string {
    return sha256Hex(
      JSON.stringify({
        kind: "regenerate",
        conversationId: request.conversationId,
        userMessageId: request.userMessageId,
        providerId: request.providerId,
        model: request.model,
        expectedRevision: request.expectedRevision,
      }),
    );
  }

  /**
   * Regenerate user turn k (contracts §4.2, §4.1): keep the user block, remove
   * every block after it and start a generation with fresh generation and
   * assistant ids; no duplicate user block. The replacement prompt is
   * preflighted, including one fresh provider contact, before anything is
   * truncated; the truncation and the reservation commit under the lock with
   * an operation record, so a lost 202 is resolved by the same key.
   */
  async regenerate(
    userId: string,
    conversationId: string,
    request: RegenerateRequest,
    sender: Sender = { username: "", role: "user" },
  ): Promise<StartGenerationResponse> {
    const flightKey = `${userId}:${request.operationKey}`;
    for (;;) {
      const inflight = this.inflight.get(flightKey);
      if (!inflight) break;
      await inflight.catch(() => undefined);
    }
    const work = this.acceptRegenerate(userId, conversationId, request, sender);
    this.inflight.set(flightKey, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(flightKey) === work) this.inflight.delete(flightKey);
    }
  }

  private truncation(current: ConversationModel, userMessageId: string) {
    const result = truncateAfter(current, userMessageId);
    if ("kind" in result) {
      if (result.kind === "not_found") throw new AppError(ErrorCode.NOT_FOUND, "Message not found");
      throw new AppError(
        ErrorCode.VALIDATION,
        "This part of the conversation can't be regenerated (it isn't a regular exchange)",
      );
    }
    return result;
  }

  private async acceptRegenerate(
    userId: string,
    conversationId: string,
    request: RegenerateRequest,
    sender: Sender,
  ): Promise<StartGenerationResponse> {
    const payloadHash = SendService.regeneratePayloadHash({ ...request, conversationId });
    const known = await this.checkKey(userId, request, payloadHash);
    if (known) return known;
    this.assertFresh(request);
    const conversationKey = `${userId}/${conversationId}`;
    this.o.generations.assertAdmission();
    this.o.generations.assertIdle(conversationKey);
    const model = await this.o.catalog.resolve(request.providerId, request.model);
    if (sender.role !== "admin" && this.o.settings?.isHidden(model.providerId, model.id))
      throw new AppError(ErrorCode.MODEL_NOT_FOUND, "The selected model is not available");
    const provider = this.o.catalog.provider(model.providerId);
    const settingsFor = () =>
      this.o.settings?.resolve(model.providerId, model.id, {
        username: sender.username,
        now: this.now(),
      });
    const skills = (await this.o.skills?.enabled(userId)) ?? new Map<string, SkillDto>();
    const historyMedia = async () =>
      (await this.o.preferences?.get(userId))?.historyImages ?? "include";

    for (let attempt = 0; attempt < 2; attempt++) {
      const resolved = settingsFor();
      const mediaPolicy = await historyMedia();
      const memory = await this.memoryContext(userId, model);
      // Step 1: authorized snapshot, the caller's revision, a regular target.
      const snapshot = await this.o.store.withLock(userId, conversationId, () =>
        this.readExisting(userId, conversationId),
      );
      if (snapshot.revision !== request.expectedRevision)
        throw new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
      const { model: truncated } = this.truncation(snapshot.model, request.userMessageId);
      const target = truncated.blocks.at(-1);
      const targetIds = target?.type === "user" ? (target.attachments ?? []) : [];
      const attachmentStore = this.o.attachments;
      if (attachmentStore && targetIds.length > 0) {
        const metas = (
          await Promise.all(targetIds.map((id) => attachmentStore.readMeta(userId, id)))
        ).filter((m): m is AttachmentMeta => m !== null);
        this.assertCapable(metas, model);
      }
      // Step 2 (no locks): one fresh provider contact, then the replacement prompt.
      await this.o.catalog.contact(model.providerId);
      const prompt = await this.preflight(
        truncated,
        provider,
        model,
        resolved,
        skills,
        await this.expansion(userId, truncated, [], model, mediaPolicy),
        memory,
      );
      await this.o.hooks?.beforeRecheck?.();

      // Step 3–4: recheck under the locks, then truncate and commit.
      const outcome = await this.o.store.withLock(userId, conversationId, async () => {
        const current = await this.readExisting(userId, conversationId);
        if (current.revision !== snapshot.revision) return "changed" as const;
        if ((settingsFor()?.revision ?? null) !== (resolved?.revision ?? null))
          return "changed" as const;
        if ((await historyMedia()) !== mediaPolicy) return "changed" as const;
        if ((await this.memoryRevision(userId)) !== memory.revision) return "changed" as const;
        const again = await this.checkKey(userId, request, payloadHash);
        if (again) return { response: again, launch: undefined };
        const truncation = this.truncation(current.model, request.userMessageId);
        const reservation = this.o.generations.reserve(userId, conversationKey, model.providerId);
        return this.commit(userId, {
          request,
          payloadHash,
          conversationId,
          content: "",
          provider,
          providerId: model.providerId,
          model: model.id,
          current,
          prompt,
          reservation,
          sampling: resolved?.sampling,
          attachments: [],
          regenerate: {
            userMessageId: request.userMessageId,
            next: truncation.model,
            removed: truncation.removed,
          },
        });
      });
      if (outcome !== "changed") {
        outcome.launch?.();
        return outcome.response;
      }
    }
    throw new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
  }

  private withAttachmentLocks<T>(
    userId: string,
    ids: readonly string[],
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.o.attachments && ids.length > 0
      ? this.o.attachments.withLocks(userId, ids, fn)
      : fn();
  }

  /** INV-44: images and audio only for a model the server verified for that modality. */
  private assertCapable(metas: readonly AttachmentMeta[], model: ModelDto): void {
    const accepts = model.capabilities.inputModalities;
    for (const [kind, noun] of [
      ["image", "images"],
      ["audio", "audio"],
    ] as const) {
      if (metas.some((m) => m.kind === kind) && !accepts.includes(kind))
        throw new AppError(
          ErrorCode.MODEL_CAPABILITY_UNSUPPORTED,
          `The selected model can't read ${noun}. Choose a model that supports ${noun} or remove the attachment.`,
          { modality: kind },
        );
    }
  }

  /**
   * Step 2 attachment expansion (no locks held): text attachments become
   * fenced blocks labeled with the filename, cut at the inline limit with a
   * visible marker (in the prompt only); images and audio become typed parts
   * when the model accepts that modality. Earlier turns' media follow the
   * `historyImages` preference; media the model can't read is replaced by a
   * short note. A missing attachment is skipped with a warning (never malformed).
   */
  private async expansion(
    userId: string,
    current: ConversationModel | null,
    newIds: readonly string[],
    model: ModelDto,
    historyMedia: "include" | "omit",
  ): Promise<((ids: readonly string[], newest: boolean) => UserAttachments) | undefined> {
    const store = this.o.attachments;
    if (!store) return undefined;
    const ids = new Set(newIds);
    for (const block of current?.blocks ?? [])
      if (block.type === "user") for (const id of block.attachments ?? []) ids.add(id);
    if (ids.size === 0) return undefined;
    const limit = store.effective().textInlineBytes;
    const loaded = new Map<string, { meta: AttachmentMeta; text?: string } | null>();
    for (const id of ids) {
      const meta = await store.readMeta(userId, id);
      if (!meta) {
        this.o.logger.warn({ attachmentId: id }, "attachment missing; skipped in the prompt");
        loaded.set(id, null);
        continue;
      }
      if (meta.kind !== "text") {
        loaded.set(id, { meta });
        continue;
      }
      const head = await store.readHead(userId, id, limit);
      if (head === null) {
        this.o.logger.warn({ attachmentId: id }, "attachment missing; skipped in the prompt");
        loaded.set(id, null);
        continue;
      }
      loaded.set(id, { meta, text: fencedText(meta, head, limit) });
    }
    const accepts = model.capabilities.inputModalities;
    return (blockIds, newest) => {
      const out: UserAttachments = { text: [], media: [] };
      for (const id of blockIds) {
        const entry = loaded.get(id);
        if (!entry) continue;
        const { meta } = entry;
        if (entry.text !== undefined) {
          out.text.push(entry.text);
          continue;
        }
        const kind = meta.kind === "image" ? "image" : "audio";
        if (accepts.includes(kind) && (newest || historyMedia === "include")) {
          const part: MediaPart = { type: kind, attachmentId: meta.id, mediaType: meta.mediaType };
          out.media.push(part);
        } else {
          out.text.push(
            `[${kind === "image" ? "Image" : "Audio"} from an earlier message not included: ${meta.filename}]`,
          );
        }
      }
      return out;
    };
  }

  private async stageProposals(
    userId: string,
    conversationId: string,
    model: ConversationModel,
    staged: readonly ProposalRecord[],
  ): Promise<void> {
    if (!this.o.proposals || staged.length === 0) return;
    await this.o.proposals.persistStaged(userId, conversationId, model, staged);
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

  /** The prompt model of a send: the snapshot plus the new user message. */
  private withNewUser(
    current: ConversationModel | null,
    content: string,
    attachmentIds: readonly string[],
  ): ConversationModel {
    const draft: ConversationModel = current ?? {
      title: NEW_CONVERSATION_TITLE,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      blocks: [],
    };
    return {
      ...draft,
      blocks: [
        ...draft.blocks,
        {
          type: "user",
          id: randomUUID(),
          body: content,
          ...(attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
        },
      ],
    };
  }

  /** Whether proposal tools are offered to this model (server-verified capability, §4.3). */
  private offersTools(model: ModelDto): boolean {
    return model.capabilities.tools && this.o.proposals !== undefined;
  }

  private memoryShare(model: ModelDto): number {
    const configured = this.o.memoryConfig?.promptBudgetBytes ?? 0;
    // A bounded share of the context: at most a quarter of the prompt budget
    // (bytes are a pessimistic stand-in for tokens).
    const budget = Math.max(0, model.contextTokens - this.maxOutputTokens());
    return Math.min(configured, Math.floor(budget * 0.25));
  }

  /** The approved-memory revision (a prompt-relevant revision, §4.1 step 3). */
  private async memoryRevision(userId: string): Promise<string | null> {
    if (!this.o.memories) return null;
    return memorySetRevision((await this.o.memories.list(userId)).notes);
  }

  /** Step 2: the approved notes this prompt includes, whole, in deterministic order (§12). */
  private async memoryContext(userId: string, model: ModelDto): Promise<MemoryContext> {
    if (!this.o.memories) return { revision: null, section: undefined, snapshot: [] };
    const { notes } = await this.o.memories.list(userId);
    const { included } = selectForPrompt(notes, this.memoryShare(model));
    return {
      revision: memorySetRevision(notes),
      section: memorySection(included),
      snapshot: included.map((n) => ({ id: n.id, name: n.name, revision: n.revision })),
    };
  }

  /** Step 2 (no locks held): prompt assembly and budget for a model ending in its newest user message. */
  private async preflight(
    withUser: ConversationModel,
    provider: Provider,
    target: ModelDto,
    resolved: ResolvedModelSettings | undefined,
    skills: ReadonlyMap<string, SkillDto>,
    attachmentsOf: ((ids: readonly string[], newest: boolean) => UserAttachments) | undefined,
    memory: MemoryContext,
  ): Promise<Preflight> {
    const { providerId, id: model, contextTokens } = target;
    const counter = this.o.counterFor
      ? await this.o.counterFor(providerId, model)
      : await counterFor(
          provider,
          model,
          this.o.templateOverheadTokens,
          this.o.attachments?.mediaTokenReserve ?? 0,
        );
    const tools = this.offersTools(target);
    // Offered tool schemas and the continuation's call/result messages are
    // reserved in the budget (contracts §4 item 5, §4.3).
    const toolReserve = tools
      ? (await counter.countGroup([{ role: "system", content: JSON.stringify(MEMORY_TOOLS) }])) +
        (this.o.memoryConfig?.continuationTokenReserve ?? 0)
      : 0;
    const budget = Math.max(0, contextTokens - this.maxOutputTokens() - toolReserve);
    // Approved memories follow the per-model system prompt; no template
    // expansion happens inside them (contracts §4 item 3).
    const instructions =
      [resolved?.instructions, memory.section]
        .filter((t) => t !== undefined && t !== "")
        .join("\n\n") || undefined;
    try {
      const prompt = await assemblePrompt(withUser, {
        budget,
        trimStep: this.o.contextTrimStep ?? Math.max(1, Math.floor(budget * 0.25)),
        counter,
        instructions,
        contextBlock: resolved?.contextBlock,
        expandUser: skills.size > 0 ? (body) => expandSkill(body, skills) : undefined,
        attachmentsOf,
      });
      return { prompt, counter, contextTokens, tools, memory };
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
      provider: Provider;
      providerId: string;
      model: string;
      current: { model: ConversationModel; revision: string } | null;
      prompt: Preflight;
      reservation: ReturnType<GenerationManager["reserve"]>;
      sampling: Sampling | undefined;
      /** Pending attachments, rechecked under their locks; linked in this commit. */
      attachments: readonly AttachmentMeta[];
      /** Regeneration (contracts §4.2): the existing user block and the truncated file. */
      regenerate?: { userMessageId: string; next: ConversationModel; removed: readonly Block[] };
    },
  ): Promise<{ response: StartGenerationResponse; launch: (() => void) | undefined }> {
    const { conversationId, reservation } = input;
    let pending: OperationRecord | undefined;
    try {
      const now = this.now().toISOString();
      const ids = {
        generationId: randomUUID(),
        // A regeneration answers the existing user block: no duplicate is written.
        userMessageId: input.regenerate?.userMessageId ?? randomUUID(),
        assistantMessageId: randomUUID(),
      };
      const base: ConversationModel = input.current?.model ?? {
        title: NEW_CONVERSATION_TITLE,
        createdAt: now,
        updatedAt: now,
        blocks: [],
      };
      const next = input.regenerate
        ? { ...input.regenerate.next, updatedAt: now }
        : this.o.store.appendBlocks(base, [
            {
              type: "user",
              id: ids.userMessageId,
              ...(input.attachments.length > 0
                ? { attachments: input.attachments.map((meta) => meta.id) }
                : {}),
              time: now,
              body: input.content,
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
      // Linked inside the acceptance commit; a crash before this point is
      // repaired by the startup reconciliation (recovery step 7).
      if (input.attachments.length > 0)
        await this.o.attachments?.link(
          userId,
          input.attachments,
          conversationId,
          ids.userMessageId,
        );
      await this.o.hooks?.afterAttachmentLink?.();
      // Regeneration removed the old reply: its pending proposals are invalid (§4.3).
      if (input.regenerate) await this.o.proposals?.invalidateStale(userId, conversationId, next);
      // Attachments of removed turns go only after the canonical write (§4.2).
      if (input.regenerate)
        await this.o.attachments
          ?.deleteLinked(userId, conversationId, attachmentRefs(input.regenerate.removed))
          .catch((error: unknown) => {
            this.o.logger.warn({ err: error }, "removing truncated attachments failed");
          });
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
          memorySnapshot: input.prompt.memory.snapshot,
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
          messages: input.prompt.prompt.messages,
          tools: this.toolSession(userId, conversationId, ids, input),
          memorySnapshot: input.prompt.memory.snapshot,
          loadMedia: (part) =>
            this.o.attachments?.readBlob(userId, part.attachmentId) ?? Promise.resolve(null),
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

  /** The proposal tools for one accepted generation, when the model is tool-capable. */
  private toolSession(
    userId: string,
    conversationId: string,
    ids: { generationId: string; userMessageId: string; assistantMessageId: string },
    input: { providerId: string; model: string; prompt: Preflight },
  ): ToolSession | undefined {
    const proposals = this.o.proposals;
    if (!proposals || !input.prompt.tools) return undefined;
    const { prompt, counter, contextTokens, memory } = input.prompt;
    return proposals.session({
      userId,
      conversationId,
      ...ids,
      providerId: input.providerId,
      model: input.model,
      snapshot: memory.snapshot,
      // The continuation near the context limit is skipped, never overflowing (§4.3).
      fits: async (continuation, maxTokens) =>
        prompt.promptTokens + (await continuationCost(counter, continuation)) + maxTokens <=
        contextTokens,
    });
  }

  /**
   * Terminal write (INV-07): the reasoning block (if any) and the assistant
   * block, appended exactly once under the conversation lock. A deleted or
   * malformed conversation discards the write; nothing is resurrected. Then,
   * still under the lock, the staged proposals of a complete reply (§4.3).
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
      const stage = (model: ConversationModel) =>
        outcome.state === "completed"
          ? this.stageProposals(userId, conversationId, model, outcome.proposals)
          : Promise.resolve();
      if (
        conversation.model.blocks.some(
          (block) => block.type === "assistant" && block.id === record.assistantMessageId,
        )
      ) {
        await stage(conversation.model);
        return conversation.revision; // already written
      }
      // Only the surviving source turn is answered (INV-35): the reply is
      // written only while its user block is still the last block.
      const last = conversation.model.blocks.at(-1);
      if (last?.type !== "user" || last.id !== record.userMessageId) {
        this.o.logger.info(
          { generationId: record.generationId },
          "reply discarded: its source turn was superseded",
        );
        await markWritten();
        return null;
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
      await this.o.hooks?.afterAssistantWrite?.();
      await stage(written.model);
      await markWritten();
      return written.revision;
    });
  }
}

/** A text attachment as a fenced block labeled with its filename (contracts §7). */
export function fencedText(meta: AttachmentMeta, head: Buffer, limit: number): string {
  const truncated = meta.size > limit;
  // A cut can split a multibyte character: drop the partial one.
  const text = head
    .subarray(0, limit)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const marker = truncated
    ? `\n[Truncated: the first ${String(limit)} of ${String(meta.size)} bytes of ${meta.filename} are shown.]`
    : "";
  return `Attached file: ${meta.filename}\n${fence}\n${text}\n${fence}${marker}`;
}
