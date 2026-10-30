import type { Block, ConversationModel } from "../storage/markdown.ts";

/** OpenAI-compatible typed content parts (Phase 12, docs/provider-notes.md). */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" | "flac" } };

/** Plain text, or typed parts when a message carries images or audio. */
export type PromptContent = string | ContentPart[];

/** A provider-bound message. Built from canonical storage only (contracts §4). */
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  content: PromptContent;
}

/** The text of a message (text parts joined); media parts contribute nothing. */
export function textOf(content: PromptContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n\n");
}

/** Image and audio parts in a message (each counts MEDIA_TOKEN_RESERVE). */
export function mediaCount(content: PromptContent): number {
  return typeof content === "string" ? 0 : content.filter((part) => part.type !== "text").length;
}

function toParts(content: PromptContent): ContentPart[] {
  return typeof content === "string"
    ? content === ""
      ? []
      : [{ type: "text", text: content }]
    : content;
}

/** Joins two contents with two newlines, preserving typed part order. */
export function joinContent(a: PromptContent, b: PromptContent): PromptContent {
  if (typeof a === "string" && typeof b === "string") return `${a}\n\n${b}`;
  const left = toParts(a);
  const right = toParts(b);
  const last = left.at(-1);
  const first = right[0];
  if (last?.type === "text" && first?.type === "text") {
    return [
      ...left.slice(0, -1),
      { type: "text", text: `${last.text}\n\n${first.text}` },
      ...right.slice(1),
    ];
  }
  return [...left, ...right];
}

/** Expands a user block's attachments (Phase 12); the default is the body alone. */
export type ExpandUser = (block: Extract<Block, { type: "user" }>) => PromptContent;

export interface TokenCounter {
  /** True when counts come from the model's own template/tokenizer. */
  readonly exact: boolean;
  /** Tokens for a group of messages, used for truncation arithmetic and anchors. */
  countGroup(messages: PromptMessage[]): Promise<number>;
  /** Tokens of the fully formatted prompt. */
  countPrompt(messages: PromptMessage[]): Promise<number>;
}

export interface HistoryGroups {
  /** Every system block, in file order. */
  system: PromptMessage[];
  /**
   * History groups: a user block plus the assistant bodies that follow it
   * before the next user block. Leading assistant history without a user turn
   * is dropped. Reasoning and empty assistant bodies are never included.
   */
  groups: PromptMessage[][];
}

export function historyGroups(
  model: ConversationModel,
  expand: ExpandUser = (block) => block.body,
): HistoryGroups {
  const system: PromptMessage[] = [];
  const groups: PromptMessage[][] = [];
  for (const block of model.blocks) {
    if (block.type === "system") {
      system.push({ role: "system", content: block.body });
    } else if (block.type === "user") {
      groups.push([{ role: "user", content: expand(block) }]);
    } else if (block.type === "assistant" && block.body !== "") {
      groups.at(-1)?.push({ role: "assistant", content: block.body });
    }
  }
  return { system, groups };
}

/** Merges adjacent same-role messages in the provider prompt only (two newlines). */
export function normalizeRoles(messages: PromptMessage[]): PromptMessage[] {
  const out: PromptMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last?.role === message.role) {
      last.content = joinContent(last.content, message.content);
    } else {
      out.push({ ...message });
    }
  }
  return out;
}

export class ContextTooLargeError extends Error {
  override name = "ContextTooLargeError";
}

export interface AssembledPrompt {
  messages: PromptMessage[];
  /** Index of the first history group kept. */
  windowStart: number;
  groupCount: number;
  promptTokens: number;
  exact: boolean;
}

/**
 * Anchors (contracts §4 item 6): the group boundaries where the cumulative
 * token count of earlier history first reaches each multiple of `step`. They
 * depend only on earlier history, so the window start stays put until the
 * history grows by roughly `step` tokens.
 */
export function anchorsFor(costs: number[], step: number): number[] {
  const anchors: number[] = [];
  let cumulative = 0;
  let multiple = 1;
  for (let k = 0; k < costs.length; k++) {
    if (cumulative >= multiple * step) {
      anchors.push(k);
      while (cumulative >= multiple * step) multiple++;
    }
    cumulative += costs[k] ?? 0;
  }
  return anchors;
}

/**
 * Assembles the provider prompt for a model whose last group is the newest
 * user message. Throws ContextTooLargeError when the system messages plus the
 * newest user message alone exceed the budget.
 */
export async function assemblePrompt(
  model: ConversationModel,
  options: {
    budget: number;
    trimStep: number;
    counter: TokenCounter;
    /** Per-model system prompt (Phase 10), before the conversation's system blocks. */
    instructions?: string | null;
    /** Volatile server context (e.g. time of day), only before the newest user message. */
    context?: string | null;
    /** Attachment expansion for user blocks (Phase 12). */
    expand?: ExpandUser;
  },
): Promise<AssembledPrompt> {
  const { budget, counter } = options;
  const history = historyGroups(model, options.expand);
  const system: PromptMessage[] = [
    ...(options.instructions ? [{ role: "system" as const, content: options.instructions }] : []),
    ...history.system,
  ];
  const groups = history.groups;
  const newest = groups.length - 1;
  if (newest < 0) throw new Error("assemblePrompt requires a newest user message");
  // The volatile block rides on the newest user message only, so every earlier
  // turn (and the prompt prefix) is unchanged when time moves on.
  const newestGroup = groups[newest];
  if (options.context && newestGroup?.[0]) {
    groups[newest] = [
      { role: "user", content: joinContent(options.context, newestGroup[0].content) },
      ...newestGroup.slice(1),
    ];
  }

  const systemCost = system.length > 0 ? await counter.countGroup(system) : 0;
  const costs = await Promise.all(groups.map((group) => counter.countGroup(group)));
  if (systemCost + (costs[newest] ?? 0) > budget) {
    throw new ContextTooLargeError(
      "The system instructions and the new message exceed the context budget",
    );
  }

  // Earliest start s at which the prompt fits.
  let suffix = systemCost;
  let s = newest + 1;
  for (let k = newest; k >= 0; k--) {
    suffix += costs[k] ?? 0;
    if (suffix > budget) break;
    s = k;
  }
  const anchors = anchorsFor(costs, Math.max(1, options.trimStep));
  const startFrom = (earliest: number) =>
    earliest === 0
      ? 0
      : (anchors.find((anchor) => anchor >= earliest && anchor < newest) ?? earliest);

  let start = startFrom(s);
  for (;;) {
    const messages = normalizeRoles([...system, ...groups.slice(start).flat()]);
    const promptTokens = await counter.countPrompt(messages);
    if (promptTokens <= budget) {
      return {
        messages,
        windowStart: start,
        groupCount: groups.length,
        promptTokens,
        exact: counter.exact,
      };
    }
    // The formatted prompt is larger than the group arithmetic predicted:
    // move to the next anchor (or group) and recount.
    if (start >= newest) {
      throw new ContextTooLargeError(
        "The system instructions and the new message exceed the context budget",
      );
    }
    start = startFrom(start + 1);
  }
}

/**
 * Pessimistic fallback: one token per UTF-8 byte plus template overhead per
 * message, plus `mediaTokenReserve` per image or audio part.
 */
export function estimateCounter(
  templateOverheadTokens: number,
  mediaTokenReserve = 0,
): TokenCounter {
  const count = (messages: PromptMessage[]) =>
    Promise.resolve(
      messages.reduce(
        (sum, m) =>
          sum +
          Buffer.byteLength(textOf(m.content), "utf8") +
          templateOverheadTokens +
          mediaTokenReserve * mediaCount(m.content),
        0,
      ),
    );
  return { exact: false, countGroup: count, countPrompt: count };
}
