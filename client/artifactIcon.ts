import { Code2, FileText, Image, Table2 } from 'lucide-react';
import type { ArtifactMediaType } from '@shared/artifact';

/**
 * The mark on an artifact, wherever one is listed.
 *
 * Grouped by what the file *is* rather than one icon per media type: a reader
 * scanning a list is telling a page from a script from a picture, and twelve
 * distinct glyphs would be twelve things to learn for a distinction nobody is
 * making.
 *
 * Shared rather than owned by the list that happened to need it first, so the
 * card under a reply and the row in the dialog cannot drift into disagreeing
 * about what a `.csv` looks like.
 */
export function artifactIconFor(mediaType: ArtifactMediaType) {
  if (mediaType === 'image/svg+xml') return Image;
  if (mediaType === 'text/csv') return Table2;
  if (mediaType === 'text/markdown' || mediaType === 'text/plain') return FileText;
  return Code2;
}
