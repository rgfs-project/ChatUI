import type { ArtifactDto } from '@shared/artifact';
import { fetchArtifactSource } from './api.ts';

/**
 * Saves an artifact to disk under the name it was given.
 *
 * Through a blob of our own rather than by linking at the source route: the
 * route deliberately serves `text/plain` so that nothing a browser does with
 * an artifact depends on the artifact's own type. A download should still land
 * under the name and extension the reader expects, and building the blob here
 * is what separates those two concerns.
 *
 * `source` is passed by a caller that already has the bytes on screen — the
 * panel — and left out by one that does not, such as a card in the transcript,
 * which fetches them at the moment of the click rather than for every file it
 * lists.
 */
export async function downloadArtifact(artifact: ArtifactDto, source?: string): Promise<void> {
  const text = source ?? (await fetchArtifactSource(artifact.id));

  const url = URL.createObjectURL(new Blob([text], { type: artifact.mediaType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = artifact.name;
  link.click();
  URL.revokeObjectURL(url);
}
