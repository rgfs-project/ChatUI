import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, RefreshCw, X } from "lucide-react";
import { useId, useState } from "react";
import type { ConversationDto } from "@shared/conversations";
import type { ProposalDto } from "@shared/memories";
import { ApiError, apiJson, queryKeys } from "../lib/query";
import "./memories.css";

const VERB: Record<ProposalDto["tool"], string> = {
  create: "Remember",
  update: "Update memory",
  forget: "Forget",
};

const DONE: Record<ProposalDto["tool"], string> = {
  create: "Saved to memory",
  update: "Memory updated",
  forget: "Memory forgotten",
};

/** What a 409 on accept means for the user (contracts §4.3 conflicts). */
function conflictText(error: unknown): string {
  if (!(error instanceof ApiError)) return "Couldn’t save. Check your connection and try again.";
  const reason = error.details?.reason;
  switch (reason) {
    case "note_changed":
      return "This memory changed since the suggestion was made, so it wasn’t overwritten. Review it in Settings → Memories.";
    case "note_missing":
      return "The memory this suggestion changes no longer exists.";
    case "name_taken":
      return "A memory with this name already exists. Review it in Settings → Memories.";
    case "source_removed":
      return "The message this suggestion came from was changed or removed.";
    case "limit":
      return error.message;
    default:
      return error.status === 409 ? "This suggestion can no longer be saved." : error.message;
  }
}

/**
 * Memory suggestions under a reply (Phase 13b, INV-37). Suggestions are only
 * proposals: nothing is saved unless the user presses Save. Loaded lazily,
 * only for replies that have suggestions.
 */
export default function MemorySuggestions(props: {
  userId: string;
  conversationId: string;
  proposals: readonly ProposalDto[];
  /** The reply is complete but empty: the model only made suggestions. */
  emptyAnswer: boolean;
  disabled: boolean;
  onRegenerate?: ((trigger: HTMLElement) => void) | undefined;
}) {
  const client = useQueryClient();
  const headingId = useId();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [announce, setAnnounce] = useState("");
  const conversationKey = queryKeys.conversation(props.userId, props.conversationId);

  const decide = useMutation({
    mutationFn: (input: { id: string; action: "accept" | "reject" }) =>
      apiJson<ProposalDto>(
        `/api/conversations/${encodeURIComponent(props.conversationId)}/proposals/${encodeURIComponent(input.id)}/${input.action}`,
        { method: "POST", body: "{}" },
      ),
    onSuccess: (proposal, input) => {
      client.setQueryData<ConversationDto>(conversationKey, (current) =>
        current
          ? {
              ...current,
              proposals: (current.proposals ?? []).map((p) =>
                p.id === proposal.id ? proposal : p,
              ),
            }
          : current,
      );
      setErrors(({ [input.id]: _removed, ...rest }) => rest);
      setAnnounce(input.action === "accept" ? DONE[proposal.tool] : "Suggestion dismissed");
      if (input.action === "accept")
        void client.invalidateQueries({ queryKey: queryKeys.memories(props.userId) });
    },
    onError: (error, input) => {
      setErrors((current) => ({ ...current, [input.id]: conflictText(error) }));
      // The suggestion's status may have changed (e.g. invalid): reload it.
      void client.invalidateQueries({ queryKey: conversationKey });
    },
  });

  const shown = props.proposals.filter((p) => p.status !== "suppressed");
  if (shown.length === 0 && !props.emptyAnswer) return null;
  return (
    <section className="memory-suggestions" aria-labelledby={headingId}>
      {props.emptyAnswer ? (
        <p className="memory-empty-answer" data-testid="answer-not-generated">
          The answer wasn’t generated — the model only made suggestions.
          {props.onRegenerate ? (
            <button
              type="button"
              className="secondary"
              disabled={props.disabled}
              onClick={(event) => {
                props.onRegenerate?.(event.currentTarget);
              }}
            >
              <RefreshCw size={16} aria-hidden /> Regenerate
            </button>
          ) : null}
        </p>
      ) : null}
      <h3 id={headingId} className="memory-suggestions-title">
        <Brain size={16} aria-hidden /> Memory suggestions
      </h3>
      <ul className="memory-cards">
        {shown.map((proposal) => {
          const textId = `${headingId}-${proposal.id}`;
          const busy = decide.isPending && decide.variables.id === proposal.id;
          return (
            <li
              key={proposal.id}
              className="memory-card"
              data-testid="memory-suggestion"
              data-status={proposal.status}
            >
              <div id={textId} className="memory-card-text">
                <p className="memory-card-title">
                  {VERB[proposal.tool]} “{proposal.name}”
                </p>
                {proposal.content !== null ? (
                  <p className="memory-card-content">{proposal.content}</p>
                ) : null}
              </div>
              {proposal.status === "pending" ? (
                <div className="memory-card-actions">
                  <button
                    type="button"
                    aria-describedby={textId}
                    disabled={busy || props.disabled}
                    onClick={() => {
                      decide.mutate({ id: proposal.id, action: "accept" });
                    }}
                  >
                    <Check size={16} aria-hidden /> {proposal.tool === "forget" ? "Forget" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    aria-describedby={textId}
                    disabled={busy || props.disabled}
                    onClick={() => {
                      decide.mutate({ id: proposal.id, action: "reject" });
                    }}
                  >
                    <X size={16} aria-hidden /> Dismiss
                  </button>
                </div>
              ) : (
                <p className="memory-card-status">
                  {proposal.status === "accepted"
                    ? DONE[proposal.tool]
                    : proposal.status === "rejected"
                      ? "Dismissed"
                      : "No longer available: the message changed."}
                </p>
              )}
              {errors[proposal.id] ? (
                <p className="form-error" role="alert">
                  {errors[proposal.id]}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
