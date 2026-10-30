// The shared tool loop's server side (D2 amendment to contracts §4.3). One
// session per generation: it offers the allowlisted tools, validates every
// call, runs the read-only general tools against the requesting user's own
// data, and records memory suggestions as proposals (never applied, INV-37).
import { createHash, randomUUID } from "node:crypto";
import type { AttachmentStore } from "../attachments/store.ts";
import type { SearchService } from "../chat/search.ts";
import type { ConversationStore } from "../storage/conversations.ts";
import { isCanonicalUuid } from "../storage/markdown.ts";
import { MEMORY_BODY_MAX, memoryNameProblem, nameKey, type Memory } from "../storage/memories.ts";
import type { ProposalStore, ProposalTool, StagedProposal } from "../storage/proposals.ts";
import { calculate, CalcError, formatNumber } from "./calculate.ts";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACTS_PER_GENERATION,
  artifactNameProblem,
  type StagedArtifact,
} from "../artifacts/store.ts";

/** OpenAI-compatible function tool. */
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  callId: string;
  name: string;
  content: string;
  ok: boolean;
}

/** Tool rounds per generation; the request after the last round offers no tools. */
export const MAX_TOOL_ROUNDS = 3;
export const MAX_CALLS_PER_ROUND = 8;
export const MAX_CALLS_PER_GENERATION = 16;
/** Streamed argument bytes per call: a whole file for `create_file`, bounded by the response cap. */
export const MAX_ARGUMENT_BYTES = 520 * 1024;
/** Proposals per generation (contracts §4.3 per-call bounds). */
export const MAX_PROPOSALS_PER_GENERATION = 8;
/** Characters of one tool result sent back to the model. */
export const TOOL_RESULT_MAX_CHARS = 6_000;

const PROPOSAL_RESULTS = {
  valid:
    "Recorded as a pending memory suggestion for the user to review; it is not saved. Continue your reply to the user.",
  suppressed: "Already suggested; not repeated.",
  invalid: "Not recorded: invalid suggestion.",
} as const;

const fn = (
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required, additionalProperties: false },
  },
});

export const GENERAL_TOOLS: ToolDefinition[] = [
  fn(
    "search_chats",
    "Search the user's earlier chats by words in their titles and messages.",
    { query: { type: "string", description: "Words to look for." } },
    ["query"],
  ),
  fn(
    "read_chat",
    "Read the messages of one of the user's chats (use an id from search_chats).",
    { conversation_id: { type: "string" } },
    ["conversation_id"],
  ),
  fn("list_files", "List the user's uploaded files.", {
    kind: { type: "string", enum: ["image", "audio", "text"] },
  }),
  fn(
    "read_file",
    "Read the text of one of the user's text files (use an id from list_files).",
    { file_id: { type: "string" } },
    ["file_id"],
  ),
  fn("get_current_time", "Get the current date and time.", {}),
  fn(
    "calculate",
    "Evaluate an arithmetic expression (+ - * / % ^, parentheses, sqrt, abs, round, floor, ceil, sin, cos, tan, ln, log, exp, min, max, pi, e).",
    { expression: { type: "string" } },
    ["expression"],
  ),
];

/** Creates a file the user can open from the reply (Phase 13c; captured only if the reply completes). */
export const FILE_TOOLS: ToolDefinition[] = [
  fn(
    "create_file",
    "Create a text file for the user (code, data, a document). They can open, copy and download it from your reply.",
    {
      filename: { type: "string", description: "A file name with an extension, e.g. app.py." },
      content: { type: "string", description: "The complete file content." },
    },
    ["filename", "content"],
  ),
];

export const MEMORY_TOOLS: ToolDefinition[] = [
  fn(
    "remember",
    "Suggest saving a new memory about the user. The user reviews it; nothing is saved until they accept.",
    {
      name: { type: "string", description: "A short unique name (1-64 characters)." },
      content: { type: "string", description: "What to remember." },
    },
    ["name", "content"],
  ),
  fn(
    "update_memory",
    "Suggest replacing the text of one of the saved memories (by its exact name).",
    { name: { type: "string" }, content: { type: "string" } },
    ["name", "content"],
  ),
  fn(
    "forget_memory",
    "Suggest deleting one of the saved memories (by its exact name).",
    { name: { type: "string" } },
    ["name"],
  ),
];

export const TOOL_NAMES = new Set(
  [...GENERAL_TOOLS, ...FILE_TOOLS, ...MEMORY_TOOLS].map((tool) => tool.function.name),
);

export interface ToolSessionContext {
  userId: string;
  conversationId: string;
  generationId: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  providerId: string;
  model: string;
  /** Notes in this generation's prompt (contracts §4.1 step 2 snapshot). */
  snapshot: readonly Memory[];
  timeZone: string;
  now: () => Date;
  store: ConversationStore;
  search: SearchService;
  attachments: AttachmentStore | undefined;
  proposals: ProposalStore;
}

function cap(text: string): string {
  return text.length > TOOL_RESULT_MAX_CHARS
    ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated]`
    : text;
}

function stringArg(args: Record<string, unknown>, key: string, max: number): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

/** Parses a call's JSON arguments; only a plain object with known keys is valid. */
function parseArgs(raw: string, allowed: readonly string[]): Record<string, unknown> | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_ARGUMENT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw === "" ? "{}" : raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const args = value as Record<string, unknown>;
  return Object.keys(args).every((key) => allowed.includes(key)) ? args : null;
}

export class ToolSession {
  readonly definitions: ToolDefinition[];
  private readonly c: ToolSessionContext;
  private calls = 0;
  private readonly usedNames: string[] = [];
  private readonly stagedProposals: StagedProposal[] = [];
  private readonly stagedArtifacts: StagedArtifact[] = [];

  /** Every offered definition (for the prompt budget). */
  static definitionsJson(): ToolDefinition[] {
    return [...GENERAL_TOOLS, ...FILE_TOOLS, ...MEMORY_TOOLS];
  }

  constructor(context: ToolSessionContext) {
    this.c = context;
    this.definitions = [...GENERAL_TOOLS, ...FILE_TOOLS, ...MEMORY_TOOLS];
  }

  /** Tool names used by valid calls, in order of first use (saved as chips). */
  used(): string[] {
    return [...this.usedNames];
  }

  staged(): StagedProposal[] {
    return [...this.stagedProposals];
  }

  /** Files from `create_file`, captured only if the reply completes (INV-40). */
  artifacts(): StagedArtifact[] {
    return [...this.stagedArtifacts];
  }

  previews(): { tool: string; name: string }[] {
    return this.stagedProposals
      .filter((p) => p.status === "pending")
      .map((p) => ({ tool: p.tool, name: p.name }));
  }

  private use(name: string): void {
    if (!this.usedNames.includes(name)) this.usedNames.push(name);
  }

  /** Runs one round of calls in order. Invalid calls get a fixed result and change nothing. */
  async execute(calls: readonly ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const [index, call] of calls.entries()) {
      this.calls++;
      if (index >= MAX_CALLS_PER_ROUND || this.calls > MAX_CALLS_PER_GENERATION) {
        results.push(this.invalid(call, "Not run: too many tool calls."));
        continue;
      }
      try {
        results.push(await this.run(call, this.calls - 1));
      } catch {
        results.push(this.invalid(call, "The tool failed."));
      }
    }
    return results;
  }

  private invalid(call: ToolCall, content: string): ToolResult {
    return { callId: call.id, name: call.name, content, ok: false };
  }

  private ok(call: ToolCall, content: string): ToolResult {
    this.use(call.name);
    return { callId: call.id, name: call.name, content: cap(content), ok: true };
  }

  private async run(call: ToolCall, callIndex: number): Promise<ToolResult> {
    const c = this.c;
    switch (call.name) {
      case "search_chats": {
        const args = parseArgs(call.arguments, ["query"]);
        const query = args && stringArg(args, "query", 200);
        if (!query) return this.invalid(call, "Not run: invalid arguments.");
        const results = await c.search.search(c.userId, query, 10);
        const chats = results.chats.map((chat) => ({
          conversation_id: chat.conversationId,
          title: chat.title,
          updated_at: chat.updatedAt,
          matches: chat.matches,
          snippet: chat.first?.text ?? null,
        }));
        return this.ok(call, JSON.stringify({ chats }));
      }
      case "read_chat": {
        const args = parseArgs(call.arguments, ["conversation_id"]);
        const id = args && stringArg(args, "conversation_id", 36);
        if (!id || !isCanonicalUuid(id)) return this.invalid(call, "Not run: invalid arguments.");
        const read = await c.store.readUnlocked(c.userId, id);
        if (read.kind !== "ok") return this.invalid(call, "That chat is not available.");
        const lines = [`Title: ${read.conversation.model.title}`];
        for (const block of read.conversation.model.blocks) {
          if (block.type === "user") lines.push(`User: ${block.body}`);
          else if (block.type === "assistant" && block.body) lines.push(`Assistant: ${block.body}`);
        }
        return this.ok(call, lines.join("\n\n"));
      }
      case "list_files": {
        const args = parseArgs(call.arguments, ["kind"]);
        const kind = args?.kind;
        if (
          !args ||
          (kind !== undefined && kind !== "image" && kind !== "audio" && kind !== "text")
        )
          return this.invalid(call, "Not run: invalid arguments.");
        const files = (await c.attachments?.list(c.userId)) ?? [];
        const listed = files
          .filter((f) => (kind ? f.kind === kind : true))
          .filter((f) => f.conversationId !== null || f.saved)
          .slice(0, 50)
          .map((f) => ({
            file_id: f.id,
            filename: f.filename,
            kind: f.kind,
            size: f.size,
            conversation_id: f.conversationId,
          }));
        return this.ok(call, JSON.stringify({ files: listed }));
      }
      case "read_file": {
        const args = parseArgs(call.arguments, ["file_id"]);
        const id = args && stringArg(args, "file_id", 36);
        if (!id || !isCanonicalUuid(id)) return this.invalid(call, "Not run: invalid arguments.");
        const meta = await c.attachments?.get(c.userId, id);
        if (!meta || (meta.conversationId === null && !meta.saved))
          return this.invalid(call, "That file is not available.");
        if (meta.kind !== "text") return this.invalid(call, "Only text files can be read.");
        const bytes = await c.attachments?.readBlob(c.userId, id);
        if (!bytes) return this.invalid(call, "That file is not available.");
        return this.ok(call, `${meta.filename}\n\n${bytes.toString("utf8")}`);
      }
      case "get_current_time": {
        if (!parseArgs(call.arguments, []))
          return this.invalid(call, "Not run: invalid arguments.");
        const now = c.now();
        const local = new Intl.DateTimeFormat("en-GB", {
          dateStyle: "full",
          timeStyle: "long",
          timeZone: c.timeZone,
        }).format(now);
        return this.ok(
          call,
          JSON.stringify({ utc: now.toISOString(), local, time_zone: c.timeZone }),
        );
      }
      case "calculate": {
        const args = parseArgs(call.arguments, ["expression"]);
        const expression = args && stringArg(args, "expression", 200);
        if (!expression) return this.invalid(call, "Not run: invalid arguments.");
        try {
          return this.ok(call, formatNumber(calculate(expression)));
        } catch (error) {
          if (error instanceof CalcError) return this.invalid(call, `Error: ${error.message}`);
          throw error;
        }
      }
      case "create_file": {
        const args = parseArgs(call.arguments, ["filename", "content"]);
        const filename = args && stringArg(args, "filename", 100);
        const content = args?.content;
        if (
          !filename ||
          typeof content !== "string" ||
          artifactNameProblem(filename) ||
          Buffer.byteLength(content, "utf8") > ARTIFACT_MAX_BYTES ||
          this.stagedArtifacts.length >= ARTIFACTS_PER_GENERATION
        )
          return this.invalid(call, "Not created: invalid file name, type or size.");
        this.stagedArtifacts.push({
          captureIndex: this.stagedArtifacts.length,
          filename,
          content,
          source: "tool",
        });
        return this.ok(
          call,
          `Created ${filename}. The user can open it from your reply; you need not repeat its content.`,
        );
      }
      case "remember":
      case "update_memory":
      case "forget_memory":
        return this.propose(call, callIndex);
      default:
        return this.invalid(call, "Not run: unknown tool.");
    }
  }

  /** Memory suggestions (contracts §4.3): validated, deduplicated, staged; never applied. */
  private async propose(call: ToolCall, callIndex: number): Promise<ToolResult> {
    const tool = call.name as ProposalTool;
    const keys = tool === "forget_memory" ? ["name"] : ["name", "content"];
    const args = parseArgs(call.arguments, keys);
    const rawName = args?.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const content =
      tool === "forget_memory" ? null : args ? stringArg(args, "content", MEMORY_BODY_MAX) : null;
    if (
      !args ||
      memoryNameProblem(name) ||
      (tool !== "forget_memory" && content === null) ||
      this.stagedProposals.length >= MAX_PROPOSALS_PER_GENERATION
    ) {
      return this.invalid(call, PROPOSAL_RESULTS.invalid);
    }
    const matches = this.c.snapshot.filter((m) => nameKey(m.name) === nameKey(name));
    let target: Memory | null = null;
    if (tool === "remember") {
      if (matches.length > 0) {
        // Already remembered with the same text: nothing to suggest.
        if (matches[0]?.body === content)
          return this.stage(call, callIndex, tool, name, content, null, "suppressed");
        return this.invalid(call, PROPOSAL_RESULTS.invalid);
      }
    } else {
      // update/forget must resolve to exactly one note in this prompt's snapshot (INV-38).
      if (matches.length !== 1 || !matches[0]) return this.invalid(call, PROPOSAL_RESULTS.invalid);
      target = matches[0];
      if (tool === "update_memory" && target.body === content)
        return this.stage(call, callIndex, tool, name, content, target, "suppressed");
    }
    return this.stage(call, callIndex, tool, name, content, target, "pending");
  }

  private async stage(
    call: ToolCall,
    callIndex: number,
    tool: ProposalTool,
    name: string,
    content: string | null,
    target: Memory | null,
    initial: "pending" | "suppressed",
  ): Promise<ToolResult> {
    const c = this.c;
    const targetKey = target ? target.id : nameKey(name);
    const contentHash = createHash("sha256")
      .update(`${tool}\n${targetKey}\n${content ?? ""}`)
      .digest("hex");
    let status = initial;
    if (status === "pending") {
      // The same suggestion pending or rejected in this conversation, or earlier in this reply.
      const earlier = await c.proposals.read(c.userId, c.conversationId);
      const repeat = [...earlier, ...this.stagedProposals].some(
        (p) =>
          p.contentHash === contentHash &&
          (p.status === "pending" || p.status === "rejected" || p.status === "suppressed"),
      );
      if (repeat) status = "suppressed";
    }
    this.stagedProposals.push({
      id: randomUUID(),
      generationId: c.generationId,
      callIndex,
      sourceUserMessageId: c.sourceUserMessageId,
      sourceAssistantMessageId: c.sourceAssistantMessageId,
      providerId: c.providerId,
      model: c.model,
      tool,
      name,
      content,
      targetMemoryId: target?.id ?? null,
      baselineRevision: target?.revision ?? null,
      contentHash,
      status,
      createdAt: c.now().toISOString(),
    });
    this.use(tool);
    return {
      callId: call.id,
      name: call.name,
      content: status === "pending" ? PROPOSAL_RESULTS.valid : PROPOSAL_RESULTS.suppressed,
      ok: true,
    };
  }
}
