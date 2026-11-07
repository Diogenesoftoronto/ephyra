// The eleven catalog components, built from the kit primitives. Each reads and writes its value through json-render's
// bindings (`$bindState`). A value that is not bound is shown read-only. Text from a spec is always rendered as text.
import { useBoundProp } from "@json-render/react";
import { useId, type ReactNode } from "react";
import { Badge, Card, Field, Segmented } from "../kit.ts";
import { DiffView } from "../components/DiffView.tsx";
import { CheckpointModes, LandingModeNames, RiskLevels } from "./catalog.local.ts";
import "./genui.css";

type Bound<T> = { value?: T | null; label: string; hint?: string };
type Props<T> = { props: Bound<T>; bindings?: Record<string, string> };

function useValue<T>(p: Props<T>): [T | null | undefined, (v: T) => void, boolean] {
  const [value, set] = useBoundProp<T | null>(p.props.value, p.bindings?.value);
  return [value, set as (v: T) => void, Boolean(p.bindings?.value)];
}

export function SectionField({ props, children }: { props: { title: string; description?: string }; children?: ReactNode }) {
  return (
    <Card title={props.title} meta={props.description} tone="inset">
      <div className="gu-stack">{children}</div>
    </Card>
  );
}

export function TextFieldInput(p: Props<string> & { props: { placeholder?: string } }) {
  const [value, set, bound] = useValue<string>(p);
  return (
    <Field label={p.props.label} hint={p.props.hint}>
      <input type="text" value={value ?? ""} placeholder={p.props.placeholder} readOnly={!bound} maxLength={400} onChange={(e) => set(e.target.value)} />
    </Field>
  );
}

export function PathListInput(p: Props<string[]>) {
  const [value, set, bound] = useValue<string[]>(p);
  const paths = value ?? [];
  const edit = (i: number, v: string) => set(paths.map((x, k) => (k === i ? v : x)));
  return (
    <fieldset className="gu-group">
      <legend>{p.props.label}</legend>
      {paths.map((path, i) => (
        <div className="gu-row" key={i}>
          <input type="text" aria-label={`${p.props.label} ${i + 1}`} value={path} readOnly={!bound} maxLength={200} onChange={(e) => edit(i, e.target.value)} />
          {bound && <button type="button" className="gu-icon" aria-label={`Remove ${path || "path"}`} onClick={() => set(paths.filter((_, k) => k !== i))}>×</button>}
        </div>
      ))}
      {bound && paths.length < 40 && <button type="button" className="gu-add" onClick={() => set([...paths, ""])}>Add a path</button>}
      {p.props.hint && <small className="muted">{p.props.hint}</small>}
    </fieldset>
  );
}

export function RiskSelectInput(p: Props<(typeof RiskLevels)[number]>) {
  const [value, set, bound] = useValue<(typeof RiskLevels)[number]>(p);
  return (
    <Field label={p.props.label} hint={p.props.hint}>
      <Segmented label={p.props.label} value={value ?? ""} options={RiskLevels.map((r) => ({ id: r, label: r }))}
        onChange={(id) => bound && set(id as (typeof RiskLevels)[number])} />
    </Field>
  );
}

type Matrix = Record<"A" | "B" | "C", (typeof CheckpointModes)[number]>;
export function CheckpointMatrixInput(p: Props<Matrix>) {
  const [value, set, bound] = useValue<Matrix>(p);
  const current = value ?? { A: "blocking", B: "blocking", C: "blocking" };
  return (
    <fieldset className="gu-group">
      <legend>{p.props.label}</legend>
      {(["A", "B", "C"] as const).map((cp) => (
        <div className="gu-matrix-row" key={cp}>
          <Badge tone="info">Checkpoint {cp}</Badge>
          <Segmented label={`Checkpoint ${cp}`} value={current[cp]} options={CheckpointModes.map((m) => ({ id: m, label: m }))}
            onChange={(id) => bound && set({ ...current, [cp]: id } as Matrix)} />
        </div>
      ))}
      {p.props.hint && <small className="muted">{p.props.hint}</small>}
    </fieldset>
  );
}

export function LandingModesInput(p: Props<string[]>) {
  const [value, set, bound] = useValue<string[]>(p);
  const chosen = value ?? [];
  return (
    <fieldset className="gu-group">
      <legend>{p.props.label}</legend>
      <div className="gu-checks">
        {LandingModeNames.map((m) => (
          <label key={m} className="gu-check">
            <input type="checkbox" checked={chosen.includes(m)} disabled={!bound}
              onChange={(e) => set(e.target.checked ? [...chosen, m] : chosen.filter((x) => x !== m))} />
            <span className="mono">{m}</span>
          </label>
        ))}
      </div>
      {p.props.hint && <small className="muted">{p.props.hint}</small>}
    </fieldset>
  );
}

const UNITS = [["d", 86_400], ["h", 3600], ["m", 60]] as const;
export function pickUnit(seconds: number): { unit: "d" | "h" | "m"; amount: number } {
  const [unit, size] = UNITS.find(([, s]) => seconds % s === 0) ?? UNITS[2];
  return { unit, amount: Math.max(1, Math.round(seconds / size)) };
}

export function DurationInput(p: Props<number>) {
  const [value, set, bound] = useValue<number>(p);
  const id = useId();
  const { unit, amount } = pickUnit(value ?? 7200);
  const size = UNITS.find(([u]) => u === unit)![1];
  return (
    <Field label={p.props.label} hint={p.props.hint}>
      <span className="gu-row">
        <input id={id} type="number" min={1} value={amount} readOnly={!bound} aria-label={`${p.props.label} amount`}
          onChange={(e) => set(Math.min(2_592_000, Math.max(60, Number(e.target.value || 1) * size)))} />
        <select aria-label={`${p.props.label} unit`} value={unit} disabled={!bound}
          onChange={(e) => set(amount * UNITS.find(([u]) => u === e.target.value)![1])}>
          <option value="m">minutes</option><option value="h">hours</option><option value="d">days</option>
        </select>
      </span>
    </Field>
  );
}

export function BudgetFieldInput(p: Props<number>) {
  const [value, set, bound] = useValue<number>(p);
  return (
    <Field label={p.props.label} hint={p.props.hint ?? "US dollars"}>
      <input type="number" min={0} step={1} value={(value ?? 0) / 1_000_000} readOnly={!bound}
        onChange={(e) => set(Math.round(Math.max(0, Number(e.target.value || 0)) * 1_000_000))} />
    </Field>
  );
}

export function ToggleInput(p: Props<boolean>) {
  const [value, set, bound] = useValue<boolean>(p);
  return (
    <Field label={p.props.label} hint={p.props.hint}>
      <input type="checkbox" role="switch" className="gu-switch" checked={Boolean(value)} disabled={!bound} onChange={(e) => set(e.target.checked)} />
    </Field>
  );
}

export function NoteText({ props }: { props: { tone: "info" | "warn"; text: string } }) {
  return (
    <Card tone={props.tone === "warn" ? "alert" : "plain"} className="gu-note">
      <p role="note"><Badge tone={props.tone === "warn" ? "warn" : "info"}>{props.tone === "warn" ? "Careful" : "Note"}</Badge> {props.text}</p>
    </Card>
  );
}

export function DiffPreviewBlock({ props }: { props: { title?: string; before: string; after: string } }) {
  return (
    <div className="gu-diff">
      {props.title && <strong>{props.title}</strong>}
      <DiffView before={props.before} after={props.after} label={props.title ?? "Preview"} context={1} />
    </div>
  );
}
