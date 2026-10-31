/** Which captured files may run in a sandboxed preview (Phase 19). Zod-free: the browser imports it. */
export const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEWABLE = /\.(html?|svg)$/i;

export function isPreviewable(filename: string, size: number): boolean {
  return PREVIEWABLE.test(filename) && size <= PREVIEW_MAX_BYTES;
}
