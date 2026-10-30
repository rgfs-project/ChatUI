// Attachment expansion for prompt assembly (Phase 12, contracts §4 item 4, §7).
import type { ContentPart, ExpandUser, PromptContent } from "../chat/prompt.ts";
import type { Logger } from "../logger.ts";
import type { ConversationModel } from "../storage/markdown.ts";
import { extensionOf } from "./sniff.ts";
import type { AttachmentMeta, AttachmentStore } from "./store.ts";

export interface ExpansionOptions {
  store: AttachmentStore;
  userId: string;
  /** Input modalities the server-verified model accepts. */
  modalities: readonly ("text" | "image" | "audio")[];
  /** The user's `historyImages` preference: `omit` sends only the newest message's images. */
  historyImages: "include" | "omit";
  maxInlineTextBytes: number;
  /** Most recent image/audio parts in one prompt (the newest message's always count). */
  maxPromptMediaParts: number;
  logger: Logger;
}

const AUDIO_FORMAT: Record<string, "wav" | "mp3" | "flac"> = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
};

/** A fence longer than any backtick run in the text, so the file cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Text attachments are inlined as fenced blocks labelled with the filename. */
export function inlineText(meta: AttachmentMeta, bytes: Buffer, limit: number): string {
  const truncated = bytes.length > limit;
  // A cut inside a multi-byte character decodes to U+FFFD; drop that partial character.
  // (TextDecoder also drops a leading byte-order mark.)
  let text = new TextDecoder("utf-8").decode(truncated ? bytes.subarray(0, limit) : bytes);
  if (truncated) text = text.replace(/\uFFFD+$/, "");
  const fence = fenceFor(text);
  const ext = extensionOf(meta.filename);
  const info = /^[a-z0-9]{1,16}$/.test(ext) ? ext : "";
  const marker = truncated
    ? `\n[Truncated: showing the first ${String(limit)} of ${String(bytes.length)} bytes of ${meta.filename}]`
    : "";
  return `Attached file: ${meta.filename}\n${fence}${info}\n${text}\n${fence}${marker}`;
}

function mediaNote(meta: AttachmentMeta, reason: "capability" | "earlier"): string {
  const what = meta.kind === "image" ? "image" : "audio file";
  return reason === "capability"
    ? `[An ${what} (${meta.filename}) was attached here; this model cannot ${meta.kind === "image" ? "view images" : "listen to audio"}.]`
    : `[An earlier ${what} (${meta.filename}) is not included again.]`;
}

/**
 * Loads what the prompt needs and returns a synchronous expander for user
 * blocks. Images and audio become typed parts only for a model with the
 * matching modality (INV-44); the newest message's media are always included
 * (the send path has already checked the capability), earlier ones up to
 * `maxPromptMediaParts` (newest first), and images are skipped entirely when
 * `historyImages` is `omit`. Skipped media become a short text note. A
 * missing attachment is skipped with a warning, never an error.
 */
export async function prepareExpansion(
  model: ConversationModel,
  options: ExpansionOptions,
): Promise<ExpandUser> {
  const users = model.blocks.filter(
    (block): block is Extract<typeof block, { type: "user" }> => block.type === "user",
  );
  const newest = users.at(-1);
  const ids = [...new Set(users.flatMap((block) => block.attachments ?? []))];
  const metas = new Map<string, AttachmentMeta>();
  for (const id of ids) {
    const meta = await options.store.get(options.userId, id);
    if (meta) metas.set(id, meta);
  }

  // Media selection, newest message first.
  const included = new Set<string>();
  const notes = new Map<string, string>();
  let budget = options.maxPromptMediaParts;
  for (const block of [...users].reverse()) {
    for (const id of block.attachments ?? []) {
      const meta = metas.get(id);
      if (!meta || meta.kind === "text") continue;
      if (block === newest) {
        included.add(id);
        budget--;
      } else if (!options.modalities.includes(meta.kind)) {
        notes.set(id, mediaNote(meta, "capability"));
      } else if ((meta.kind === "image" && options.historyImages === "omit") || budget <= 0) {
        notes.set(id, mediaNote(meta, "earlier"));
      } else {
        included.add(id);
        budget--;
      }
    }
  }

  const bytes = new Map<string, Buffer>();
  for (const [id, meta] of metas) {
    if (meta.kind !== "text" && !included.has(id)) continue;
    const blob = await options.store.readBlob(options.userId, id);
    if (blob) bytes.set(id, blob);
  }

  return (block): PromptContent => {
    const texts: string[] = block.body === "" ? [] : [block.body];
    const media: ContentPart[] = [];
    for (const id of block.attachments ?? []) {
      const meta = metas.get(id);
      const blob = bytes.get(id);
      const note = notes.get(id);
      if (note !== undefined) {
        texts.push(note);
      } else if (!meta || !blob) {
        options.logger.warn({ attachmentId: id }, "prompt skips a missing attachment");
      } else if (meta.kind === "text") {
        texts.push(inlineText(meta, blob, options.maxInlineTextBytes));
      } else if (meta.kind === "image") {
        media.push({
          type: "image_url",
          image_url: { url: `data:${meta.mediaType};base64,${blob.toString("base64")}` },
        });
      } else {
        media.push({
          type: "input_audio",
          input_audio: {
            data: blob.toString("base64"),
            format: AUDIO_FORMAT[meta.mediaType] ?? "wav",
          },
        });
      }
    }
    const text = texts.join("\n\n");
    if (media.length === 0) return text;
    return text === "" ? media : [{ type: "text", text }, ...media];
  };
}
