import type { ReactNode } from "react";

/** A reply's table: scrolls sideways when wider than the column. */
export function TableBlock({ children }: { children: ReactNode }) {
  return (
    <div className="table-block">
      <div className="table-wrap">
        <table>{children}</table>
      </div>
    </div>
  );
}
