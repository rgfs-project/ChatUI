import { Download, Eye } from 'lucide-react';
import { ARTIFACT_LANGUAGE, type ArtifactDto } from '@shared/artifact';
import { artifactIconFor } from './artifactIcon.ts';
import { downloadArtifact } from './downloadArtifact.ts';

/**
 * The files a reply produced, under the reply that produced them.
 *
 * An artifact was always reachable — the dialog lists every one this reader
 * has — but only by remembering it exists and going to look. That is the wrong
 * way round for the moment it is made: the reply says "here is the file" and
 * the transcript showed a code block, leaving the file itself somewhere else
 * entirely. A card here is the thing the sentence is pointing at.
 *
 * The card body opens the file, and the two buttons beside it name the things
 * a reader wants to do with one: view it, or keep it. View repeats what the
 * body already does, deliberately — the body being clickable is something you
 * have to discover, and a file card with no visible verb on it is a dead end
 * for anybody who does not try. Delete is not here: a list is somewhere you
 * tidy up, and the dialog is that list; a transcript is not.
 *
 * Rendered beside `MemoryProposals` and for the same reason — both belong to a
 * turn rather than to the conversation, and both read as a consequence of the
 * message above them.
 */

export interface ArtifactCardsProps {
  artifacts: ArtifactDto[];
  onOpen: (artifact: ArtifactDto) => void;
}

export function ArtifactCards({ artifacts, onOpen }: ArtifactCardsProps): React.JSX.Element {
  return (
    <ul className="artifact-cards">
      {artifacts.map((artifact) => {
        const Icon = artifactIconFor(artifact.mediaType);
        return (
          <li key={artifact.id} className="artifact-card">
            <button
              type="button"
              className="artifact-card__open"
              onClick={() => onOpen(artifact)}
            >
              <span className="artifact-card__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="artifact-card__text">
                <span className="artifact-card__name">{artifact.name}</span>
                {/* The language always, the description only when the export
                    carried one — a trailing separator with nothing after it
                    reads as something that failed to load. */}
                <span className="artifact-card__meta">
                  {ARTIFACT_LANGUAGE[artifact.mediaType]}
                  {artifact.description !== undefined && ` · ${artifact.description}`}
                </span>
              </span>
            </button>

            <span className="artifact-card__actions">
              <button
                type="button"
                className="icon-button"
                onClick={() => onOpen(artifact)}
                aria-label={`View ${artifact.name}`}
                title="View"
              >
                <Eye size={16} />
              </button>
              {/* The bytes are fetched by the click rather than held for every
                  card on screen, so a failure here is a download that does not
                  happen — the same as the panel's, and not worth a second
                  error surface in the middle of a transcript. */}
              <button
                type="button"
                className="icon-button"
                onClick={() => void downloadArtifact(artifact)}
                aria-label={`Download ${artifact.name}`}
                title="Download"
              >
                <Download size={16} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
