import { z } from "zod";
import { usageDtoSchema } from "@shared/usage";
import { defineRoute, userOf } from "../registry.ts";
import type { ConversationModel } from "../storage/markdown.ts";

/**
 * Settings → Usage: counts worked out from the account's own chat files.
 * Each chat's tallies are cached by file size and mtime, so a reload only
 * re-reads the chats that changed.
 */

interface ChatTally {
  /** UTC date → [sent, replies]. */
  days: Map<string, [number, number]>;
  /** "provider\u0000model" → replies. */
  models: Map<string, number>;
  sent: number;
  replies: number;
}

const DAYS = 30;
const tallies = new Map<string, { stamp: string; tally: ChatTally }>();

function tally(model: ConversationModel): ChatTally {
  const result: ChatTally = { days: new Map(), models: new Map(), sent: 0, replies: 0 };
  for (const block of model.blocks) {
    if (block.type !== "user" && block.type !== "assistant") continue;
    const day = (block.time ?? model.updatedAt).slice(0, 10);
    const counts = result.days.get(day) ?? [0, 0];
    if (block.type === "user") {
      result.sent++;
      counts[0]++;
    } else {
      result.replies++;
      counts[1]++;
      if (block.model) {
        const key = `${block.provider ?? ""}\u0000${block.model}`;
        result.models.set(key, (result.models.get(key) ?? 0) + 1);
      }
    }
    result.days.set(day, counts);
  }
  return result;
}

export const usageRoute = defineRoute({
  method: "get",
  path: "/api/usage",
  auth: "user",
  csrf: "none",
  request: { query: z.strictObject({}) },
  response: usageDtoSchema,
  handler: async (_input, ctx) => {
    const userId = userOf(ctx).userId;
    const { services } = ctx;
    const chats = services.conversations.list(userId);
    const library = await services.library.get(userId);
    const archived = new Set(library.archived);

    const days = new Map<string, [number, number]>();
    const models = new Map<string, number>();
    let sent = 0;
    let replies = 0;
    let chatsBytes = 0;
    for (const entry of chats) {
      chatsBytes += entry.fileSize;
      const key = `${userId}/${entry.id}`;
      const stamp = `${String(entry.fileSize)}:${String(entry.fileMtimeMs)}`;
      let cached = tallies.get(key);
      if (cached?.stamp !== stamp) {
        const read = await services.conversations.readUnlocked(userId, entry.id);
        if (read.kind !== "ok") continue;
        cached = { stamp, tally: tally(read.conversation.model) };
        tallies.set(key, cached);
      }
      const t = cached.tally;
      sent += t.sent;
      replies += t.replies;
      for (const [day, [s, r]] of t.days) {
        const counts = days.get(day) ?? [0, 0];
        counts[0] += s;
        counts[1] += r;
        days.set(day, counts);
      }
      for (const [model, count] of t.models) models.set(model, (models.get(model) ?? 0) + count);
    }

    const today = new Date();
    const series = Array.from({ length: DAYS }, (_, index) => {
      const date = new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() - (DAYS - 1 - index),
        ),
      )
        .toISOString()
        .slice(0, 10);
      const [daySent, dayReplies] = days.get(date) ?? [0, 0];
      return { date, sent: daySent, replies: dayReplies };
    });

    const artifacts = services.artifacts;
    return {
      chats: chats.filter((c) => !archived.has(c.id)).length,
      archivedChats: chats.filter((c) => archived.has(c.id)).length,
      projects: library.projects.length,
      messages: { sent, replies },
      days: series,
      models: [...models]
        .map(([key, count]) => {
          const [provider = "", model = ""] = key.split("\u0000");
          return { provider, model, replies: count };
        })
        .sort((a, b) => b.replies - a.replies || a.model.localeCompare(b.model))
        .slice(0, 20),
      storage: {
        chatsBytes,
        attachmentsBytes: await services.attachments.usage(userId),
        filesBytes: await artifacts.usedBytes(userId),
        attachmentQuotaBytes: services.attachments.effective().quotaBytes,
        filesQuotaBytes: artifacts.config.quotaBytes,
      },
      memories: (await services.memories.list(userId)).notes.length,
      skills: (await services.skills.list(userId)).length,
    };
  },
  fixture: {},
});
