// DTO builders shared by API routes and SSR document loaders, so the data a
// document dehydrates is exactly what the API would return (INV-03, INV-56).
import {
  conversationSummarySchema,
  type ConversationResult,
  type ConversationSummary,
} from "@shared/conversations";
import { preferencesDtoSchema, type PreferencesDto } from "@shared/preferences";
import type { RouteServices } from "../registry.ts";
import type { ProviderModelsDto } from "@shared/generations";
import type { InstanceSettings, SettingsStore } from "../admin/settings.ts";
import { instanceDtoSchema, type InstanceDto } from "@shared/instance";
import { StorageError } from "../storage/conversations.ts";
import type { Preferences } from "../storage/preferences.ts";

export function conversationSummaries(
  services: RouteServices,
  userId: string,
): ConversationSummary[] {
  // Temporary chats are never listed (Phase 13f).
  const temporary = services.temporary.ids(userId);
  return services.conversations
    .list(userId)
    .filter((entry) => !temporary.has(entry.id))
    .map((entry) =>
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

/** Models a user may see: admins see all; hidden pairs exist for nobody else (Phase 10). */
export function visibleModels(
  groups: ProviderModelsDto[],
  settings: SettingsStore,
  role: "user" | "admin",
): ProviderModelsDto[] {
  if (role === "admin") return groups;
  return groups.map((group) => ({
    ...group,
    models: group.models.filter((m) => !settings.isHidden(group.provider.id, m.id)),
  }));
}

export function instanceDto(settings: InstanceSettings): InstanceDto {
  return instanceDtoSchema.parse({ notice: settings.notice, defaultModel: settings.defaultModel });
}
