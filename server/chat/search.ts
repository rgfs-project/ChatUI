import { SEARCH_LIMITS, type SearchResponse, type SearchResult } from "@shared/conversations";
import type { ConversationStore } from "../storage/conversations.ts";

/** Characters of context on each side of a match. */
const CONTEXT = 60;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One line of text around the first match (whitespace collapsed; ellipses at cuts). */
export function snippet(text: string, index: number, length: number): SearchResult["snippet"] {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const start = Math.max(0, index - CONTEXT);
  const end = Math.min(text.length, index + length + CONTEXT);
  let before = flat(text.slice(start, index));
  let after = flat(text.slice(index + length, end));
  if (start > 0) before = `…${before.trimStart()}`;
  if (end < text.length) after = `${after.trimEnd()}…`;
  return { before, match: flat(text.slice(index, index + length)), after };
}

/**
 * Full-text search over the signed-in user's conversations (INV-36): titles
 * and user/assistant message bodies (never reasoning or system text),
 * case-insensitive (Unicode simple case folding). Bounded: the query length,
 * at most `limit` results and `perConversation` per conversation, newest
 * conversations first. A malformed file is skipped and counted, never fatal.
 * Reads canonical files through the user-scoped store only: there is no
 * separate search index to drift (anything cached here would be derived).
 */
export async function searchConversations(
  store: ConversationStore,
  userId: string,
  query: string,
  limit = 20,
): Promise<SearchResponse> {
  const needle = query.trim().slice(0, SEARCH_LIMITS.maxQuery);
  const pattern = new RegExp(escapeRegExp(needle), "iu");
  const results: SearchResult[] = [];
  let truncated = false;
  let skippedMalformed = 0;
  const entries = [...store.list(userId)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const entry of entries) {
    const read = await store.readUnlocked(userId, entry.id);
    if (read.kind === "missing") continue;
    if (read.kind === "malformed") {
      // Its title (from the derived index) is still searchable; its body is not readable.
      skippedMalformed++;
      continue;
    }
    const { model } = read.conversation;
    const hits: SearchResult[] = [];
    const titleMatch = pattern.exec(model.title);
    if (titleMatch)
      hits.push({
        conversationId: entry.id,
        title: model.title,
        messageId: null,
        role: null,
        snippet: snippet(model.title, titleMatch.index, titleMatch[0].length),
        updatedAt: model.updatedAt,
      });
    for (const block of model.blocks) {
      if (hits.length >= SEARCH_LIMITS.perConversation) break;
      if (block.type !== "user" && block.type !== "assistant") continue;
      const match = pattern.exec(block.body);
      if (!match) continue;
      hits.push({
        conversationId: entry.id,
        title: model.title,
        messageId: block.id,
        role: block.type,
        snippet: snippet(block.body, match.index, match[0].length),
        updatedAt: model.updatedAt,
      });
    }
    for (const hit of hits) {
      if (results.length >= limit) {
        truncated = true;
        break;
      }
      results.push(hit);
    }
    if (truncated) break;
  }
  return { results, truncated, skippedMalformed };
}
