import { useMemo } from "react";
import { diffStats, lineDiff, withContext } from "../lib/diff.ts";
import { Badge } from "../kit.ts";
import "./DiffView.css";

/** A line diff of two texts, with unchanged runs folded. Text only: nothing in `before` or `after` is rendered as markup. */
export function DiffView({ before, after, label = "Changes", context = 2 }: { before: string; after: string; label?: string; context?: number }) {
  const ops = useMemo(() => lineDiff(before, after), [before, after]);
  const rows = useMemo(() => withContext(ops, context), [ops, context]);
  const { added, removed } = diffStats(ops);
  if (added + removed === 0) return <p className="muted diff-none">No changes.</p>;
  return (
    <figure className="diff" aria-label={label}>
      <figcaption className="diff-head"><Badge tone="ok">+{added}</Badge> <Badge tone="bad">−{removed}</Badge></figcaption>
      <pre className="diff-body">
        {rows.map((row, i) => "skipped" in row
          ? <span key={i} className="diff-skip">{`⋯ ${row.skipped} unchanged line${row.skipped === 1 ? "" : "s"}`}</span>
          : <span key={i} className={`diff-line diff-${row.kind}`} data-kind={row.kind}>
              <i aria-hidden>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</i>
              <span className="sr-only">{row.kind === "add" ? "added: " : row.kind === "del" ? "removed: " : ""}</span>{row.text || " "}
            </span>)}
      </pre>
    </figure>
  );
}
