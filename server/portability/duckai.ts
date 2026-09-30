// The duck.ai chat download adapter (added at the owner's request with Phase
// 13e; contracts §12: an independently specified and tested adapter). Reads
// only the layout recorded in docs/duckai-export-notes.md.
import { readFile, stat } from "node:fs/promises";
import {
  normalizeBody,
  serializeConversation,
  validateModel,
  type Block,
} from "../storage/markdown.ts";
import {
  checkDeadline,
  derivedUuid,
  sha256,
  StageWriter,
  type ImportAdapter,
  type UploadContext,
} from "./adapters.ts";
import { ArchiveError } from "./read-archive.ts";

const BOM = "\ufeff";
const SIGNATURE = "This conversation was generated with Duck.ai";
const FIRST_LINE =
  /^This conversation was generated with Duck\.ai \(https:\/\/duck\.ai\) using (.+?)'s (.+?) Model\. AI chats may display inaccurate or offensive information/;
const RULE = /^=+$/;
const SEPARATOR = /^-{20}$/;
const HEADING =
  /^User prompt (\d+) of (\d+) - (\d{4})-(\d{2})-(\d{2}), (\d{1,2}):(\d{2}):(\d{2}) ([ap])\.m\.:$/;
const TITLE_MAX = 80;
const UNTITLED = "Untitled chat";

/** True when `timeZone` is an IANA zone this runtime knows. */
export function validTimeZone(timeZone: string | null): timeZone is string {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return local - Math.floor(ms / 1000) * 1000;
}

/** A wall-clock time in `timeZone` (or UTC) as a UTC instant. */
export function wallTimeToUtc(
  fields: [number, number, number, number, number, number],
  timeZone: string | null,
): number {
  const [year, month, day, hour, minute, second] = fields;
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!timeZone) return asUtc;
  // Two passes settle the offset across a DST change.
  const first = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(first, timeZone);
}

interface Section {
  n: number;
  time: string;
  prompt: string;
  answer: string | null;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/** Splits the chat into its prompt sections (numbered 1 to the declared total). */
function parseSections(lines: string[], model: string, timeZone: string | null): Section[] {
  // A heading counts only where the layout puts one: after the ==== rule, or
  // after a blank, the 20-dash separator and a blank; and numbered in order.
  const starts: { index: number; match: RegExpExecArray }[] = [];
  let total: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const match = HEADING.exec(lines[i] ?? "");
    if (!match) continue;
    const n = Number(match[1]);
    const declared = Number(match[2]);
    const placed =
      starts.length === 0
        ? trimBlank(lines.slice(0, i)).every((l) => RULE.test(l))
        : SEPARATOR.test(lines[i - 2] ?? "") && (lines[i - 1] ?? "").trim() === "";
    if (!placed || n !== starts.length + 1 || (total !== null && declared !== total)) continue;
    total = declared;
    starts.push({ index: i, match });
  }
  if (starts.length === 0) throw new ArchiveError("This duck.ai chat has no prompts");
  if (starts.length !== total)
    throw new ArchiveError(
      `This duck.ai chat declares ${String(total)} prompts but ${String(starts.length)} were found`,
    );
  const heading = `${model}:`;
  return starts.map(({ index, match }, k) => {
    const end = k + 1 < starts.length ? (starts[k + 1]?.index ?? lines.length) - 2 : lines.length;
    const body = lines.slice(index + 1, end);
    const answerAt = body.findIndex((l, j) => l === heading && (j === 0 || body[j - 1] === ""));
    const [, n = "0", , y = "0", mo = "0", d = "0", h = "0", mi = "0", s = "0", ap = "a"] = match;
    let hour = Number(h) % 12;
    if (ap === "p") hour += 12;
    const ms = wallTimeToUtc(
      [Number(y), Number(mo), Number(d), hour, Number(mi), Number(s)],
      timeZone,
    );
    if (Number.isNaN(ms) || Number(h) < 1 || Number(h) > 12)
      throw new ArchiveError(`Prompt ${n}'s time isn't valid`);
    return {
      n: Number(n),
      time: new Date(ms).toISOString(),
      prompt: normalizeBody(trimBlank(answerAt < 0 ? body : body.slice(0, answerAt)).join("\n")),
      answer: answerAt < 0 ? null : normalizeBody(trimBlank(body.slice(answerAt + 1)).join("\n")),
    };
  });
}

export const duckaiAdapter: ImportAdapter = {
  source: "duckai",
  detect: (probe) =>
    probe.zipEntries === null &&
    probe.head
      .toString("utf8")
      .replace(/^\ufeff/, "")
      .startsWith(SIGNATURE),
  async stage(ctx: UploadContext) {
    if ((await stat(ctx.file)).size > ctx.limits.maxJsonBytes)
      throw new ArchiveError("The chat is larger than the import limit for one document");
    const bytes = await readFile(ctx.file);
    const text = bytes.toString("utf8");
    const lines = (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, "\n").split("\n");
    const first = FIRST_LINE.exec(lines[0] ?? "");
    if (!first) throw new ArchiveError("This duck.ai chat's first line isn't in the known format");
    const model = (first[2] ?? "").trim();
    const zone = validTimeZone(ctx.timeZone) ? ctx.timeZone : null;
    const sections = parseSections(lines.slice(1), model, zone);
    checkDeadline(ctx);

    const w = await new StageWriter(ctx).init();
    const fileKey = sha256(bytes);
    const id = derivedUuid("duckai-conversation", fileKey);
    const blocks: Block[] = [];
    const notes: string[] = [
      zone
        ? `Prompt times were read in your time zone (${zone}); duck.ai records none.`
        : "No time zone was available, so prompt times were read as UTC.",
    ];
    const unanswered: number[] = [];
    for (const section of sections) {
      const n = String(section.n);
      blocks.push({
        type: "user",
        id: derivedUuid("duckai-user", fileKey, n),
        time: section.time,
        body: section.prompt,
      });
      if (section.answer === null) {
        unanswered.push(section.n);
        continue;
      }
      // duck.ai records no time for a response: none is invented.
      blocks.push({
        type: "assistant",
        id: derivedUuid("duckai-assistant", fileKey, n),
        status: "complete",
        model,
        body: section.answer,
      });
    }
    if (unanswered.length > 0)
      notes.push(`No response was found for prompt ${unanswered.join(", ")}`);
    const firstLine = sections[0]?.prompt.split("\n").find((l) => l.trim() !== "") ?? "";
    const title = Array.from(firstLine.trim()).slice(0, TITLE_MAX).join("").trim() || UNTITLED;
    const conversation = {
      title,
      createdAt: sections[0]?.time ?? ctx.now,
      updatedAt: sections.at(-1)?.time ?? ctx.now,
      blocks,
    };
    const problem = validateModel(conversation);
    if (problem) throw new ArchiveError(`This duck.ai chat can't be converted (${problem})`);
    w.count(1 + blocks.length);
    await w.add("conversation", id, Buffer.from(serializeConversation(conversation), "utf8"));
    return {
      source: "duckai",
      key: fileKey,
      exportCreatedAt: conversation.updatedAt,
      entries: w.entries,
      unknown: [],
      notes,
      skipped: [],
    };
  },
};
