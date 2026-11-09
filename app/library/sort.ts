import type { ArtifactDto } from "@shared/artifacts";
import type { AttachmentDto } from "@shared/attachments";

export type Kind = "all" | "images" | "audio" | "documents" | "created";
export type Sort = "newest" | "oldest" | "name" | "size";

export const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "images", label: "Images" },
  { id: "audio", label: "Audio" },
  { id: "documents", label: "Documents" },
  { id: "created", label: "From replies" },
];

export const SORTS: { id: Sort; label: string }[] = [
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "name", label: "Name" },
  { id: "size", label: "Largest first" },
];

export const MATCHES: Record<Kind, (file: AttachmentDto) => boolean> = {
  all: () => true,
  images: (f) => f.kind === "image",
  audio: (f) => f.kind === "audio",
  documents: (f) => f.kind === "text",
  created: () => false,
};

export const COMPARE: Record<Sort, (a: AttachmentDto, b: AttachmentDto) => number> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  name: (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" }),
  size: (a, b) => b.size - a.size,
};

export function oneOf<T extends string>(
  value: string | null,
  options: readonly { id: T }[],
  fallback: T,
): T {
  return options.find((o) => o.id === value)?.id ?? fallback;
}

export const COMPARE_CREATED: Record<Sort, (a: ArtifactDto, b: ArtifactDto) => number> = {
  newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
  oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
  name: (a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: "base" }),
  size: (a, b) => b.size - a.size,
};
