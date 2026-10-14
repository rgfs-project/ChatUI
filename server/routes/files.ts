import { z } from "zod";
import { fileItemSchema, fileListSchema, type FileCategory, type FileItem } from "@shared/files";
import { canonicalUuid } from "@shared/ids";
import { defineRoute, userOf } from "../registry.ts";

/**
 * The Files page: uploads (sent with a message, or kept from Files) and the
 * files replies produced, in one list. Reply files keep their own routes for
 * viewing and deleting; uploads are kept and deleted here.
 */

const idParams = z.strictObject({ id: canonicalUuid });

const CODE_LABELS: Record<string, string> = {
  py: "Python",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  rs: "Rust",
  go: "Go",
  java: "Java",
  rb: "Ruby",
  c: "C",
  h: "C",
  cpp: "C++",
  cs: "C#",
  sh: "Shell",
  sql: "SQL",
  css: "CSS",
  html: "HTML",
  swift: "Swift",
  kt: "Kotlin",
  php: "PHP",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
};
const DATA_EXTENSIONS = new Set(["csv", "tsv", "json", "jsonl", "ndjson", "xlsx", "parquet"]);
const DOCUMENT_EXTENSIONS = new Set(["md", "markdown", "txt", "text", "pdf", "rtf", "log"]);

/** A short kind for people and a filter category, from the type and name. */
export function classify(
  name: string,
  mediaType: string,
): { kindLabel: string; category: FileCategory } {
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  if (mediaType.startsWith("image/")) return { kindLabel: "Image", category: "image" };
  if (mediaType.startsWith("audio/")) return { kindLabel: "Audio", category: "audio" };
  const code = CODE_LABELS[ext];
  if (code) return { kindLabel: code, category: "code" };
  if (DATA_EXTENSIONS.has(ext) || mediaType === "text/csv" || mediaType === "application/json")
    return { kindLabel: ext ? ext.toUpperCase() : "Data", category: "data" };
  if (ext === "md" || ext === "markdown" || mediaType === "text/markdown")
    return { kindLabel: "Markdown", category: "document" };
  if (DOCUMENT_EXTENSIONS.has(ext) || mediaType === "text/plain")
    return { kindLabel: ext === "pdf" ? "PDF" : "Text", category: "document" };
  return { kindLabel: ext ? ext.toUpperCase() : "File", category: "other" };
}

export const listFilesRoute = defineRoute({
  method: "get",
  path: "/api/files",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: fileListSchema,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    const { attachments, artifacts, conversations } = ctx.services;
    const titles = new Map(conversations.list(userId).map((c) => [c.id, c.title]));
    const title = (id: string | null) => (id === null ? null : (titles.get(id) ?? null));
    const files: FileItem[] = [
      ...(await attachments.all(userId)).map((meta) => ({
        id: meta.id,
        origin: "upload" as const,
        name: meta.filename,
        mediaType: meta.mediaType,
        ...classify(meta.filename, meta.mediaType),
        size: meta.size,
        createdAt: meta.createdAt,
        conversationId: meta.conversationId,
        conversationTitle: title(meta.conversationId),
        messageId: meta.messageId,
        downloadUrl: `/api/attachments/${meta.id}/content?download=1`,
      })),
      ...(await artifacts.list(userId)).map((meta) => ({
        id: meta.id,
        origin: "reply" as const,
        name: meta.name,
        mediaType: meta.mediaType,
        ...classify(meta.name, meta.mediaType),
        size: meta.size,
        createdAt: meta.createdAt,
        conversationId: meta.conversationId,
        conversationTitle: title(meta.conversationId),
        messageId: meta.assistantMessageId,
        downloadUrl: `/api/artifacts/${meta.id}/source?download=1`,
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return {
      files,
      usedBytes: (await attachments.usage(userId)) + (await artifacts.usedBytes(userId)),
      quotaBytes: attachments.effective().quotaBytes + artifacts.config.quotaBytes,
    };
  },
  fixture: {},
});

export const uploadFileRoute = defineRoute({
  method: "post",
  path: "/api/files",
  auth: "user",
  csrf: "token",
  rateLimit: "upload",
  // multipart/form-data with one `file` part, like attachments.
  request: {},
  response: fileItemSchema,
  status: 201,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    const uploaded = await ctx.services.attachments.upload(userId, ctx.req);
    const meta = await ctx.services.attachments.keep(userId, uploaded.id);
    return {
      id: meta.id,
      origin: "upload" as const,
      name: meta.filename,
      mediaType: meta.mediaType,
      ...classify(meta.filename, meta.mediaType),
      size: meta.size,
      createdAt: meta.createdAt,
      conversationId: null,
      conversationTitle: null,
      messageId: null,
      downloadUrl: `/api/attachments/${meta.id}/content?download=1`,
    };
  },
  fixture: { expectStatus: 400 },
});

export const deleteFileRoute = defineRoute({
  method: "delete",
  path: "/api/files/:id",
  auth: "user",
  csrf: "token",
  request: { params: idParams },
  response: z.strictObject({ ok: z.literal(true) }),
  handler: async ({ params }, ctx) => {
    await ctx.services.attachments.deleteAny(userOf(ctx).userId, params.id);
    return { ok: true as const };
  },
  fixture: { params: { id: "00000000-0000-4000-8000-000000000000" }, expectStatus: 404 },
});
