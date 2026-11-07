import { PERSONAS } from "@ephyra/core";
import { Button, Field } from "../kit.ts";
import { EXECUTOR_LABEL } from "./ExecutorChip.tsx";
import "./RunFilters.css";

export type RunFilterValue = { trail: string; persona: string; executor: string };
export const noRunFilters: RunFilterValue = { trail: "", persona: "", executor: "" };

export function RunFilters({
  value,
  trails,
  onChange,
}: {
  value: RunFilterValue;
  trails: Array<{ id: string; short: string }>;
  onChange: (v: RunFilterValue) => void;
}) {
  const set = (patch: Partial<RunFilterValue>) => onChange({ ...value, ...patch });
  const active = value.trail !== "" || value.persona !== "" || value.executor !== "";
  return (
    <form className="run-filters" aria-label="Run filters" onSubmit={(e) => e.preventDefault()}>
      <Field label="Trail">
        <select value={value.trail} onChange={(e) => set({ trail: e.target.value })}>
          <option value="">All trails</option>
          {trails.map((t) => (
            <option key={t.id} value={t.id}>
              {t.short}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Persona">
        <select value={value.persona} onChange={(e) => set({ persona: e.target.value })}>
          <option value="">All personas</option>
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Executor">
        <select value={value.executor} onChange={(e) => set({ executor: e.target.value })}>
          <option value="">All executors</option>
          {Object.entries(EXECUTOR_LABEL).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Field>
      {active && (
        <Button size="sm" variant="ghost" onClick={() => onChange(noRunFilters)}>
          Clear filters
        </Button>
      )}
    </form>
  );
}
