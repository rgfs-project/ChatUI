/**
 * Composer drafts live only in tab memory (contracts §12): never browser
 * storage. Keys include the user id, and an account change clears them all.
 */
const drafts = new Map<string, string>();

export function draftKey(userId: string, conversationId: string | null): string {
  return `${userId}|${conversationId ?? "new"}`;
}

export const draftStore = {
  get: (key: string): string => drafts.get(key) ?? "",
  set(key: string, value: string): void {
    if (value === "") drafts.delete(key);
    else drafts.set(key, value);
  },
  clearAll(): void {
    drafts.clear();
  },
};
