import { useEffect, useId, useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import { Badge, Button, Field, Segmented, Tag } from "../kit.ts";
import { fieldChanges, type FieldChange } from "../lib/sketch-diff.ts";
import { LEVEL_STEPS, levelLabel, levelStep, meterLabel, parsePaths, pathSummary, riskTone } from "../lib/policy-board.ts";
import { AutonomyLadder } from "./AutonomyLadder.tsx";
import "./AreaRow.css";

const RISKS = ["low", "medium", "high", "critical"] as const;
const FIELD_NAMES: Record<FieldChange["field"], string> = {
  level: "level", risk: "risk", userFacing: "audience", paths: "paths", intent: "description", studyBudgetUsd: "study budget",
};
/** Long text is named, not quoted, so the note stays one line. */
const changeText = (c: FieldChange) =>
  c.field === "intent" || c.field === "paths" ? FIELD_NAMES[c.field] : `${FIELD_NAMES[c.field]} ${c.before} → ${c.after}`;

/** Five pips filled up to the area's level, with the level's name beside them. */
export function LevelMeter({ level, risk }: { level: AreaSketch["level"]; risk?: AreaSketch["risk"] }) {
  const step = levelStep(level);
  return (
    <span className="area-meter" role="img" aria-label={meterLabel(level)}
      data-alert={level === "auto" && risk === "critical" ? "" : undefined}>
      <span className="area-pips" aria-hidden="true">
        {Array.from({ length: LEVEL_STEPS }, (_, i) => <span key={i} data-on={i < step ? "" : undefined} />)}
      </span>
      <span className="area-meter-label" aria-hidden="true">{levelLabel(level)}</span>
    </span>
  );
}

/**
 * One area of the application as a compact row: name, risk, how far the agents may go, and where it lives. The row is a
 * button that opens the detail under it: what the area is, all its paths and the autonomy ladder. With `onChange` the
 * detail is editable and changes a local copy; the map saves it through the server policy parser.
 */
export function AreaRow({
  sketch,
  original,
  open,
  onToggle,
  onChange,
  onRemove,
}: {
  sketch: AreaSketch;
  /** The same area in the policy in effect; `null` when it is new, `undefined` when there is nothing to compare with. */
  original?: AreaSketch | null;
  open: boolean;
  onToggle: () => void;
  onChange?: (next: AreaSketch) => void;
  onRemove?: () => void;
}) {
  const id = useId();
  const changes = original ? fieldChanges(original, sketch) : [];
  const change = original === null ? "new" : changes.length ? "changed" : null;
  const paths = pathSummary(sketch.paths);
  return (
    <div className="area-row" data-area={sketch.name} data-open={open ? "" : undefined} data-change={change ?? undefined}>
      <button type="button" className="area-row-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="area-name">{sketch.name}</span>
        <span className="area-risk"><Badge tone={riskTone(sketch.risk)}>{sketch.risk} risk</Badge></span>
        <LevelMeter level={sketch.level} risk={sketch.risk} />
        <span className="area-where">
          {paths.first ? (
            <>
              <span className="mono area-path">{paths.first}</span>
              {paths.more > 0 && <span className="area-more" aria-label={`and ${paths.more} more`}>+{paths.more}</span>}
            </>
          ) : (
            <span className="muted">No paths</span>
          )}
        </span>
        <span className="area-change">{change && <Badge tone="info">{change}</Badge>}</span>
        <svg className="area-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="area-detail" id={id} role="group" aria-label={`${sketch.name} details`}>
          {changes.length > 0 && (
            <p className="area-changes muted">Changed from the policy in effect: {changes.map(changeText).join(", ")}.</p>
          )}
          {onChange ? (
            <AreaFields sketch={sketch} onChange={onChange} onRemove={onRemove} />
          ) : (
            <>
              <p className="area-intent">{sketch.intent || <span className="muted">No description yet.</span>}</p>
              <p className="area-paths">
                {sketch.paths.length ? sketch.paths.map((p) => <Tag key={p}>{p}</Tag>) : <span className="muted">No paths</span>}
                {sketch.userFacing && <Badge tone="info">user-facing</Badge>}
              </p>
              <AutonomyLadder value={sketch.level} risk={sketch.risk} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AreaFields({ sketch, onChange, onRemove }: {
  sketch: AreaSketch;
  onChange: (next: AreaSketch) => void;
  onRemove?: () => void;
}) {
  const joined = sketch.paths.join(", ");
  const [pathsText, setPathsText] = useState(joined);
  // Follow the paths when they change from outside (a discard, a proposal), but never rewrite what is being typed.
  useEffect(() => {
    setPathsText((text) => (parsePaths(text).join(", ") === joined ? text : joined));
  }, [joined]);
  const set = (patch: Partial<AreaSketch>) => onChange({ ...sketch, ...patch });
  return (
    <>
      <AutonomyLadder
        value={sketch.level}
        risk={sketch.risk}
        label={`Autonomy level for ${sketch.name}`}
        onChange={(level) => set({ level })}
      />
      <div className="area-fields">
        <Field label="What this part of the app is" hint="In your own words. Velum and the agents read this.">
          <textarea rows={2} value={sketch.intent} maxLength={4000} onChange={(e) => set({ intent: e.target.value })} />
        </Field>
        <Field label="Paths" hint="Comma separated globs, e.g. src/cart/**">
          <input
            type="text"
            value={pathsText}
            onChange={(e) => {
              setPathsText(e.target.value);
              set({ paths: parsePaths(e.target.value) });
            }}
          />
        </Field>
      </div>
      <div className="area-settings">
        <Segmented
          label={`Risk for ${sketch.name}`}
          name={`risk-${sketch.name}`}
          value={sketch.risk}
          options={RISKS.map((r) => ({ id: r, label: r }))}
          onChange={(risk) => set({ risk })}
        />
        <label className="area-check">
          <input type="checkbox" checked={sketch.userFacing} onChange={(e) => set({ userFacing: e.target.checked })} />{" "}
          User-facing
        </label>
        {onRemove && (
          <Button size="sm" variant="ghost" className="area-remove" onClick={onRemove} aria-label={`Remove ${sketch.name}`}>
            Remove
          </Button>
        )}
      </div>
    </>
  );
}

/** An area the working copy dropped. It stays on the board, struck through, until the change is saved or undone. */
export function RemovedAreaRow({ sketch, onRestore }: { sketch: AreaSketch; onRestore?: () => void }) {
  return (
    <div className="area-row area-row--removed" data-area={sketch.name} data-change="removed">
      <div className="area-row-head">
        <span className="area-name"><s>{sketch.name}</s></span>
        <span className="area-risk" />
        <span className="area-meter muted">Was {levelLabel(sketch.level)}</span>
        <span className="area-where">
          {onRestore && (
            <Button size="sm" variant="ghost" onClick={onRestore} aria-label={`Restore ${sketch.name}`}>Restore</Button>
          )}
        </span>
        <span className="area-change"><Badge tone="warn">removed</Badge></span>
      </div>
    </div>
  );
}
