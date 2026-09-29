// Canonical conversation Markdown, formatVersion 1 (contracts §3). Pure: no
// clock, no randomness, no I/O. Loadable natively by Node (relative .ts
// imports, no path aliases) so operator CLI commands can use it.
import { isScalar, isSeq, parseDocument, type Pair, type Scalar } from "yaml";

export const FORMAT_VERSION = 1;
export const NEW_CONVERSATION_TITLE = "New conversation";

export type AssistantStatus = "complete" | "cancelled" | "failed" | "timed_out" | "interrupted";
export const ASSISTANT_STATUSES: readonly AssistantStatus[] = [
  "complete",
  "cancelled",
  "failed",
  "timed_out",
  "interrupted",
];

export interface SystemBlock {
  type: "system";
  id: string;
  body: string;
}
export interface UserBlock {
  type: "user";
  id: string;
  attachments?: string[];
  time?: string;
  body: string;
}
export interface ReasoningBlock {
  type: "reasoning";
  /** Equals the id of the assistant block that immediately follows. */
  id: string;
  body: string;
}
export interface AssistantBlock {
  type: "assistant";
  id: string;
  status: AssistantStatus;
  provider?: string;
  model?: string;
  time?: string;
  body: string;
}
export type Block = SystemBlock | UserBlock | ReasoningBlock | AssistantBlock;

export interface ConversationModel {
  title: string;
  createdAt: string;
  updatedAt: string;
  blocks: Block[];
}

export type ParseResult =
  { ok: true; conversation: ConversationModel } | { ok: false; reason: string; line: number };

// ---------------------------------------------------------------------------
// Shared value rules

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DELIMITER_LIKE = /^[ \t]*<!--[ \t]*cc:/;
const ESCAPED_DELIMITER = /^\\+[ \t]*<!--[ \t]*cc:/;
const NEEDS_ESCAPE = /^\\*[ \t]*<!--[ \t]*cc:/;
const BLANK = /^[ \t]*$/;
/** Characters treated as line breaks in titles. */
const LINE_BREAK = /[\n\r\u0085\u2028\u2029]/;

export function isCanonicalUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Canonical UTC ISO timestamp with milliseconds that denotes a real instant. */
export function isCanonicalTimestamp(value: string): boolean {
  if (!TIMESTAMP_RE.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

export function titleProblem(title: string): string | undefined {
  const length = Array.from(title).length;
  if (length < 1 || length > 200) return "title must be 1-200 characters";
  if (LINE_BREAK.test(title)) return "title must not contain line breaks";
  return undefined;
}

// ---------------------------------------------------------------------------
// Parser

function malformed(reason: string, line: number): ParseResult {
  return { ok: false, reason, line };
}

type Attrs = Map<string, { value: string; quoted: boolean }>;

const TYPES = new Set(["system", "user", "reasoning", "assistant"]);
const KEYS = new Set(["id", "status", "provider", "model", "attachments", "time"]);
const ALLOWED: Record<Block["type"], ReadonlySet<string>> = {
  system: new Set(["id"]),
  user: new Set(["id", "attachments", "time"]),
  reasoning: new Set(["id"]),
  assistant: new Set(["id", "status", "provider", "model", "time"]),
};

/** Tokenizes a full delimiter line per the §3.4 grammar. */
function parseDelimiter(line: string): { type: Block["type"]; attrs: Attrs } | string {
  let i = 0;
  const skipWs = () => {
    while (line[i] === " " || line[i] === "\t") i++;
  };
  skipWs();
  if (!line.startsWith("<!--", i)) return "delimiter must start with <!--";
  i += 4;
  skipWs();
  if (!line.startsWith("cc:", i)) return "delimiter must contain cc:";
  i += 3;
  const typeMatch = /^[a-z]+/.exec(line.slice(i));
  const type = typeMatch?.[0] ?? "";
  if (!TYPES.has(type)) return `unknown block type "${type}"`;
  i += type.length;
  const attrs: Attrs = new Map();
  for (;;) {
    const beforeWs = i;
    skipWs();
    if (line.startsWith("-->", i)) {
      i += 3;
      skipWs();
      if (i !== line.length) return "unexpected text after -->";
      return { type: type as Block["type"], attrs };
    }
    if (i === beforeWs) return "attributes must be separated by whitespace";
    const keyMatch = /^[a-z]+(?==)/.exec(line.slice(i));
    if (!keyMatch) return "invalid attribute";
    const key = keyMatch[0];
    if (!KEYS.has(key)) return `unknown attribute "${key}"`;
    if (attrs.has(key)) return `duplicate attribute "${key}"`;
    i += key.length + 1;
    if (line[i] === '"') {
      // JSON string literal: raw control characters are excluded by definition.
      // eslint-disable-next-line no-control-regex
      const quoted = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(
        line.slice(i),
      );
      if (!quoted) return `invalid quoted value for "${key}"`;
      let value: unknown;
      try {
        value = JSON.parse(quoted[0]);
      } catch {
        return `invalid quoted value for "${key}"`;
      }
      attrs.set(key, { value: value as string, quoted: true });
      i += quoted[0].length;
    } else {
      const bare = /^[A-Za-z0-9._-]+/.exec(line.slice(i));
      if (!bare) return `invalid value for "${key}"`;
      attrs.set(key, { value: bare[0], quoted: false });
      i += bare[0].length;
    }
  }
}

function buildBlock(type: Block["type"], attrs: Attrs, body: string): Block | string {
  for (const key of attrs.keys()) {
    if (!ALLOWED[type].has(key)) return `attribute "${key}" is not allowed on ${type}`;
  }
  const id = attrs.get("id")?.value;
  if (id === undefined) return `${type} requires id`;
  if (!isCanonicalUuid(id)) return "id must be a canonical lowercase UUID";
  const time = attrs.get("time");
  if (time && (!time.quoted || !isCanonicalTimestamp(time.value))) {
    return "time must be a quoted canonical UTC timestamp";
  }
  switch (type) {
    case "system":
      return { type, id, body };
    case "reasoning":
      return { type, id, body };
    case "user": {
      const block: UserBlock = { type, id, body };
      const attachments = attrs.get("attachments");
      if (attachments) {
        const ids = attachments.value.split(",");
        if (
          !attachments.quoted ||
          ids.length < 1 ||
          ids.length > 10 ||
          !ids.every((value) => isCanonicalUuid(value))
        ) {
          return "attachments must be a quoted list of 1-10 canonical UUIDs";
        }
        block.attachments = ids;
      }
      if (time) block.time = time.value;
      return block;
    }
    case "assistant": {
      const status = attrs.get("status")?.value;
      if (status === undefined) return "assistant requires status";
      if (!(ASSISTANT_STATUSES as readonly string[]).includes(status))
        return `invalid status "${status}"`;
      const block: AssistantBlock = { type, id, status: status as AssistantStatus, body };
      const provider = attrs.get("provider");
      const model = attrs.get("model");
      if (provider) block.provider = provider.value;
      if (model) block.model = model.value;
      if (time) block.time = time.value;
      return block;
    }
  }
}

/** Strips leading and trailing blank lines; keeps everything else exactly. */
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && BLANK.test(lines[start] ?? "")) start++;
  while (end > start && BLANK.test(lines[end - 1] ?? "")) end--;
  return lines.slice(start, end);
}

function parseFrontMatter(
  yamlText: string,
  firstLine: number,
): ParseResult | Omit<ConversationModel, "blocks"> {
  const doc = parseDocument(yamlText, { schema: "core", uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) {
    const duplicate = doc.errors.some((error) => error.code === "DUPLICATE_KEY");
    return malformed(
      duplicate ? "duplicate front matter key" : "front matter is not valid YAML",
      firstLine,
    );
  }
  const contents = doc.contents;
  if (!contents || isScalar(contents) || isSeq(contents) || !("items" in contents)) {
    return malformed("front matter must be a mapping", firstLine);
  }
  const items = contents.items as Pair[];
  const expected = ["formatVersion", "title", "createdAt", "updatedAt"];
  const keys = items.map((pair) => (isScalar(pair.key) ? pair.key.value : undefined));
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return malformed(
      "front matter must have exactly formatVersion, title, createdAt, updatedAt in order",
      firstLine,
    );
  }
  const values = items.map((pair) => pair.value);
  const [version, title, createdAt, updatedAt] = values as (Scalar | null)[];
  if (
    !isScalar(version) ||
    version.value !== FORMAT_VERSION ||
    version.type !== "PLAIN" ||
    !/^(?:\+?0*1|0o0*1|0x0*1)$/.test(String(version.source))
  ) {
    return malformed("formatVersion must be the integer 1", firstLine);
  }
  if (!isScalar(title) || typeof title.value !== "string")
    return malformed("title must be a string", firstLine);
  const problem = titleProblem(title.value);
  if (problem) return malformed(problem, firstLine);
  for (const [name, value] of [
    ["createdAt", createdAt],
    ["updatedAt", updatedAt],
  ] as const) {
    if (!isScalar(value) || typeof value.value !== "string" || !isCanonicalTimestamp(value.value)) {
      return malformed(`${name} must be a canonical UTC timestamp`, firstLine);
    }
  }
  return {
    title: title.value,
    createdAt: (createdAt as Scalar<string>).value,
    updatedAt: (updatedAt as Scalar<string>).value,
  };
}

/**
 * Parses canonical Markdown. Never throws for content problems: returns
 * `malformed` with a reason and 1-based line number (contracts §3.7).
 */
export function parseConversation(input: string): ParseResult {
  const text = (input.startsWith("\ufeff") ? input.slice(1) : input).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[0] !== "---") return malformed("file must start with front matter (---)", 1);
  const close = lines.indexOf("---", 1);
  if (close < 0) return malformed("front matter is not closed", 1);
  const front = parseFrontMatter(lines.slice(1, close).join("\n"), 2);
  if ("ok" in front) return front;

  const blocks: Block[] = [];
  let current: { type: Block["type"]; attrs: Attrs; line: number; body: string[] } | undefined;
  const flush = (): string | undefined => {
    if (!current) return undefined;
    const built = buildBlock(current.type, current.attrs, trimBlankLines(current.body).join("\n"));
    if (typeof built === "string") return built;
    blocks.push(built);
    return undefined;
  };

  for (let index = close + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    if (DELIMITER_LIKE.test(line)) {
      const parsed = parseDelimiter(line);
      if (typeof parsed === "string") return malformed(parsed, lineNo);
      const problem = flush();
      if (problem) return malformed(problem, current?.line ?? lineNo);
      current = { type: parsed.type, attrs: parsed.attrs, line: lineNo, body: [] };
      continue;
    }
    const content = ESCAPED_DELIMITER.test(line) ? line.slice(1) : line;
    if (!current) {
      if (!BLANK.test(line)) return malformed("text before the first message delimiter", lineNo);
      continue;
    }
    current.body.push(content);
  }
  const problem = flush();
  if (problem) return malformed(problem, current?.line ?? lines.length);

  // Structural rules: unique ids; reasoning immediately followed by its assistant.
  const seen = new Set<string>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block) continue;
    if (block.type === "reasoning") {
      const next = blocks[index + 1];
      if (next?.type !== "assistant" || next.id !== block.id) {
        return malformed(
          "a reasoning block must be immediately followed by the assistant block with the same id",
          0,
        );
      }
      continue;
    }
    if (seen.has(block.id)) return malformed(`duplicate id ${block.id}`, 0);
    seen.add(block.id);
  }
  return { ok: true, conversation: { ...front, blocks } };
}

// ---------------------------------------------------------------------------
// Serializer

/** JSON string literal with <, > and & escaped, plus YAML-unsafe characters. */
function quote(value: string): string {
  return JSON.stringify(value).replace(/[<>&\u007f-\u009f\u2028\u2029\ufeff]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

function delimiter(block: Block): string {
  const parts = [`<!-- cc:${block.type}`, `id=${block.id}`];
  if (block.type === "assistant") {
    parts.push(`status=${block.status}`);
    if (block.provider !== undefined) parts.push(`provider=${quote(block.provider)}`);
    if (block.model !== undefined) parts.push(`model=${quote(block.model)}`);
    if (block.time !== undefined) parts.push(`time=${quote(block.time)}`);
  }
  if (block.type === "user") {
    if (block.attachments !== undefined)
      parts.push(`attachments=${quote(block.attachments.join(","))}`);
    if (block.time !== undefined) parts.push(`time=${quote(block.time)}`);
  }
  parts.push("-->");
  return parts.join(" ");
}

function escapeBody(body: string): string {
  return body
    .split("\n")
    .map((line) => (NEEDS_ESCAPE.test(line) ? `\\${line}` : line))
    .join("\n");
}

/** Pure serializer: LF only, canonical attribute order, one trailing newline. */
export function serializeConversation(model: ConversationModel): string {
  const front = [
    "---",
    `formatVersion: ${String(FORMAT_VERSION)}`,
    `title: ${quote(model.title)}`,
    `createdAt: ${quote(model.createdAt)}`,
    `updatedAt: ${quote(model.updatedAt)}`,
    "---",
    "",
  ].join("\n");
  if (model.blocks.length === 0) return front;
  const parts = model.blocks.map((block) => {
    const body = escapeBody(block.body);
    return `${delimiter(block)}\n${body ? `${body}\n` : ""}`;
  });
  return `${front}\n${parts.join("\n")}`;
}

/**
 * Normalizes external text (user input, provider output) into a canonical
 * body: CRLF → LF, leading/trailing blank lines removed (contracts §3.6).
 */
export function normalizeBody(text: string): string {
  return trimBlankLines(text.replace(/\r\n/g, "\n").split("\n")).join("\n");
}

/** Validates a model before serialization (the serializer assumes validity). */
export function validateModel(model: ConversationModel): string | undefined {
  const reparsed = parseConversation(serializeConversation(model));
  if (!reparsed.ok) return reparsed.reason;
  return undefined;
}
