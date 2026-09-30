/**
 * Attachment media types, extensions and URLs (Phase 12, contracts §7).
 * No dependencies: the browser imports these values without pulling in the
 * DTO schemas (and zod) from `./attachments`.
 */

export const ATTACHMENT_KINDS = ["image", "audio", "text"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** The four raster image types; SVG is never accepted (it is active content). */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const AUDIO_MEDIA_TYPES = ["audio/wav", "audio/mpeg", "audio/flac"] as const;
export const TEXT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
] as const;
export type AttachmentMediaType =
  | (typeof IMAGE_MEDIA_TYPES)[number]
  | (typeof AUDIO_MEDIA_TYPES)[number]
  | (typeof TEXT_MEDIA_TYPES)[number];

export const MEDIA_TYPES: readonly AttachmentMediaType[] = [
  ...IMAGE_MEDIA_TYPES,
  ...AUDIO_MEDIA_TYPES,
  ...TEXT_MEDIA_TYPES,
];

/** Extensions per sniffed type. Text files are recognized by extension plus UTF-8 validation. */
export const EXTENSIONS: Readonly<Record<AttachmentMediaType, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg", "jfif"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "audio/wav": ["wav", "wave"],
  "audio/mpeg": ["mp3"],
  "audio/flac": ["flac"],
  "text/markdown": ["md", "markdown"],
  "text/csv": ["csv"],
  "application/json": ["json"],
  // Plain text and common source code. Markup that browsers execute (html,
  // svg, xml) is deliberately absent.
  "text/plain": [
    "txt",
    "text",
    "log",
    "tsv",
    "jsonl",
    "ndjson",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "js",
    "mjs",
    "cjs",
    "jsx",
    "ts",
    "mts",
    "cts",
    "tsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "kts",
    "scala",
    "c",
    "h",
    "cc",
    "cpp",
    "cxx",
    "hpp",
    "cs",
    "swift",
    "m",
    "php",
    "pl",
    "lua",
    "r",
    "dart",
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "sql",
    "css",
    "scss",
    "less",
    "vue",
    "svelte",
    "graphql",
    "proto",
    "tex",
    "diff",
    "patch",
  ],
};

export function kindOf(mediaType: AttachmentMediaType): AttachmentKind {
  if ((IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)) return "image";
  if ((AUDIO_MEDIA_TYPES as readonly string[]).includes(mediaType)) return "audio";
  return "text";
}

/** The file picker's `accept` value (a hint only; the server sniffs every upload). */
export function acceptAttribute(kinds: readonly AttachmentKind[] = ATTACHMENT_KINDS): string {
  return MEDIA_TYPES.filter((type) => kinds.includes(kindOf(type)))
    .flatMap((type) => EXTENSIONS[type].map((ext) => `.${ext}`))
    .join(",");
}

/** The format's limit on the `attachments` attribute (contracts §3.4). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Content URL of an attachment's bytes (demand-loaded; never prefetched). */
export function attachmentContentUrl(id: string, download = false): string {
  return `/api/attachments/${encodeURIComponent(id)}/content${download ? "?download=1" : ""}`;
}
