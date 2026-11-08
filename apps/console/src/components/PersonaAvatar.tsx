import { PERSONAS, type PersonaId } from "@ephyra/core";
import { Avatar } from "../kit.ts";
import "./PersonaAvatar.css";

/**
 * Transparent art works on every surface. CSS supplies the bell pulse only for recorded running work.
 * The original video exports remain available, but their opaque backgrounds aren't used in the console.
 */
export const personaMedia = (id: PersonaId, size: number, base = "/app/personas") => ({
  still: `${base}/${id}${size <= 48 ? "-64" : ""}.webp`,
  webm: `${base}/${id}.webm`,
  mp4: `${base}/${id}.mp4`,
});

export function PersonaAvatar({
  persona,
  size = 32,
  live,
  base,
}: {
  persona: PersonaId;
  size?: 24 | 32 | 48 | 96;
  live?: boolean;
  base?: string;
}) {
  const p = PERSONAS.find((x) => x.id === persona)!;
  const media = personaMedia(persona, size, base);
  return (
    <Avatar
      src={media.still}
      initial={p.name[0]!}
      color={`var(${p.color})`}
      tint={`var(${p.color}-tint)`}
      size={size}
      label={p.name}
      breathe={live}
      className="persona-avatar"
    />
  );
}
