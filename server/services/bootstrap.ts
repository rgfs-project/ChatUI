// DTO builders shared by API routes and SSR document loaders, so the data a
// document dehydrates is exactly what the API would return (INV-03, INV-56).
import {
  conversationSummarySchema,
  type ConversationResult,
  type ConversationSummary,
} from "@shared/conversations";
import { preferencesDtoSchema, type PreferencesDto } from "@shared/preferences";
import type { RouteServices } from "../registry.ts";
import { StorageError } from "../storage/conversations.ts";
import type { Preferences } from "../storage/preferences.ts";

export function conversationSummaries(
  services: RouteServices,
  userId: string,
): ConversationSummary[] {
  return services.conversations.list(userId).map((entry) =>
    conversationSummarySchema.parse({
      id: entry.id,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      malformed: entry.malformed,
    }),
  );
}

export function preferencesDto(p: Preferences): PreferencesDto {
  return preferencesDtoSchema.parse({
    pins: p.pins,
    defaultProvider: p.defaultProvider,
    defaultModel: p.defaultModel,
    historyImages: p.historyImages,
    imageMaxEdge: p.imageMaxEdge,
  });
}

/** Not found and malformed are results; any other failure still throws. */
export async function conversationResult(
  services: RouteServices,
  userId: string,
  id: string,
): Promise<ConversationResult> {
  try {
    return { ok: true, conversation: await services.conversationDto(userId, id) };
  } catch (error) {
    if (error instanceof StorageError && error.kind === "not_found")
      return { ok: false, code: "NOT_FOUND" };
    if (error instanceof StorageError && error.kind === "malformed")
      return { ok: false, code: "CONVERSATION_MALFORMED" };
    throw error;
  }
}
