// Conversation and file search (Phase 13a): user-scoped, bounded, derived.
import type { SearchResults } from "@shared/search";
import type { AttachmentStore } from "../attachments/store.ts";
import type { ConversationStore } from "../storage/conversations.ts";

export const SEARCH_MAX_QUERY = 200;
export const SEARCH_MAX_CHATS = 50;
export const SEARCH_MAX_FILES = 20;
const SNIPPET = 160;

interface Indexed {
  stamp: string;
  title: string;
  updatedAt: string;
  messages: { id: string; text: string }[];
}

/** A window of `text` around the match, with the match's offsets in it. */
function snippet(text: string, at: number, length: number) {
  const flat = text.replace(/\s+/g, " ");
  // Offsets shift when whitespace collapses; recompute on the flattened text.
  const needle = text.slice(at, at + length).replace(/\s+/g, " ");
  const index = flat.toLowerCase().indexOf(needle.toLowerCase());
  const start = Math.max(0, index - Math.floor((SNIPPET - needle.length) / 2));
  const end = Math.min(flat.length, start + SNIPPET);
  const prefix = start > 0 ? "…" : "";
  return {
    text: `${prefix}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`,
    match: [index - start + prefix.length, index - start + prefix.length + needle.length] as [
      number,
      number,
    ],
  };
}

/**
 * Searches titles and message bodies of the user's own conversations, and the
 * names of their files. Malformed conversations are skipped (they can't
 * affect other results). The text cache is derived: keyed by the index stamp
 * of each file and rebuilt on demand, so it can always be dropped.
 */
export class SearchService {
  private readonly cache = new Map<string, Map<string, Indexed>>();
  private readonly store: ConversationStore;
  private readonly attachments: AttachmentStore;

  constructor(store: ConversationStore, attachments: AttachmentStore) {
    this.store = store;
    this.attachments = attachments;
  }

  private async documents(userId: string): Promise<Map<string, Indexed>> {
    const previous = this.cache.get(userId) ?? new Map<string, Indexed>();
    const next = new Map<string, Indexed>();
    for (const entry of this.store.list(userId)) {
      if (entry.malformed) continue;
      const stamp = `${String(entry.fileSize)}:${String(entry.fileMtimeMs)}`;
      const cached = previous.get(entry.id);
      if (cached?.stamp === stamp) {
        next.set(entry.id, cached);
        continue;
      }
      const read = await this.store.readUnlocked(userId, entry.id);
      if (read.kind !== "ok") continue;
      next.set(entry.id, {
        stamp,
        title: read.conversation.model.title,
        updatedAt: read.conversation.model.updatedAt,
        messages: read.conversation.model.blocks
          .filter((b) => b.type === "user" || b.type === "assistant")
          .map((b) => ({ id: b.id, text: b.body })),
      });
    }
    this.cache.set(userId, next);
    return next;
  }

  async search(userId: string, query: string, limit = 20): Promise<SearchResults> {
    const needle = query.trim().toLowerCase().slice(0, SEARCH_MAX_QUERY);
    if (needle === "") return { query: "", chats: [], files: [] };
    const max = Math.min(Math.max(1, limit), SEARCH_MAX_CHATS);
    const chats: SearchResults["chats"] = [];
    for (const [conversationId, doc] of await this.documents(userId)) {
      const inTitle = doc.title.toLowerCase().indexOf(needle);
      let matches = inTitle >= 0 ? 1 : 0;
      let first: SearchResults["chats"][number]["first"] = null;
      for (const message of doc.messages) {
        const lower = message.text.toLowerCase();
        let at = lower.indexOf(needle);
        if (at >= 0 && first === null) {
          first = { messageId: message.id, ...snippet(message.text, at, needle.length) };
        }
        while (at >= 0) {
          matches++;
          at = lower.indexOf(needle, at + needle.length);
        }
      }
      if (matches === 0) continue;
      chats.push({ conversationId, title: doc.title, updatedAt: doc.updatedAt, matches, first });
    }
    chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const files = (await this.attachments.list(userId))
      .filter((meta) => meta.filename.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, SEARCH_MAX_FILES)
      .map((meta) => ({
        id: meta.id,
        filename: meta.filename,
        kind: meta.kind,
        conversationId: meta.conversationId,
      }));
    return { query: needle, chats: chats.slice(0, max), files };
  }

  forgetUser(userId: string): void {
    this.cache.delete(userId);
  }
}
