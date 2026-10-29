import type { ConversationDto } from "@shared/conversations";
import type { ModelDto, ProviderModelsDto } from "@shared/generations";
import type { PreferencesDto } from "@shared/preferences";

/** A `(providerId, modelId)` pair; ids are opaque and never parsed (INV-18). */
export type ModelPair = readonly [providerId: string, modelId: string];

export const pairKey = (pair: ModelPair): string => JSON.stringify(pair);

export function pairOfKey(key: string): ModelPair | null {
  try {
    const value = JSON.parse(key) as unknown;
    return Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
      ? [value[0], value[1]]
      : null;
  } catch {
    return null;
  }
}

export function allModels(groups: ProviderModelsDto[]): ModelDto[] {
  return groups.flatMap((g) => g.models);
}

function find(models: ModelDto[], pair: ModelPair | null | undefined): ModelPair | null {
  if (!pair) return null;
  return models.some((m) => m.providerId === pair[0] && m.id === pair[1]) ? pair : null;
}

/**
 * Selection order: the choice made for this conversation in this tab → the
 * conversation's latest reply → the user's last-used pair → the default model
 * preference → a loaded model → any model. The server validates every send.
 */
export function chooseModel(input: {
  groups: ProviderModelsDto[];
  chosen?: ModelPair | null;
  conversation?: ConversationDto | null;
  lastUsed?: ModelPair | null;
  preferences?: PreferencesDto | null;
}): ModelPair | null {
  const models = allModels(input.groups);
  const lastReply = [...(input.conversation?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && m.provider && m.model);
  const preferred =
    input.preferences?.defaultProvider && input.preferences.defaultModel
      ? ([input.preferences.defaultProvider, input.preferences.defaultModel] as const)
      : null;
  const loaded = models.find((m) => m.status === "loaded") ?? models[0];
  return (
    find(models, input.chosen) ??
    find(models, lastReply ? [lastReply.provider ?? "", lastReply.model ?? ""] : null) ??
    find(models, input.lastUsed) ??
    find(models, preferred) ??
    (loaded ? [loaded.providerId, loaded.id] : null)
  );
}

const LAST_USED = (userId: string) => `chatui:last-model:${userId}`;

/**
 * A presentation hint only (contracts §9.2); storage may be unavailable.
 * Returns the raw stored key (a stable primitive for useSyncExternalStore).
 */
export function readLastUsed(userId: string): string | null {
  try {
    return window.localStorage.getItem(LAST_USED(userId));
  } catch {
    return null;
  }
}

export function writeLastUsed(userId: string, pair: ModelPair): void {
  try {
    window.localStorage.setItem(LAST_USED(userId), pairKey(pair));
  } catch {
    // storage unavailable: the in-memory choice still applies
  }
}
