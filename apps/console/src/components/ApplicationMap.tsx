import { useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import { Button, Empty, Field } from "../kit.ts";
import { AreaRow, RemovedAreaRow } from "./AreaRow.tsx";
import { areaNameError, boardSummary } from "../lib/policy-board.ts";
import { Referable, useVelum } from "../velum/VelumProvider.tsx";
import "./ApplicationMap.css";

/**
 * The application as a compact board: one row per area, one row open at a time. Pass `onChange` to make it editable;
 * `original` marks what differs from the policy in effect and keeps removed areas in view until they are saved.
 */
export function ApplicationMap({
  sketches,
  original,
  onChange,
  revision,
}: {
  sketches: readonly AreaSketch[];
  original?: readonly AreaSketch[];
  onChange?: (next: AreaSketch[]) => void;
  /** The published document digest. With it, each area can be referred to Velum at this revision. */
  revision?: string;
}) {
  const velum = useVelum();
  const [openName, setOpenName] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const invalid = areaNameError(name, sketches.map((s) => s.name));
  const add = () => {
    if (!name || invalid) return;
    onChange?.([
      ...sketches,
      { name, intent: "", paths: [], risk: "medium", level: "research", userFacing: false },
    ]);
    setOpenName(name);
    setAdding(false);
    setName("");
  };
  if (sketches.length === 0 && !onChange)
    return (
      <Empty
        title="No areas yet"
        body="Ask Velum to describe your application, and the areas will appear here."
      />
    );
  const removed = original?.filter((o) => !sketches.some((s) => s.name === o.name)) ?? [];
  // While Velum is collecting references, a row is something to point at, not something to open.
  const pointing = Boolean(revision && velum?.selecting);
  return (
    <div className="map" data-compare={original ? "" : undefined}>
      {sketches.length > 0 && <p className="map-summary muted">{boardSummary(sketches)}</p>}
      {(sketches.length > 0 || removed.length > 0) && (
        <div className="map-rows">
          {sketches.map((s) => {
            const row = (
              <AreaRow
                key={s.name}
                sketch={s}
                original={original ? (original.find((o) => o.name === s.name) ?? null) : undefined}
                open={openName === s.name}
                onToggle={() =>
                  pointing ? velum!.toggle(`area:${s.name}`) : setOpenName((n) => (n === s.name ? null : s.name))
                }
                onChange={
                  onChange ? (next) => onChange(sketches.map((x) => (x.name === s.name ? next : x))) : undefined
                }
                onRemove={onChange ? () => onChange(sketches.filter((x) => x.name !== s.name)) : undefined}
              />
            );
            return revision ? (
              <Referable key={s.name} id={`area:${s.name}`} refData={{ kind: "area", name: s.name, revision }}
                label={`${s.name} area`} href="#/workspace">
                {row}
              </Referable>
            ) : row;
          })}
          {removed.map((o) => (
            <RemovedAreaRow key={o.name} sketch={o} onRestore={onChange ? () => onChange([...sketches, o]) : undefined} />
          ))}
        </div>
      )}
      {sketches.length === 0 && (
        <Empty title="No areas yet" body="Add one, or ask Velum to describe your application." />
      )}
      {onChange &&
        (adding ? (
          <form
            className="map-add"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Field label="Area name" error={invalid}>
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value.toLowerCase())}
              />
            </Field>
            <Button variant="primary" disabled={!name || Boolean(invalid)} onClick={add}>
              Add area
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setName("");
              }}
            >
              Cancel
            </Button>
          </form>
        ) : (
          <Button size="sm" onClick={() => setAdding(true)}>Add an area</Button>
        ))}
    </div>
  );
}
