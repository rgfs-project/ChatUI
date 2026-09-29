/**
 * Generation state machine vocabulary (Phase 2). Kept free of runtime
 * dependencies so browser code can import it without pulling in schemas.
 *
 *   pending → streaming → completed | cancelled | failed | timed_out
 *   pending → cancelled | failed | timed_out
 */
export const GENERATION_STATES = [
  "pending",
  "streaming",
  "completed",
  "cancelled",
  "failed",
  "timed_out",
] as const;
export type GenerationState = (typeof GENERATION_STATES)[number];
export type TerminalState = Exclude<GenerationState, "pending" | "streaming">;

export function isTerminalState(state: GenerationState): state is TerminalState {
  return state !== "pending" && state !== "streaming";
}
