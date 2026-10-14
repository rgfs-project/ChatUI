/** A byte count for people: B, KB, MB or GB. */
export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  const gb = size / 1024 ** 3;
  return `${Number.isInteger(gb) ? String(gb) : gb.toFixed(1)} GB`;
}
