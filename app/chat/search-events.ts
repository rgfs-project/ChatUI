/** Opens the search dialog (sidebar button, Ctrl/⌘ + K), without loading it eagerly. */
export const OPEN_SEARCH_EVENT = "chatui:open-search";

export function openSearch(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT));
}

/** Navigation state that asks the transcript to jump to a message and mark a query. */
export interface SearchJump {
  search: { query: string; messageId: string | null };
}
