/** Opens the source panel for a captured file (Phase 13c); the app layout listens. */
export const OPEN_ARTIFACT_EVENT = "chatui:open-artifact";

export function openArtifact(id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT, { detail: { id } }));
}
