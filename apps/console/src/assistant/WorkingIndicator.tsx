import { useState } from "react";
import { PERSONAS, type PersonaId } from "@ephyra/core";
import { useDarkSurface, usePrefersReducedMotion } from "../lib/hooks.ts";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import "./assistant.css";

/**
 * "Velum is drafting…" with the typing animation. The animation is opaque on dark, so it plays on dark surfaces only; on
 * light, with reduced motion, or without the files, it is the breathing still and a line of text.
 */
export function WorkingIndicator({
  persona = "velum",
  base = "/app/personas",
}: {
  persona?: PersonaId;
  base?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const dark = useDarkSurface();
  const [missing, setMissing] = useState(false);
  const name = PERSONAS.find((p) => p.id === persona)!.name;
  const typing = persona === "velum" && dark && !reduced && !missing;
  return (
    <div className="thread-working" role="status" aria-live="polite">
      {typing ? (
        <video
          autoPlay
          loop
          muted
          playsInline
          width={48}
          height={48}
          aria-hidden="true"
          onError={() => setMissing(true)}
        >
          <source src={`${base}/velum-typing.webm`} type="video/webm" />
          <source src={`${base}/velum-typing.mp4`} type="video/mp4" />
        </video>
      ) : (
        <PersonaAvatar persona={persona} size={32} live={!reduced} />
      )}
      <span>{name} is drafting…</span>
    </div>
  );
}
