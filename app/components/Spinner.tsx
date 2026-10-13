/** A small loading ring; the label is for screen readers. */
export function Spinner({ label, testId }: { label: string; testId?: string }) {
  return (
    <div className="spinner-wrap" aria-busy="true" data-testid={testId}>
      <span className="spinner" aria-hidden />
      <span className="visually-hidden">{label}</span>
    </div>
  );
}
