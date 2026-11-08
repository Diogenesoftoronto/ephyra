import { PERSONAS, type PersonaId } from "@ephyra/core";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import "./assistant.css";

/** Mounted only while a drafting request is pending. Transparent motion, with a still and text for reduced motion. */
export function WorkingIndicator({
  persona = "velum",
  base = "/app/personas",
}: {
  persona?: PersonaId;
  base?: string;
}) {
  const name = PERSONAS.find((p) => p.id === persona)!.name;
  return (
    <div className="thread-working" role="status" aria-live="polite">
      <PersonaAvatar persona={persona} size={48} live base={base} />
      <span>{name} is drafting…</span>
    </div>
  );
}
