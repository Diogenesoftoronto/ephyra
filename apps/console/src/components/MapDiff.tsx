import type { AreaSketch } from "@ephyra/core";
import { Badge, Empty } from "../kit.ts";
import { changedCount, diffSketches } from "../lib/sketch-diff.ts";
import "./MapDiff.css";

const FIELD = { level: "Level", risk: "Risk", paths: "Paths", intent: "Description", userFacing: "Audience", studyBudgetUsd: "Study budget" } as const;

/** The map before and after a proposal: which areas are new, removed or changed, and each changed field as before → after. */
export function MapDiff({ before, after }: { before: readonly AreaSketch[]; after: readonly AreaSketch[] }) {
  const changes = diffSketches(before, after);
  if (changedCount(changes) === 0) return <p className="muted">The map would stay the same.</p>;
  return (
    <ul className="mapdiff" aria-label="Changes to the application map">
      {changes.filter((c) => c.kind !== "same").map((c) => (
        <li key={c.name} className="mapdiff-item" data-kind={c.kind}>
          <div className="mapdiff-head">
            <strong>{c.name}</strong>
            <Badge tone={c.kind === "added" ? "ok" : c.kind === "removed" ? "bad" : "info"}>{c.kind}</Badge>
          </div>
          {c.kind === "added" && <p className="muted">{c.after.level} · {c.after.risk} risk · {c.after.paths.join(", ") || "no paths"}</p>}
          {c.kind === "removed" && <p className="muted">Was {c.before.level} · {c.before.risk} risk</p>}
          {c.kind === "changed" && (
            <dl className="mapdiff-fields">
              {c.fields.map((f) => (
                <div key={f.field}>
                  <dt>{FIELD[f.field]}</dt>
                  <dd><span className="mapdiff-before">{f.before}</span> <span aria-label="becomes">→</span> <strong>{f.after}</strong></dd>
                </div>
              ))}
            </dl>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MapDiffEmpty() {
  return <Empty title="No map changes" body="This proposal changes the document but not the map." />;
}
