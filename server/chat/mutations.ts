import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";
import type { GenerationManager } from "../generations/manager.ts";
import type { Logger } from "../logger.ts";
import type { AttachmentStore } from "../storage/attachments.ts";
import type { ConversationStore, LoadedConversation } from "../storage/conversations.ts";
import { normalizeBody, type Block, type ConversationModel } from "../storage/markdown.ts";
import type { PreferencesStore } from "../storage/preferences.ts";
import {
  attachmentRefs,
  deleteExchange,
  truncateAfter,
  type TruncationResult,
  type TurnError,
} from "./turns.ts";

/** Pins kept per user (the preferences sanitizer's bound). */
export const MAX_PINS = 500;

/**
 * Conversation mutations (contracts §4.2, Phase 13a): edit, delete exchange,
 * clear history and pins. Every exchange mutation holds the conversation
 * lock, rejects a running generation (`GENERATION_IN_PROGRESS`) and a stale
 * `expectedRevision` (`CONFLICT`), and returns the new revision. Attachments
 * of removed turns are deleted only after the canonical Markdown write.
 * Regeneration lives in SendService (it starts a generation).
 */
export class ConversationMutations {
  private readonly o: {
    store: ConversationStore;
    generations: GenerationManager;
    attachments: AttachmentStore;
    preferences: PreferencesStore;
    logger: Logger;
  };

  constructor(options: ConversationMutations["o"]) {
    this.o = options;
  }

  private async current(userId: string, id: string, expectedRevision: string) {
    if (this.o.generations.activeFor(`${userId}/${id}`))
      throw new AppError(
        ErrorCode.GENERATION_IN_PROGRESS,
        "A reply is being generated; stop it or wait for it to finish",
      );
    const read = await this.o.store.readUnlocked(userId, id);
    if (read.kind === "missing") throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    if (read.kind === "malformed")
      throw new AppError(
        ErrorCode.CONVERSATION_MALFORMED,
        "This conversation file is malformed and cannot be changed",
      );
    if (read.conversation.revision !== expectedRevision)
      throw new AppError(ErrorCode.CONFLICT, "The conversation changed; reload and try again");
    return read.conversation;
  }

  private applied(result: TruncationResult | TurnError): TruncationResult {
    if (!("kind" in result)) return result;
    if (result.kind === "not_found") throw new AppError(ErrorCode.NOT_FOUND, "Message not found");
    throw new AppError(
      ErrorCode.VALIDATION,
      "This part of the conversation can't be changed (it isn't a regular exchange)",
    );
  }

  private async write(
    userId: string,
    id: string,
    model: ConversationModel,
  ): Promise<LoadedConversation> {
    return this.o.store.writeUnlocked(userId, id, {
      ...model,
      updatedAt: this.o.store.timestamp(),
    });
  }

  /** Attachments no longer referenced after a mutation go after the Markdown write. */
  private async cleanup(
    userId: string,
    id: string,
    before: readonly Block[],
    after: readonly Block[],
  ) {
    const kept = attachmentRefs(after);
    const gone = [...attachmentRefs(before)].filter((ref) => !kept.has(ref));
    if (gone.length === 0) return;
    await this.o.attachments.deleteLinked(userId, id, gone).catch((error: unknown) => {
      this.o.logger.warn({ err: error }, "removing attachments of removed turns failed");
    });
  }

  /**
   * Edit user turn k: keep its id and `time`, replace its body and
   * attachments, remove every later block. Does not generate a reply.
   */
  edit(
    userId: string,
    id: string,
    messageId: string,
    input: { content: string; attachmentIds?: string[] | undefined; expectedRevision: string },
  ): Promise<LoadedConversation> {
    return this.o.store.withLock(userId, id, async () => {
      const current = await this.current(userId, id, input.expectedRevision);
      const target = current.model.blocks.find((b) => b.type === "user" && b.id === messageId);
      const had = new Set(target?.type === "user" ? (target.attachments ?? []) : []);
      const ids = input.attachmentIds ?? [...had];
      const limit = this.o.attachments.effective().maxPerMessage;
      if (ids.length > limit)
        throw new AppError(
          ErrorCode.VALIDATION,
          `A message can have at most ${String(limit)} attachments`,
        );
      const fresh = ids.filter((a) => !had.has(a));
      return this.o.attachments.withLocks(userId, fresh, async () => {
        const pending = await this.o.attachments.requirePending(userId, fresh);
        const body = normalizeBody(input.content);
        const result = this.applied(
          truncateAfter(current.model, messageId, (block) => {
            const next: Extract<Block, { type: "user" }> = { ...block, body };
            if (ids.length > 0) next.attachments = [...ids];
            else delete next.attachments;
            return next;
          }),
        );
        const written = await this.write(userId, id, result.model);
        await this.o.attachments.link(userId, pending, id, messageId);
        await this.cleanup(userId, id, current.model.blocks, result.model.blocks);
        return written;
      });
    });
  }

  /** Delete exchange: exactly the user block and its response; later turns stay. */
  deleteExchange(
    userId: string,
    id: string,
    messageId: string,
    expectedRevision: string,
  ): Promise<LoadedConversation> {
    return this.o.store.withLock(userId, id, async () => {
      const current = await this.current(userId, id, expectedRevision);
      const result = this.applied(deleteExchange(current.model, messageId));
      const written = await this.write(userId, id, result.model);
      await this.cleanup(userId, id, current.model.blocks, result.model.blocks);
      return written;
    });
  }

  /**
   * Clear history: every conversation of the user, each with the normal
   * deletion rules (running generations are cancelled first; Markdown, then
   * its attachments and pin). Preferences other than stale pins, approved
   * memories and artifacts are untouched.
   */
  async clearHistory(userId: string): Promise<number> {
    let deleted = 0;
    for (const entry of this.o.store.list(userId)) {
      const key = `${userId}/${entry.id}`;
      const running = this.o.generations.activeFor(key);
      if (running && !running.startsWith("reserved:"))
        await this.o.generations.cancel(running, userId).catch(() => undefined);
      try {
        await this.o.store.delete(userId, entry.id);
        deleted++;
      } catch (error) {
        this.o.logger.warn(
          { err: error, conversationId: entry.id },
          "clear history: delete failed",
        );
      }
    }
    return deleted;
  }

  /** Pin or unpin (canonical preferences, INV-34): order is pin order; other fields are kept. */
  async setPinned(userId: string, id: string, pinned: boolean): Promise<string[]> {
    if (pinned && (await this.o.store.readUnlocked(userId, id)).kind === "missing")
      throw new AppError(ErrorCode.NOT_FOUND, "Conversation not found");
    const next = await this.o.preferences.modify(userId, (prefs) => {
      const rest = prefs.pins.filter((pin) => pin !== id);
      if (pinned && rest.length >= MAX_PINS)
        throw new AppError(
          ErrorCode.VALIDATION,
          `At most ${String(MAX_PINS)} conversations can be pinned`,
        );
      return { pins: pinned ? [...rest, id] : rest };
    });
    return next.pins;
  }

  /** Conversation deletion: its pin is stale (preferences lock, after the conversation lock). */
  async dropPin(userId: string, id: string): Promise<void> {
    const prefs = await this.o.preferences.get(userId);
    if (!prefs.pins.includes(id)) return;
    await this.o.preferences.modify(userId, (current) => ({
      pins: current.pins.filter((pin) => pin !== id),
    }));
  }
}
