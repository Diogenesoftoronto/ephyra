import "./PersonaLabel.css";
import { PERSONAS, type PersonaId } from "@ephyra/core";
import { PersonaAvatar } from "./PersonaAvatar.tsx";
import { PersonaTag, Tag } from "../kit.ts";

/** A persona's face and name, or "Unattributed" for work that belongs to no persona. */
export function PersonaLabel({ persona, size = 24 }: { persona: PersonaId | null; size?: 24 | 32 }) {
  if (!persona) return <Tag>unattributed</Tag>;
  const p = PERSONAS.find((x) => x.id === persona)!;
  return (
    <span className="persona-label">
      <PersonaAvatar persona={persona} size={size} />
      <PersonaTag persona={persona} withMark={false}>
        {p.name}
      </PersonaTag>
    </span>
  );
}
