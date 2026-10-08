import type { ModelDto, ModelListDto } from "@shared/generations";

export interface ModelChoice {
  providerId: string;
  model: string;
}

export function allModels(list: ModelListDto | undefined): ModelDto[] {
  return list?.providers.flatMap((p) => (p.provider.status === "invalid" ? [] : p.models)) ?? [];
}

export function findModel(
  list: ModelListDto | undefined,
  choice: ModelChoice | null,
): ModelDto | undefined {
  if (!choice) return undefined;
  return allModels(list).find((m) => m.providerId === choice.providerId && m.id === choice.model);
}

/**
 * The model a chat uses: the one its last reply used, else the user's saved
 * default, else the instance default, else the first one offered.
 */
export function resolveModel(
  list: ModelListDto | undefined,
  candidates: readonly (ModelChoice | null | undefined)[],
): ModelChoice | null {
  for (const c of candidates) if (c && findModel(list, c)) return c;
  const d = list?.defaultModel;
  if (d && findModel(list, { providerId: d.providerId, model: d.modelId }))
    return { providerId: d.providerId, model: d.modelId };
  const first = allModels(list)[0];
  return first ? { providerId: first.providerId, model: first.id } : null;
}

/** A short display name: the last path segment of an opaque id. */
export function modelLabel(id: string): string {
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/\.gguf$/i, "");
}
