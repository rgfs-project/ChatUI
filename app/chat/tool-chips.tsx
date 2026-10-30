import { Brain, Check, Loader2, Wrench, X } from "lucide-react";
import { useState } from "react";
import type { ProposalDto } from "@shared/memories";
import { TOOL_LABELS, type ToolActivity } from "@shared/tool-labels";
import { useConversationOps } from "./conversation-ops";

const label = (name: string) => TOOL_LABELS[name] ?? name.replace(/_/g, " ");

/** Tools a saved reply used (D2): one chip per tool, in order of first use. */
export function ToolChips({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <ul className="tool-chips" aria-label="Tools used" data-testid="tool-chips">
      {names.map((name) => (
        <li key={name} className="tool-chip">
          <Wrench size={13} aria-hidden />
          {label(name)}
        </li>
      ))}
    </ul>
  );
}

/** Tool calls while a reply streams. */
export function LiveToolChips({ tools }: { tools: readonly ToolActivity[] }) {
  if (tools.length === 0) return null;
  return (
    <ul className="tool-chips" aria-label="Tools" aria-live="polite" data-testid="live-tool-chips">
      {tools.map((tool) => (
        <li key={tool.callId} className={`tool-chip is-${tool.state}`}>
          {tool.state === "running" ? (
            <Loader2 size={13} className="spin" aria-hidden />
          ) : tool.state === "error" ? (
            <X size={13} aria-hidden />
          ) : (
            <Wrench size={13} aria-hidden />
          )}
          {label(tool.name)}
        </li>
      ))}
    </ul>
  );
}

function title(p: ProposalDto): string {
  if (p.tool === "remember") return `Remember “${p.name}”`;
  if (p.tool === "update_memory") return `Update “${p.name}”`;
  return `Forget “${p.name}”`;
}

const OUTCOME: Partial<Record<ProposalDto["status"], string>> = {
  accepted: "Saved to memory",
  rejected: "Dismissed",
  invalid: "No longer applies: the message changed",
};

function ProposalCard({ proposal }: { proposal: ProposalDto }) {
  const ops = useConversationOps();
  const [busy, setBusy] = useState(false);
  const decide = (accept: boolean) => {
    setBusy(true);
    void ops.decideProposal(proposal.id, accept).finally(() => {
      setBusy(false);
    });
  };
  const pending = proposal.status === "pending";
  const outcome = OUTCOME[proposal.status];
  return (
    <li className={`proposal is-${proposal.status}`} data-testid="proposal">
      <div className="proposal-head">
        <Brain size={16} aria-hidden />
        <span className="proposal-kind">Memory suggestion</span>
      </div>
      <p className="proposal-title">{title(proposal)}</p>
      {proposal.content ? <p className="proposal-body selectable">{proposal.content}</p> : null}
      {pending && proposal.stale ? (
        <p className="proposal-note" role="status">
          This memory changed since the suggestion, so it can’t be applied.
        </p>
      ) : null}
      {pending ? (
        <div className="proposal-actions">
          {proposal.stale ? null : (
            <button
              type="button"
              className="pill-button pill-primary"
              disabled={busy}
              onClick={() => {
                decide(true);
              }}
            >
              <Check size={15} aria-hidden />
              {proposal.tool === "forget_memory" ? "Forget" : "Save"}
            </button>
          )}
          <button
            type="button"
            className="pill-button"
            disabled={busy}
            onClick={() => {
              decide(false);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : outcome ? (
        <p className="proposal-note">{outcome}</p>
      ) : null}
    </li>
  );
}

/**
 * The model's memory suggestions for one reply (contracts §4.3). Nothing is
 * saved until the user chooses Save (INV-37); repeats are not shown.
 */
export function ProposalCards({ proposals }: { proposals: readonly ProposalDto[] }) {
  const shown = proposals.filter((p) => p.status !== "suppressed");
  if (shown.length === 0) return null;
  return (
    <ul className="proposals" aria-label="Memory suggestions">
      {shown.map((p) => (
        <ProposalCard key={p.id} proposal={p} />
      ))}
    </ul>
  );
}
