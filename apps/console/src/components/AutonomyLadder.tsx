import { AUTONOMY_LEVELS, type AutonomyLevel, type AreaSketch } from "@ephyra/core";
import { Badge, Segmented } from "../kit.ts";
import "./AutonomyLadder.css";

/** The five-step ladder: Watch, Research, Propose, Patch, Auto-land. The text under it says what the chosen step means. */
export function AutonomyLadder({ value, onChange, risk, label = "Autonomy level" }: {
  value: AutonomyLevel; onChange?: (level: AutonomyLevel) => void; risk?: AreaSketch["risk"]; label?: string;
}) {
  const means = AUTONOMY_LEVELS.find((l) => l.id === value)!.means;
  return (
    <div className="ladder">
      {onChange
        ? <Segmented label={label} value={value} onChange={(id) => onChange(id as AutonomyLevel)} options={AUTONOMY_LEVELS.map((l) => ({ id: l.id, label: l.label, hint: l.means }))} />
        : <div><Badge tone="info">{AUTONOMY_LEVELS.find((l) => l.id === value)!.label}</Badge></div>}
      <p className="ladder-means muted" aria-live="polite">{means}</p>
      {value === "auto" && risk === "critical" && <Badge tone="warn">Auto-land on a critical area: proven changes land with no person involved.</Badge>}
    </div>
  );
}
