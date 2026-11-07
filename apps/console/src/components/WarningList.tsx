import { Badge } from "../kit.ts";
import { splitWarnings } from "../lib/warnings.ts";
import "./WarningList.css";

/** Parser output for a document. Errors block applying and publishing; notes are advice. */
export function WarningList({ warnings, label = "Parser" }: { warnings: readonly string[]; label?: string }) {
  if (warnings.length === 0)
    return (
      <p className="warnings-ok">
        <Badge tone="ok">{label}: no warnings</Badge>
      </p>
    );
  const { errors, notes } = splitWarnings(warnings);
  return (
    <ul className="warnings" aria-label={`${label} warnings`}>
      {errors.map((w) => (
        <li key={w}>
          <Badge tone="bad">error</Badge> <span className="mono">{w}</span>
        </li>
      ))}
      {notes.map((w) => (
        <li key={w}>
          <Badge tone="warn">warning</Badge> <span className="mono">{w}</span>
        </li>
      ))}
    </ul>
  );
}
