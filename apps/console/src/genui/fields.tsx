// The eleven catalog components (packages/genui), built from the kit primitives. Every field has a label, a `path` (where it
// writes in the policy) and a first `value`. The current value lives in json-render's form state, keyed by the path, so the
// host can read every field back. Text from a spec is always rendered as text.
import { useStateStore } from "@json-render/react";
import { useState, type ReactNode } from "react";
import { Card, Field, Segmented, Tag } from "../kit.ts";
import { DiffView } from "../components/DiffView.tsx";
import { pointerFor } from "./spec.ts";
import "./genui.css";

const RISKS = ["low", "medium", "high", "critical"] as const;
const MODES = ["advisory", "blocking"] as const;
const LANDING = ["trail_ref", "devenv_live", "radicle_patch", "tangled_pull", "pull_request", "auto_land"] as const;

type FieldProps<T> = { props: { label: string; path: string; value: T }; disabled?: boolean };

/** One field's current value, held in form state under its path. Falls back to the spec's own value before any edit. */
function useField<T>(props: { path: string; value: T }): [T, (v: T) => void] {
  const { state, set } = useStateStore();
  const pointer = pointerFor(props.path);
  const current = state[pointer.slice(1)] as T | undefined;
  return [current === undefined ? props.value : current, (v) => set(pointer, v)];
}

export function SectionField({ props, children }: { props: { title: string }; children?: ReactNode }) {
  return (
    <Card title={props.title} tone="quiet">
      <div className="gu-stack">{children}</div>
    </Card>
  );
}

export function TextFieldInput({ props, disabled }: FieldProps<string>) {
  const [value, set] = useField(props);
  return (
    <Field label={props.label}>
      <input
        type="text"
        value={value}
        maxLength={400}
        disabled={disabled}
        onChange={(e) => set(e.target.value)}
      />
    </Field>
  );
}

export function PathListInput({ props, disabled }: FieldProps<string[]>) {
  const [value, set] = useField(props);
  const edit = (i: number, v: string) => set(value.map((x, k) => (k === i ? v : x)));
  return (
    <fieldset className="gu-group" disabled={disabled}>
      <legend>
        <Tag>{props.label}</Tag>
      </legend>
      {value.map((path, i) => (
        <div className="gu-row" key={i}>
          <input
            type="text"
            aria-label={`${props.label} ${i + 1}`}
            value={path}
            maxLength={200}
            onChange={(e) => edit(i, e.target.value)}
          />
          <button
            type="button"
            className="gu-link"
            aria-label={`Remove ${path || "path"}`}
            onClick={() => set(value.filter((_, k) => k !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      {value.length < 40 && (
        <button type="button" className="gu-link" onClick={() => set([...value, ""])}>
          Add a path
        </button>
      )}
    </fieldset>
  );
}

export function RiskSelectInput({ props, disabled }: FieldProps<(typeof RISKS)[number]>) {
  const [value, set] = useField(props);
  return (
    <fieldset className="gu-group" disabled={disabled}>
      <Segmented
        label={props.label}
        value={value}
        options={RISKS.map((r) => ({ id: r, label: r }))}
        onChange={set}
      />
    </fieldset>
  );
}

type Matrix = Record<string, (typeof MODES)[number]>;
export function CheckpointMatrixInput({ props, disabled }: FieldProps<Matrix>) {
  const [value, set] = useField(props);
  return (
    <fieldset className="gu-group" disabled={disabled}>
      <legend>
        <Tag>{props.label}</Tag>
      </legend>
      {(["A", "B", "C"] as const).map((cp) => (
        <Segmented
          key={cp}
          label={`Checkpoint ${cp}`}
          name={`${props.path}-${cp}`}
          value={value[cp] ?? "blocking"}
          options={MODES.map((m) => ({ id: m, label: m }))}
          onChange={(m) => set({ ...value, [cp]: m })}
        />
      ))}
    </fieldset>
  );
}

export function LandingModesInput({ props, disabled }: FieldProps<string[]>) {
  const [value, set] = useField(props);
  return (
    <fieldset className="gu-group" disabled={disabled}>
      <legend>
        <Tag>{props.label}</Tag>
      </legend>
      <div className="gu-checks">
        {LANDING.map((m) => (
          <label key={m} className="gu-check">
            <input
              type="checkbox"
              checked={value.includes(m)}
              onChange={(e) => set(e.target.checked ? [...value, m] : value.filter((x) => x !== m))}
            />
            <span className="mono">{m}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const DURATION = /^([1-9]\d*)(s|m|h|d)$/;
export function parseDuration(text: string): { amount: number; unit: "s" | "m" | "h" | "d" } | null {
  const m = DURATION.exec(text);
  return m ? { amount: Number(m[1]), unit: m[2] as "s" | "m" | "h" | "d" } : null;
}

/** A duration is the policy's own text, such as `2h`. A value that is not of that form is shown as text and flagged. */
export function DurationInput({ props, disabled }: FieldProps<string>) {
  const [value, set] = useField(props);
  const parsed = parseDuration(value);
  return (
    <Field label={props.label} error={parsed ? undefined : "Use a number and s, m, h or d, like 2h."}>
      <span className="gu-row gu-duration">
        <input
          type="number"
          min={1}
          aria-label={`${props.label} amount`}
          value={parsed?.amount ?? ""}
          disabled={disabled}
          onChange={(e) =>
            set(`${Math.max(1, Math.floor(Number(e.target.value) || 1))}${parsed?.unit ?? "h"}`)
          }
        />
        <select
          aria-label={`${props.label} unit`}
          value={parsed?.unit ?? "h"}
          disabled={disabled}
          onChange={(e) => set(`${parsed?.amount ?? 1}${e.target.value}`)}
        >
          <option value="s">seconds</option>
          <option value="m">minutes</option>
          <option value="h">hours</option>
          <option value="d">days</option>
        </select>
      </span>
    </Field>
  );
}

const BUDGET = /^(\d+(?:\.\d+)?)\/month$/;
/** A budget is the policy's own text, such as `60/month` (US dollars). */
export function BudgetFieldInput({ props, disabled }: FieldProps<string>) {
  const [value, set] = useField(props);
  const m = BUDGET.exec(value);
  return (
    <Field
      label={props.label}
      hint="US dollars per month"
      error={m ? undefined : "Use a number and /month, like 60/month."}
    >
      <input
        type="number"
        min={0}
        step={1}
        value={m ? m[1] : ""}
        disabled={disabled}
        onChange={(e) => set(`${Math.max(0, Number(e.target.value) || 0)}/month`)}
      />
    </Field>
  );
}

export function ToggleInput({ props, disabled }: FieldProps<boolean>) {
  const [value, set] = useField(props);
  return (
    <label className="gu-check gu-toggle">
      <input
        type="checkbox"
        role="switch"
        checked={value}
        disabled={disabled}
        onChange={(e) => set(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function NoteText({ props }: { props: { text: string } }) {
  return (
    <p className="gu-note" role="note">
      <Tag>note</Tag> {props.text}
    </p>
  );
}

export function DiffPreviewBlock({ props }: { props: { before: string; after: string } }) {
  return (
    <div className="gu-diff">
      <DiffView before={props.before} after={props.after} label="Preview" context={1} />
    </div>
  );
}
