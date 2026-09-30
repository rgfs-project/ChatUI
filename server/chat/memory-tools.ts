import { createHash } from "node:crypto";
import {
  MEMORY_LIMITS,
  memoryNameKey,
  memoryNameProblem,
  utf8Bytes,
  type ProposalTool,
} from "@shared/memories";
import type { ToolDefinition } from "../providers/types.ts";
import type { MemorySnapshotEntry, StoredMemory } from "../storage/memories.ts";
import type { ProposalRecord } from "../storage/proposals.ts";

/**
 * Proposal-only memory tools (contracts §4.3). The model can only suggest;
 * nothing here writes approved memory (INV-37). The allowlist is fixed by the
 * server: any other tool name is invalid.
 */
export const TOOL_NAMES: Record<ProposalTool, string> = {
  create: "propose_memory_create",
  update: "propose_memory_update",
  forget: "propose_memory_forget",
};

const TOOL_BY_NAME = new Map(
  (Object.entries(TOOL_NAMES) as [ProposalTool, string][]).map(([tool, name]) => [name, tool]),
);

const nameSchema = {
  type: "string",
  minLength: 1,
  maxLength: MEMORY_LIMITS.nameMax,
  description: "Short title of the note (no line breaks).",
};
const contentSchema = {
  type: "string",
  minLength: 1,
  description: "The full text of the note.",
};

export const MEMORY_TOOLS: readonly ToolDefinition[] = [
  {
    name: TOOL_NAMES.create,
    description:
      "Suggest saving a new note about the user for future conversations. The user reviews every suggestion; nothing is saved unless they approve it. Use only for durable facts or preferences the user shared.",
    parameters: {
      type: "object",
      properties: { name: nameSchema, content: contentSchema },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.update,
    description:
      "Suggest replacing the text of one of the user's approved notes (identified by its exact name). The user must approve it.",
    parameters: {
      type: "object",
      properties: { name: nameSchema, content: contentSchema },
      required: ["name", "content"],
      additionalProperties: false,
    },
  },
  {
    name: TOOL_NAMES.forget,
    description:
      "Suggest deleting one of the user's approved notes (identified by its exact name). The user must approve it.",
    parameters: {
      type: "object",
      properties: { name: nameSchema },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

/** The fixed synthetic tool results (contracts §4.3). */
export const TOOL_RESULTS = {
  valid:
    "Recorded as a pending memory suggestion for the user to review; it is not saved. Continue your reply to the user.",
  suppressed: "Already suggested; not repeated.",
  invalid: "Not recorded: invalid suggestion.",
} as const;

/** A streamed call once its request ended (arguments bounded while streaming). */
export interface StreamedCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
  /** Arguments exceeded the per-call bound; the text was cut and the call is invalid. */
  oversized: boolean;
  /** Beyond the per-generation call cap: invalid. */
  overCap: boolean;
}

export type CallOutcome =
  { kind: "valid" | "suppressed"; record: ProposalRecord } | { kind: "invalid"; reason: string };

export function contentHash(content: string | null): string | null {
  return content === null ? null : createHash("sha256").update(content, "utf8").digest("hex");
}

/** Validates the parsed arguments object against the tool's schema (strict keys). */
function parseArguments(
  tool: ProposalTool,
  text: string,
): { name: string; content: string | null } | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "malformed arguments";
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return "arguments not an object";
  const args = raw as Record<string, unknown>;
  const allowed = tool === "forget" ? ["name"] : ["name", "content"];
  if (Object.keys(args).some((key) => !allowed.includes(key))) return "unexpected argument";
  if (typeof args.name !== "string" || memoryNameProblem(args.name)) return "invalid name";
  if (tool === "forget") return { name: args.name.trim(), content: null };
  const content = args.content;
  if (typeof content !== "string" || content.trim() === "") return "invalid content";
  const body = content.replace(/\r\n/g, "\n").trim();
  if (utf8Bytes(body) > MEMORY_LIMITS.contentMaxBytes) return "content too long";
  return { name: args.name.trim(), content: body };
}

export interface ValidationContext {
  /** Notes the prompt included (contracts §4.1 step 2): the only valid targets. */
  snapshot: readonly MemorySnapshotEntry[];
  /** Current approved memory, read without locks when the calls are recorded. */
  current: readonly StoredMemory[];
  /** The conversation's existing proposal records. */
  existing: readonly ProposalRecord[];
  base: Pick<
    ProposalRecord,
    "generationId" | "userMessageId" | "assistantMessageId" | "providerId" | "model"
  >;
  now: string;
  mintId: () => string;
}

/**
 * Validates one generation's calls in index order (contracts §4.3). Invalid
 * calls are never recorded. A valid call that repeats a pending or rejected
 * proposal of this conversation (or an earlier call of this generation), or
 * whose effect already matches current approved memory, is `suppressed`.
 */
export function validateCalls(
  calls: readonly StreamedCall[],
  ctx: ValidationContext,
): CallOutcome[] {
  const byKey = new Map(ctx.snapshot.map((entry) => [memoryNameKey(entry.name), entry]));
  const currentById = new Map(ctx.current.map((note) => [note.id, note]));
  const currentByKey = new Map(ctx.current.map((note) => [memoryNameKey(note.name), note]));
  const seen: ProposalRecord[] = ctx.existing.filter(
    (r) => r.status === "pending" || r.status === "rejected",
  );
  const outcomes: CallOutcome[] = [];
  for (const call of calls) {
    const tool = TOOL_BY_NAME.get(call.name);
    if (!tool) {
      outcomes.push({ kind: "invalid", reason: "unknown tool" });
      continue;
    }
    if (call.overCap) {
      outcomes.push({ kind: "invalid", reason: "over the call cap" });
      continue;
    }
    if (call.oversized) {
      outcomes.push({ kind: "invalid", reason: "oversized arguments" });
      continue;
    }
    const args = parseArguments(tool, call.arguments);
    if (typeof args === "string") {
      outcomes.push({ kind: "invalid", reason: args });
      continue;
    }
    const nameKey = memoryNameKey(args.name);
    const target = byKey.get(nameKey);
    if (tool !== "create" && !target) {
      // Unknown, or omitted from the prompt by the memory budget.
      outcomes.push({ kind: "invalid", reason: "unresolvable target" });
      continue;
    }
    if (tool === "create" && target) {
      // A create for a name the prompt already showed: suppress when it
      // matches, otherwise the model should have proposed an update.
      const note = currentById.get(target.id);
      if (note?.content !== args.content) {
        outcomes.push({ kind: "invalid", reason: "name already exists" });
        continue;
      }
    }
    const record: ProposalRecord = {
      ...ctx.base,
      id: ctx.mintId(),
      callIndex: call.index,
      tool,
      name: tool === "create" ? args.name : (target?.name ?? args.name),
      content: args.content,
      targetMemoryId: tool === "create" ? null : (target?.id ?? null),
      baselineRevision: tool === "create" ? null : (target?.revision ?? null),
      nameKey,
      contentHash: contentHash(args.content),
      status: "pending",
      createdAt: ctx.now,
      decidedAt: null,
      resultMemoryId: null,
      intent: null,
    };
    const duplicate = seen.some(
      (r) =>
        r.tool === record.tool &&
        (record.tool === "create"
          ? r.nameKey === record.nameKey
          : r.targetMemoryId === record.targetMemoryId) &&
        r.contentHash === record.contentHash,
    );
    const effect = (() => {
      if (tool === "create") return currentByKey.get(nameKey)?.content === args.content;
      const note = record.targetMemoryId ? currentById.get(record.targetMemoryId) : undefined;
      if (tool === "update") return note?.content === args.content;
      return note === undefined; // forget: already gone
    })();
    if (duplicate || effect) {
      record.status = "suppressed";
      outcomes.push({ kind: "suppressed", record });
    } else {
      outcomes.push({ kind: "valid", record });
    }
    seen.push(record);
  }
  return outcomes;
}

export function resultFor(outcome: CallOutcome): string {
  return TOOL_RESULTS[outcome.kind];
}
