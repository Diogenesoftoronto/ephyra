import { useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import { Button, Empty, Field } from "../kit.ts";
import { AreaCard } from "./AreaCard.tsx";
import { Referable } from "../velum/VelumProvider.tsx";
import "./ApplicationMap.css";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The application as a grid of area cards. Pass `onChange` to make it editable; `original` marks what differs. */
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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const taken = sketches.some((s) => s.name === name);
  const invalid =
    name !== "" && (!NAME.test(name) || name.length > 60)
      ? "Lowercase letters, numbers and dashes."
      : taken
        ? "That area already exists."
        : null;
  const add = () => {
    onChange?.([
      ...sketches,
      { name, intent: "", paths: [], risk: "medium", level: "research", userFacing: false },
    ]);
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
  return (
    <div className="map">
      <div className="grid-cards map-grid">
        {sketches.map((s) => revision && !onChange ? (
          <Referable key={s.name} id={`area:${s.name}`} refData={{ kind: "area", name: s.name, revision }}
            label={`${s.name} area`} href="#/workspace">
            <AreaCard sketch={s} />
          </Referable>
        ) : (
          <AreaCard
            key={s.name}
            sketch={s}
            original={original ? (original.find((o) => o.name === s.name) ?? null) : undefined}
            onChange={
              onChange ? (next) => onChange(sketches.map((x) => (x.name === s.name ? next : x))) : undefined
            }
            onRemove={onChange ? () => onChange(sketches.filter((x) => x.name !== s.name)) : undefined}
          />
        ))}
      </div>
      {sketches.length === 0 && (
        <Empty title="No areas yet" body="Add one, or ask Velum to describe your application." />
      )}
      {onChange &&
        (adding ? (
          <form
            className="map-add"
            onSubmit={(e) => {
              e.preventDefault();
              if (name && !invalid) add();
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
          <Button onClick={() => setAdding(true)}>Add an area</Button>
        ))}
    </div>
  );
}
