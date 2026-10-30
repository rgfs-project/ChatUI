// Conversation mutations (Phase 13a, contracts §4.2): edit, delete exchange,
// clear history. Regeneration lives in SendService (it starts a generation).
import { ErrorCode } from "@shared/errors";
import type { AttachmentStore } from "../attachments/store.ts";
import { AppError } from "../errors.ts";
import type { GenerationManager } from "../generations/manager.ts";
import type { ConversationStore, LoadedConversation } from "../storage/conversations.ts";
import { normalizeBody, type ConversationModel, type UserBlock } from "../storage/markdown.ts";
import type { PreferencesStore } from "../storage/preferences.ts";
import type { ProposalStore } from "../storage/proposals.ts";
import type { MemoryService } from "../memory/service.ts";
import { findExchange, removedUsers, touchesIrregular } from "./turns.ts";

export interface MutationOptions {
  store: ConversationStore;
  generations: GenerationManager;
  attachments: AttachmentStore;
  preferences: PreferencesStore;
  /** Phase 13b: suggestions of removed turns become invalid; sidecars go with their chat. */
  proposals?: ProposalStore;
  memory?: MemoryService;
  now?: () => Date;
}

/** Shared checks under the conversation lock: exists, parses, idle, current revision. */
export async function readForMutation(
  store: ConversationStore,
  generations: GenerationManager,
  userId: string,
  conversationId: string,
  expectedRevision: string,
): Promise<LoadedConversation> {
  const read = await store.readUnlocked(userId, conversationId);
  if (read.kind === "missing") throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
  if (read.kind === "malformed")
    throw new AppError(
      ErrorCode.CONVERSATION_MALFORMED,
      "This conversation file is malformed and cannot be changed",
    );
  if (generations.activeFor(`${userId}/${conversationId}`)) {
    throw new AppError(
      ErrorCode.GENERATION_IN_PROGRESS,
      "A reply is being generated; stop it first",
    );
  }
  if (read.conversation.revision !== expectedRevision) {
    throw new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
  }
  return read.conversation;
}

export function exchangeOrThrow(model: ConversationModel, messageId: string) {
  const found = findExchange(model, messageId);
  if (found === "irregular") throw irregularError();
  if (found === "not_found") throw new AppError(ErrorCode.NOT_FOUND, "Message not found");
  return found;
}

function irregularError(): AppError {
  return new AppError(
    ErrorCode.VALIDATION,
    "This part of the conversation has replies without a matching message and can't be changed",
  );
}

export class ConversationMutations {
  private readonly o: MutationOptions;

  constructor(options: MutationOptions) {
    this.o = options;
  }

  /** Pending suggestions whose source turn is gone become invalid (§4.3), under the conversation lock. */
  private async invalidate(
    userId: string,
    conversationId: string,
    blocks: readonly { id: string }[],
  ) {
    await this.o.proposals?.invalidateMissing(
      userId,
      conversationId,
      new Set(blocks.map((b) => b.id)),
      (this.o.now ?? (() => new Date()))().toISOString(),
    );
  }

  /** After a canonical write: files of removed user turns go too (Markdown first, §7). */
  private async dropFiles(userId: string, conversationId: string, removed: readonly UserBlock[]) {
    const ids = removed.flatMap((block) => block.attachments ?? []);
    if (ids.length > 0) await this.o.attachments.deleteIds(userId, conversationId, ids);
  }

  /**
   * Edit user turn k: keeps its id and time, replaces its text (and may drop
   * some of its files), and removes every later block. No reply is started.
   */
  async edit(
    userId: string,
    conversationId: string,
    messageId: string,
    input: { content: string; attachmentIds?: string[]; expectedRevision: string },
  ): Promise<LoadedConversation> {
    const { written, removed } = await this.o.store.withLock(userId, conversationId, async () => {
      const current = await readForMutation(
        this.o.store,
        this.o.generations,
        userId,
        conversationId,
        input.expectedRevision,
      );
      const { layout, exchange } = exchangeOrThrow(current.model, messageId);
      if (touchesIrregular(layout, exchange.start, current.model.blocks.length))
        throw irregularError();
      const existing = exchange.user.attachments ?? [];
      const attachments = input.attachmentIds ?? existing;
      if (attachments.some((id) => !existing.includes(id)))
        throw new AppError(
          ErrorCode.VALIDATION,
          "Editing can keep or remove this message's files, not add new ones",
        );
      const content = normalizeBody(input.content);
      if (content.trim() === "" && attachments.length === 0)
        throw new AppError(ErrorCode.VALIDATION, "The message must not be empty");
      const edited: UserBlock = {
        ...exchange.user,
        body: content,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
      if (attachments.length === 0) delete edited.attachments;
      const blocks = [...current.model.blocks.slice(0, exchange.start), edited];
      const next = await this.o.store.writeUnlocked(userId, conversationId, {
        ...current.model,
        blocks,
        updatedAt: (this.o.now ?? (() => new Date()))().toISOString(),
      });
      await this.invalidate(userId, conversationId, blocks);
      const dropped = existing.filter((id) => !attachments.includes(id));
      return {
        written: next,
        removed: [
          ...removedUsers(current.model.blocks, blocks),
          // The edited turn's dropped files.
          ...(dropped.length > 0 ? [{ ...exchange.user, attachments: dropped }] : []),
        ],
      };
    });
    await this.dropFiles(userId, conversationId, removed);
    return written;
  }

  /** Delete exactly one exchange: the user block and its response. Everything else stays. */
  async deleteExchange(
    userId: string,
    conversationId: string,
    messageId: string,
    expectedRevision: string,
  ): Promise<LoadedConversation> {
    const { written, removed } = await this.o.store.withLock(userId, conversationId, async () => {
      const current = await readForMutation(
        this.o.store,
        this.o.generations,
        userId,
        conversationId,
        expectedRevision,
      );
      const { layout, exchange } = exchangeOrThrow(current.model, messageId);
      // An irregular response right after the exchange would be orphaned.
      if (touchesIrregular(layout, exchange.start, exchange.end + 1)) throw irregularError();
      const blocks = [
        ...current.model.blocks.slice(0, exchange.start),
        ...current.model.blocks.slice(exchange.end),
      ];
      const next = await this.o.store.writeUnlocked(userId, conversationId, {
        ...current.model,
        blocks,
        updatedAt: (this.o.now ?? (() => new Date()))().toISOString(),
      });
      await this.invalidate(userId, conversationId, blocks);
      return { written: next, removed: [exchange.user] };
    });
    await this.dropFiles(userId, conversationId, removed);
    return written;
  }

  /**
   * Clear history: every conversation with the normal deletion rules
   * (Markdown, then its files, then its pin). Refused while any reply runs.
   * Memories, artifacts and other preferences stay.
   */
  async clearHistory(userId: string): Promise<number> {
    const ids = this.o.store.list(userId).map((entry) => entry.id);
    if (ids.some((id) => this.o.generations.activeFor(`${userId}/${id}`))) {
      throw new AppError(
        ErrorCode.GENERATION_IN_PROGRESS,
        "A reply is being generated; stop it first",
      );
    }
    let deleted = 0;
    for (const id of ids) {
      if (await this.deleteOne(userId, id)) deleted++;
    }
    await this.o.preferences.update(userId, { pins: [] });
    return deleted;
  }

  /**
   * Deletes one conversation in the documented order: finish pending memory
   * acceptances of its suggestions, then the Markdown, then its files, its
   * proposal sidecar (§4.3) and its pin. Returns false when it was already gone.
   */
  private async deleteOne(userId: string, conversationId: string): Promise<boolean> {
    await this.o.memory?.resolveIntents(userId, conversationId);
    try {
      await this.o.store.delete(userId, conversationId);
    } catch {
      return false; // already gone
    }
    await this.o.attachments.deleteForConversation(userId, conversationId);
    await this.o.memory?.deleteSidecar(userId, conversationId);
    return true;
  }

  /** Single conversation deletion (route): as clear history, plus its pin (INV-34). */
  async deleteConversation(userId: string, conversationId: string): Promise<void> {
    await this.o.memory?.resolveIntents(userId, conversationId);
    // Throws NOT_FOUND for a missing conversation (StorageError, mapped by the route).
    await this.o.store.delete(userId, conversationId);
    await this.o.attachments.deleteForConversation(userId, conversationId);
    await this.o.memory?.deleteSidecar(userId, conversationId);
    await this.forgetPin(userId, conversationId);
  }

  /** A deleted conversation's pin goes with it (INV-34 keeps every other preference). */
  forgetPin(userId: string, conversationId: string): Promise<void> {
    return this.o.preferences.removePins(userId, [conversationId]);
  }
}
