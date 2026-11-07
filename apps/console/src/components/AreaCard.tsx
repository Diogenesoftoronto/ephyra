import { useEffect, useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import { Badge, Button, Card, Field, Segmented, Tag } from "../kit.ts";
import { fieldChanges } from "../lib/sketch-diff.ts";
import { AutonomyLadder } from "./AutonomyLadder.tsx";
import "./AreaCard.css";

const RISKS = ["low", "medium", "high", "critical"] as const;

/**
 * One area of the application: what it is in plain words, where it lives, how risky it is, and how much the agents may
 * do there. Editable cards change a local copy; the map saves it through the server policy parser.
 */
export function AreaCard({
  sketch,
  original,
  onChange,
  onRemove,
}: {
  sketch: AreaSketch;
  original?: AreaSketch | null;
  onChange?: (next: AreaSketch) => void;
  onRemove?: () => void;
}) {
  const editable = Boolean(onChange);
  const [pathsText, setPathsText] = useState(sketch.paths.join(", "));
  useEffect(() => setPathsText(sketch.paths.join(", ")), [sketch.paths.join(", ")]);
  const change = original === undefined ? [] : original === null ? ["new"] : fieldChanges(original, sketch);
  const set = (patch: Partial<AreaSketch>) => onChange?.({ ...sketch, ...patch });
  return (
    <Card
      title={sketch.name}
      className="area-card"
      tone={change.length ? "live" : "quiet"}
      meta={
        <span className="area-card-tags">
          <Badge tone={sketch.risk === "critical" ? "bad" : sketch.risk === "high" ? "warn" : "neutral"}>
            {sketch.risk} risk
          </Badge>
          {sketch.userFacing && <Badge tone="info">user-facing</Badge>}
          {change.length > 0 && <Badge tone="info">{change[0] === "new" ? "new" : "changed"}</Badge>}
        </span>
      }
      actions={
        editable && onRemove ? (
          <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${sketch.name}`}>
            Remove
          </Button>
        ) : undefined
      }
    >
      <div className="area-body">
        {editable ? (
          <>
            <Field
              label="What this part of the app is"
              hint="In your own words. Velum and the agents read this."
            >
              <textarea
                rows={3}
                value={sketch.intent}
                maxLength={4000}
                onChange={(e) => set({ intent: e.target.value })}
              />
            </Field>
            <Field label="Paths" hint="Comma separated globs, e.g. src/cart/**">
              <input
                type="text"
                value={pathsText}
                onChange={(e) => {
                  setPathsText(e.target.value);
                  set({
                    paths: e.target.value
                      .split(",")
                      .map((p) => p.trim())
                      .filter(Boolean),
                  });
                }}
              />
            </Field>
            <Segmented
              label={`Risk for ${sketch.name}`}
              name={`risk-${sketch.name}`}
              value={sketch.risk}
              options={RISKS.map((r) => ({ id: r, label: r }))}
              onChange={(id) => set({ risk: id })}
            />
            <label className="area-check">
              <input
                type="checkbox"
                checked={sketch.userFacing}
                onChange={(e) => set({ userFacing: e.target.checked })}
              />{" "}
              User-facing
            </label>
          </>
        ) : (
          <>
            <p className="area-intent">
              {sketch.intent || <span className="muted">No description yet.</span>}
            </p>
            <p className="area-paths">
              {sketch.paths.length ? (
                sketch.paths.map((p) => <Tag key={p}>{p}</Tag>)
              ) : (
                <span className="muted">No paths</span>
              )}
            </p>
          </>
        )}
        <AutonomyLadder
          value={sketch.level}
          risk={sketch.risk}
          label={`Autonomy level for ${sketch.name}`}
          onChange={editable ? (level) => set({ level }) : undefined}
        />
      </div>
    </Card>
  );
}
