// Turn grammar (contracts §4.2): exchanges and irregular regions.
import type { Block, ConversationModel, UserBlock } from "../storage/markdown.ts";

/** One user block and its optional response (reasoning + assistant). */
export interface Exchange {
  user: UserBlock;
  /** Index of the user block. */
  start: number;
  /** One past the last block of the exchange (its response, if any). */
  end: number;
  hasResponse: boolean;
}

export interface TurnLayout {
  exchanges: Exchange[];
  /** Indices of blocks in irregular regions (a response with no open user turn). */
  irregular: Set<number>;
}

/**
 * Leading system blocks, then exchanges. A mid-conversation system block ends
 * the current exchange and belongs to none; consecutive user blocks are each
 * an exchange without a response. A response (an optional reasoning block
 * and its assistant block) that has no open user turn before it, such as a
 * leading assistant or a second response after one user, is irregular.
 */
export function analyzeTurns(blocks: readonly Block[]): TurnLayout {
  const exchanges: Exchange[] = [];
  const irregular = new Set<number>();
  let open: Exchange | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block) continue;
    if (block.type === "system") {
      open = null;
    } else if (block.type === "user") {
      open = { user: block, start: i, end: i + 1, hasResponse: false };
      exchanges.push(open);
    } else {
      // A response: reasoning (followed by its assistant) or a bare assistant.
      const last = block.type === "reasoning" && blocks[i + 1]?.type === "assistant" ? i + 1 : i;
      if (open && !open.hasResponse) {
        open.hasResponse = true;
        open.end = last + 1;
      } else {
        for (let k = i; k <= last; k++) irregular.add(k);
      }
      i = last;
    }
  }
  return { exchanges, irregular };
}

export type TurnProblem = "not_found" | "irregular";

/** The exchange whose user block has `messageId`, or why it can't be used. */
export function findExchange(
  model: ConversationModel,
  messageId: string,
): { layout: TurnLayout; exchange: Exchange } | TurnProblem {
  const layout = analyzeTurns(model.blocks);
  const exchange = layout.exchanges.find((e) => e.user.id === messageId);
  if (exchange) return { layout, exchange };
  const index = model.blocks.findIndex((b) => b.id === messageId);
  return index >= 0 && layout.irregular.has(index) ? "irregular" : "not_found";
}

/** True when any block in [from, to) is part of an irregular region. */
export function touchesIrregular(layout: TurnLayout, from: number, to: number): boolean {
  for (const index of layout.irregular) if (index >= from && index < to) return true;
  return false;
}

/** User blocks removed by keeping only `kept` (for attachment cleanup). */
export function removedUsers(before: readonly Block[], kept: readonly Block[]): UserBlock[] {
  const keptIds = new Set(kept.filter((b) => b.type === "user").map((b) => b.id));
  return before.filter((b): b is UserBlock => b.type === "user" && !keptIds.has(b.id));
}

/**
 * Source validity for later phases (13b proposals): a message is a valid
 * source only while it still exists in the canonical conversation.
 */
export function messageExists(model: ConversationModel, messageId: string): boolean {
  return model.blocks.some((b) => b.id === messageId);
}
