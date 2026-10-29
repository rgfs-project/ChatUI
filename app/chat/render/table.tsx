import { Check, Copy, Maximize2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "../../ui/dialog";
import { copyText } from "../copy";

/** Rows as tab-separated text, which pastes into spreadsheets as cells. */
export function tableToTsv(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) =>
      [...row.cells].map((cell) => cell.textContent.replace(/\s+/g, " ").trim()).join("\t"),
    )
    .join("\n");
}

export function TableBlock({ children }: { children: ReactNode }) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="table-block">
      <div className="table-tools">
        <button
          type="button"
          className="table-tool"
          aria-label={copied ? "Copied" : "Copy table"}
          onClick={() => {
            if (!tableRef.current) return;
            void copyText(tableToTsv(tableRef.current)).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 1_500);
            });
          }}
        >
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        </button>
        <button
          type="button"
          className="table-tool"
          aria-label="Expand table"
          onClick={() => {
            setExpanded(true);
          }}
        >
          <Maximize2 size={16} aria-hidden />
        </button>
      </div>
      <div className="table-wrap">
        <table ref={tableRef}>{children}</table>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded} title="Table" className="table-dialog">
        <div className="table-wrap markdown selectable">
          <table>{children}</table>
        </div>
      </Dialog>
    </div>
  );
}
