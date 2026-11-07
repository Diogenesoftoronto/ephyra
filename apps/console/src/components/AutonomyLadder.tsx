import { AUTONOMY_LEVELS, type AutonomyLevel, type AreaSketch } from "@ephyra/core";
import { Badge, Segmented } from "../kit.ts";
import "./AutonomyLadder.css";

/** The five-step ladder: Watch, Research, Propose, Patch, Auto-land. The text under it says what the chosen step means. */
export function AutonomyLadder({
  value,
  onChange,
  risk,
  label = "Autonomy level",
}: {
  value: AutonomyLevel;
  onChange?: (level: AutonomyLevel) => void;
  risk?: AreaSketch["risk"];
  label?: string;
}) {
  const current = AUTONOMY_LEVELS.find((l) => l.id === value)!;
  return (
    <div className="ladder">
      {onChange ? (
        <Segmented
          label={label}
          name={`ladder-${label}`}
          value={value}
          onChange={onChange}
          options={AUTONOMY_LEVELS.map((l) => ({ id: l.id, label: l.label, hint: l.means }))}
        />
      ) : (
        <p className="ladder-read">
          <Badge tone="info">{current.label}</Badge> <span className="muted">{current.means}</span>
        </p>
      )}
      {value === "auto" && risk === "critical" && (
        <Badge tone="warn">Auto-land on a critical area: proven changes land with no person involved.</Badge>
      )}
    </div>
  );
}
