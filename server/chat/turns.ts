// Turn grammar and exchange operations (contracts §4.2). Pure functions over
// the canonical block list; the callers hold the conversation lock.
import type { Block, ConversationModel } from "../storage/markdown.ts";

/**
 * After optional leading system blocks, a conversation is a sequence of
 * exchanges: one user block, then at most one response (an optional
 * reasoning block immediately followed by its assistant block). A system
 * block after the first user block ends the exchange and belongs to none.
 * Anything else (an assistant with no user before it in the exchange, a
 * second response, reasoning without its assistant) is an irregular region.
 */
export type Segment =
  | { kind: "system"; start: number; end: number }
  | {
      kind: "exchange";
      start: number;
      end: number;
      /** Index of the user block (= start). */
      user: number;
      /** First index of the response, or null when unanswered. */
      response: number | null;
    }
  | { kind: "irregular"; start: number; end: number };

export function segments(blocks: readonly Block[]): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (!block) break;
    if (block.type === "system") {
      out.push({ kind: "system", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (block.type === "user") {
      let j = i + 1;
      let response: number | null = null;
      const next = blocks[j];
      if (next?.type === "assistant") {
        response = j;
        j++;
      } else if (next?.type === "reasoning" && blocks[j + 1]?.type === "assistant") {
        response = j;
        j += 2;
      }
      // Anything but a user or system block after the response is irregular:
      // the whole exchange joins the irregular region.
      let k = j;
      while (k < blocks.length && blocks[k]?.type !== "user" && blocks[k]?.type !== "system") k++;
      if (k > j) out.push({ kind: "irregular", start: i, end: k });
      else out.push({ kind: "exchange", start: i, end: j, user: i, response });
      i = k;
      continue;
    }
    // Reasoning/assistant with no user block before it in this exchange.
    let k = i;
    while (k < blocks.length && blocks[k]?.type !== "user" && blocks[k]?.type !== "system") k++;
    out.push({ kind: "irregular", start: i, end: k });
    i = k;
  }
  return out;
}

export type TurnError =
  | { kind: "not_found" }
  /** The target or the range the operation removes includes an irregular region. */
  | { kind: "irregular" };

export interface Located {
  exchange: Extract<Segment, { kind: "exchange" }>;
  all: Segment[];
}

/** The exchange whose user block has `userMessageId`. */
export function locate(model: ConversationModel, userMessageId: string): Located | TurnError {
  const index = model.blocks.findIndex((b) => b.type === "user" && b.id === userMessageId);
  if (index < 0) return { kind: "not_found" };
  const all = segments(model.blocks);
  const segment = all.find((s) => s.start <= index && index < s.end);
  if (segment?.kind !== "exchange") return { kind: "irregular" };
  return { exchange: segment, all };
}

function rangeIsRegular(all: readonly Segment[], start: number, end: number): boolean {
  return !all.some((s) => s.kind === "irregular" && s.start < end && s.end > start);
}

export interface TruncationResult {
  model: ConversationModel;
  /** Blocks removed from the file, in order. */
  removed: Block[];
}

/**
 * Edit and regenerate: keep the user block (edited or not) and remove every
 * block after it — its response, later exchanges and any mid-conversation
 * system blocks.
 */
export function truncateAfter(
  model: ConversationModel,
  userMessageId: string,
  replace?: (block: Extract<Block, { type: "user" }>) => Extract<Block, { type: "user" }>,
): TruncationResult | TurnError {
  const found = locate(model, userMessageId);
  if ("kind" in found) return found;
  const { exchange, all } = found;
  if (!rangeIsRegular(all, exchange.user, model.blocks.length)) return { kind: "irregular" };
  const user = model.blocks[exchange.user] as Extract<Block, { type: "user" }>;
  return {
    model: {
      ...model,
      blocks: [...model.blocks.slice(0, exchange.user), replace ? replace(user) : user],
    },
    removed: model.blocks.slice(exchange.user + 1),
  };
}

/** Delete exchange: exactly the user block and its response; everything else stays. */
export function deleteExchange(
  model: ConversationModel,
  userMessageId: string,
): TruncationResult | TurnError {
  const found = locate(model, userMessageId);
  if ("kind" in found) return found;
  const { exchange } = found;
  return {
    model: {
      ...model,
      blocks: [...model.blocks.slice(0, exchange.start), ...model.blocks.slice(exchange.end)],
    },
    removed: model.blocks.slice(exchange.start, exchange.end),
  };
}

/** Attachment ids referenced by user blocks. */
export function attachmentRefs(blocks: readonly Block[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks)
    if (block.type === "user") for (const id of block.attachments ?? []) ids.add(id);
  return ids;
}

/**
 * Source validity (contracts §4.2; the hook Phase 13b's proposals use): a
 * source turn is valid only while its user block exists and, when an
 * assistant id is given, that assistant is still the response of that exact
 * exchange. Always evaluated against canonical blocks, never a sidecar.
 */
export function isSourceValid(
  model: ConversationModel,
  source: { userMessageId: string; assistantMessageId?: string },
): boolean {
  const found = locate(model, source.userMessageId);
  if ("kind" in found) return false;
  if (source.assistantMessageId === undefined) return true;
  const { exchange } = found;
  if (exchange.response === null) return false;
  const last = model.blocks[exchange.end - 1];
  return last?.type === "assistant" && last.id === source.assistantMessageId;
}
