import type { ConversationModel } from "../storage/markdown.ts";

/** An image or audio attachment sent as a typed content part (Phase 12, contracts §7). */
export interface MediaPart {
  type: "image" | "audio";
  attachmentId: string;
  mediaType: string;
}

export type ContentPart = { type: "text"; text: string } | MediaPart;

/** A provider-bound message. Built from canonical storage only (contracts §4). */
export interface PromptMessage {
  role: "system" | "user" | "assistant";
  /** All text of the message (what is counted and templated). */
  content: string;
  /** Ordered typed parts, present only when the message carries media. */
  parts?: ContentPart[];
}

/** The typed parts of a message: its own parts, else its text. */
export function partsOf(message: PromptMessage): ContentPart[] {
  return message.parts ?? (message.content === "" ? [] : [{ type: "text", text: message.content }]);
}

export function mediaCount(message: PromptMessage): number {
  return message.parts?.filter((part) => part.type !== "text").length ?? 0;
}

/** What a user block contributes besides its body: inlined text files and media parts. */
export interface UserAttachments {
  /** Fenced text blocks (inlined text attachments), in attachment order. */
  text: string[];
  media: MediaPart[];
}

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
  /** Rewrites each user body for the provider (skills); stored text is untouched. */
  expandUser: (body: string) => string = (body) => body,
  /** Expands a user block's attachments (Phase 12); `newest` marks the message being sent. */
  attachmentsOf?: (ids: readonly string[], newest: boolean) => UserAttachments,
): HistoryGroups {
  const system: PromptMessage[] = [];
  const groups: PromptMessage[][] = [];
  const lastUser = model.blocks.findLastIndex((block) => block.type === "user");
  model.blocks.forEach((block, index) => {
    if (block.type === "system") {
      system.push({ role: "system", content: block.body });
    } else if (block.type === "user") {
      const body = expandUser(block.body);
      const extra =
        attachmentsOf && block.attachments?.length
          ? attachmentsOf(block.attachments, index === lastUser)
          : { text: [], media: [] };
      const content = [body, ...extra.text].filter((text) => text !== "").join("\n\n");
      groups.push([
        extra.media.length > 0
          ? {
              role: "user",
              content,
              // Media first, then the text (the order vision models are tuned for).
              parts: [
                ...extra.media,
                ...(content === "" ? [] : [{ type: "text" as const, text: content }]),
              ],
            }
          : { role: "user", content },
      ]);
    } else if (block.type === "assistant" && block.body !== "") {
      groups.at(-1)?.push({ role: "assistant", content: block.body });
    }
  });
  return { system, groups };
}

/**
 * Merges adjacent same-role messages in the provider prompt only (text joined
 * with two newlines, typed parts kept in order); canonical blocks are untouched.
 */
export function normalizeRoles(messages: PromptMessage[]): PromptMessage[] {
  const out: PromptMessage[] = [];
  for (const message of messages) {
    const last = out.at(-1);
    if (last?.role !== message.role) {
      out.push({ ...message, ...(message.parts ? { parts: [...message.parts] } : {}) });
      continue;
    }
    const content =
      last.content === ""
        ? message.content
        : message.content === ""
          ? last.content
          : `${last.content}\n\n${message.content}`;
    if (last.parts || message.parts) {
      const parts: ContentPart[] = [];
      for (const part of [...partsOf(last), ...partsOf(message)]) {
        const previous = parts.at(-1);
        if (part.type === "text" && previous?.type === "text")
          parts[parts.length - 1] = { type: "text", text: `${previous.text}\n\n${part.text}` };
        else parts.push(part);
      }
      last.parts = parts;
    }
    last.content = content;
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
    /** Configured system instructions (Phase 10), before the file's system blocks. */
    instructions?: string | undefined;
    /**
     * Volatile server context (e.g. time of day), placed only in front of the
     * newest user message so it never changes the prompt prefix (contracts §4 item 3).
     */
    contextBlock?: string | undefined;
    /** Expands user messages that invoke a skill ("/name …"). */
    expandUser?: ((body: string) => string) | undefined;
    /** Expands user attachments (Phase 12). */
    attachmentsOf?: ((ids: readonly string[], newest: boolean) => UserAttachments) | undefined;
  },
): Promise<AssembledPrompt> {
  const { budget, counter } = options;
  const history = historyGroups(model, options.expandUser, options.attachmentsOf);
  const system = options.instructions
    ? [{ role: "system" as const, content: options.instructions }, ...history.system]
    : history.system;
  const groups = history.groups;
  const newest = groups.length - 1;
  if (newest < 0) throw new Error("assemblePrompt requires a newest user message");
  const newestGroup = groups[newest];
  const newestUser = newestGroup?.[0];
  if (options.contextBlock && newestGroup && newestUser)
    groups[newest] = [withLeadingText(newestUser, options.contextBlock), ...newestGroup.slice(1)];

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

/** Prepends text (the volatile context block) to a message, before its text part. */
function withLeadingText(message: PromptMessage, text: string): PromptMessage {
  const content = message.content === "" ? text : `${text}\n\n${message.content}`;
  if (!message.parts) return { ...message, content };
  const media = message.parts.filter((part) => part.type !== "text");
  return { ...message, content, parts: [...media, { type: "text", text: content }] };
}

/**
 * Pessimistic fallback: one token per UTF-8 byte plus template overhead per
 * message, plus `mediaTokenReserve` per image/audio part (contracts §4 item 5).
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
          Buffer.byteLength(m.content, "utf8") +
          templateOverheadTokens +
          mediaCount(m) * mediaTokenReserve,
        0,
      ),
    );
  return { exact: false, countGroup: count, countPrompt: count };
}
