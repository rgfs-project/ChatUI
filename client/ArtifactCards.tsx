import { ARTIFACT_LANGUAGE, type ArtifactDto } from '@shared/artifact';
import { artifactIconFor } from './artifactIcon.ts';

/**
 * The files a reply produced, under the reply that produced them.
 *
 * An artifact was always reachable — the dialog lists every one this reader
 * has — but only by remembering it exists and going to look. That is the wrong
 * way round for the moment it is made: the reply says "here is the file" and
 * the transcript showed a code block, leaving the file itself somewhere else
 * entirely. A card here is the thing the sentence is pointing at.
 *
 * Opening one is the whole card rather than a button on it. The row in the
 * dialog splits open from delete because a list is somewhere you tidy up; a
 * transcript is not, so there is one action and the card is it.
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
          <li key={artifact.id}>
            <button type="button" className="artifact-card" onClick={() => onOpen(artifact)}>
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
          </li>
        );
      })}
    </ul>
  );
}
