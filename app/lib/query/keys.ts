/**
 * The one query-key factory (contracts §9.1). Every user-scoped key starts
 * with the authenticated user id, so a different account can never read
 * another account's cache entries (INV-55, INV-59).
 */
export const qk = {
  session: () => ["session"] as const,
  conversations: (userId: string) => ["u", userId, "conversations"] as const,
  conversation: (userId: string, id: string) => ["u", userId, "conversation", id] as const,
  models: (userId: string) => ["u", userId, "models"] as const,
  preferences: (userId: string) => ["u", userId, "preferences"] as const,
  /** Instance notice and default model (Phase 10). */
  instance: (userId: string) => ["u", userId, "instance"] as const,
  /** Live generation state written by the SSE observer; never dehydrated. */
  generation: (userId: string, id: string) => ["u", userId, "generation", id] as const,
};

export type Resource =
  | "session"
  | "conversations"
  | "conversation"
  | "models"
  | "preferences"
  | "instance"
  | "generation";

/** The resource a key names, or undefined for keys outside the factory. */
export function resourceOf(key: readonly unknown[]): Resource | undefined {
  const name = key[0] === "u" ? key[2] : key[0];
  return typeof name === "string" &&
    [
      "session",
      "conversations",
      "conversation",
      "models",
      "preferences",
      "instance",
      "generation",
    ].includes(name)
    ? (name as Resource)
    : undefined;
}

export function isUserScoped(key: readonly unknown[]): boolean {
  return key[0] === "u";
}

/** Browser-safe resources a document may dehydrate (contracts §9.2a). */
export const DEHYDRATE_ALLOWLIST: ReadonlySet<Resource> = new Set([
  "session",
  "conversations",
  "conversation",
  "models",
  "preferences",
  "instance",
]);
