import { useQueryClient } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useState } from "react";
import type { ProposalDto, ProposalPreview } from "@shared/memories";
import { api, ApiError, messageOf } from "../lib/api";
import { keys } from "../lib/query";

const VERB = { create: "Remember", update: "Update memory", forget: "Forget" } as const;

const CONFLICT: Record<string, string> = {
  note_changed: "That memory changed since it was suggested.",
  note_missing: "That memory no longer exists.",
  name_taken: "Another memory already has this name.",
  source_removed: "The message that suggested this was removed.",
  not_actionable: "This suggestion can no longer be used.",
  limit: "You’ve reached the limit for memories.",
};

/** Memory suggestions from one reply: nothing is saved until you accept. */
export function Proposals(props: {
  userId: string;
  conversationId: string;
  proposals: readonly ProposalDto[];
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const shown = props.proposals.filter(
    (p) => p.status === "pending" || p.status === "accepted" || p.status === "rejected",
  );
  if (shown.length === 0) return null;

  async function decide(p: ProposalDto, decision: "accept" | "reject") {
    setBusy(p.id);
    try {
      await api(
        `/api/conversations/${encodeURIComponent(props.conversationId)}/proposals/${encodeURIComponent(p.id)}/${decision}`,
        { method: "POST", body: {} },
      );
      setErrors(({ [p.id]: _, ...rest }) => rest);
    } catch (e) {
      const reason = e instanceof ApiError ? (e.details?.reason as string | undefined) : undefined;
      setErrors((all) => ({ ...all, [p.id]: (reason && CONFLICT[reason]) ?? messageOf(e) }));
    } finally {
      setBusy(null);
      await client.invalidateQueries({
        queryKey: keys.conversation(props.userId, props.conversationId),
      });
      void client.invalidateQueries({ queryKey: keys.memories(props.userId) });
    }
  }

  return (
    <ul className="proposals" aria-label="Memory suggestions">
      {shown.map((p) => (
        <li key={p.id} className="proposal">
          <Lightbulb size={18} aria-hidden className="proposal-icon" />
          <div className="proposal-body">
            <p className="proposal-title">
              {VERB[p.tool]}: <strong>{p.name}</strong>
            </p>
            {p.content ? <p className="proposal-content">{p.content}</p> : null}
            {errors[p.id] ? (
              <p className="error" role="alert">
                {errors[p.id]}
              </p>
            ) : null}
            {p.status === "pending" ? (
              <div className="proposal-actions">
                <button
                  type="button"
                  className="button small"
                  disabled={busy === p.id}
                  onClick={() => void decide(p, "reject")}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="button primary small"
                  disabled={busy === p.id}
                  onClick={() => void decide(p, "accept")}
                >
                  {p.tool === "forget" ? "Forget" : "Save"}
                </button>
              </div>
            ) : (
              <p className="muted small">
                {p.status === "accepted" ? "Saved to memories." : "Dismissed."}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** While a reply streams, its suggestions are previews only. */
export function ProposalPreviews(props: { proposals: readonly ProposalPreview[] }) {
  const pending = props.proposals.filter((p) => p.status === "pending");
  if (pending.length === 0) return null;
  return (
    <ul className="proposals" aria-label="Memory suggestions">
      {pending.map((p) => (
        <li key={p.id} className="proposal preview">
          <Lightbulb size={18} aria-hidden className="proposal-icon" />
          <div className="proposal-body">
            <p className="proposal-title">
              {VERB[p.tool]}: <strong>{p.name}</strong>
            </p>
            <p className="muted small">You can save this when the reply finishes.</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
