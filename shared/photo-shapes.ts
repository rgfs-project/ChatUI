/** Profile photo shapes (Phase 12b). Zod-free: the browser bundle imports it. */
export const PHOTO_SHAPES = ["circle", "flower", "rounded", "oval", "cookie"] as const;
export type PhotoShape = (typeof PHOTO_SHAPES)[number];
