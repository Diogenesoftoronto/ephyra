import { useState } from "react";
import { PERSONAS, type PersonaId } from "@ephyra/core";
import { usePrefersReducedMotion } from "../lib/hooks.ts";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import "./assistant.css";

/** "Velum is drafting…" with the typing animation. Without the file, or with reduced motion, it is the avatar and a line of text. */
export function WorkingIndicator({ persona = "velum", base = "/app/personas" }: { persona?: PersonaId; base?: string }) {
  const reduced = usePrefersReducedMotion();
  const [missing, setMissing] = useState(false);
  const name = PERSONAS.find((p) => p.id === persona)!.name;
  return (
    <div className="thread-working" role="status" aria-live="polite">
      {persona === "velum" && !reduced && !missing
        ? <img src={`${base}/velum-typing.gif`} alt="" width={48} height={48} onError={() => setMissing(true)} />
        : <PersonaAvatar persona={persona} size={32} live />}
      <span>{name} is drafting…</span>
    </div>
  );
}
