/**
 * A small loading spinner (Phase 18, after ChatGPT): a thin ring drawn in CSS,
 * centered in the space it stands in for. The label is for screen readers;
 * under reduced motion the ring stays still.
 */
export function Spinner({ label, testId }: { label: string; testId?: string }) {
  return (
    <div className="spinner-wrap" aria-busy="true" data-testid={testId}>
      <span className="spinner" aria-hidden />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
