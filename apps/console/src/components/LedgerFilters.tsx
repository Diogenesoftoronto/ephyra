import { PERSONAS } from "@ephyra/core";
import { Button, Field } from "../kit.ts";
import { noFilters, type LedgerFilterValue } from "./Ledger.tsx";
import "./LedgerFilters.css";

export function LedgerFilters({
  value,
  engines,
  trails,
  onChange,
}: {
  value: LedgerFilterValue;
  engines: string[];
  trails: Array<{ id: string; short: string }>;
  onChange: (v: LedgerFilterValue) => void;
}) {
  const set = (patch: Partial<LedgerFilterValue>) => onChange({ ...value, ...patch });
  const active = JSON.stringify(value) !== JSON.stringify(noFilters);
  return (
    <form className="ledger-filters" onSubmit={(e) => e.preventDefault()} aria-label="Ledger filters">
      <Field label="Persona">
        <select value={value.persona} onChange={(e) => set({ persona: e.target.value })}>
          <option value="">All</option>
          {PERSONAS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          <option value="unattributed">Unattributed</option>
        </select>
      </Field>
      <Field label="Engine">
        <select value={value.engine} onChange={(e) => set({ engine: e.target.value })}>
          <option value="">All</option>
          {engines.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Quest">
        <select value={value.trail} onChange={(e) => set({ trail: e.target.value })}>
          <option value="">All</option>
          {trails.map((t) => (
            <option key={t.id} value={t.id}>
              {t.short}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Result">
        <select
          value={value.outcome}
          onChange={(e) => set({ outcome: e.target.value as LedgerFilterValue["outcome"] })}
        >
          <option value="all">All</option>
          <option value="ok">ok</option>
          <option value="failed">Failed</option>
          <option value="unavailable">Unavailable</option>
          <option value="unknown-cost">Unknown cost</option>
        </select>
      </Field>
      {active && (
        <Button size="sm" variant="ghost" onClick={() => onChange(noFilters)}>
          Clear filters
        </Button>
      )}
    </form>
  );
}
