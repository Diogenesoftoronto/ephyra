import { PERSONAS, type PersonaId } from "@ephyra/core";
import { Avatar } from "../kit.ts";
import { useDarkSurface } from "../lib/hooks.ts";

/**
 * Persona art lives at /app/personas: `<id>-64.webp` for avatars up to 48px, `<id>.webp` above that, and the loops
 * `<id>.webm` / `<id>.mp4`. The loops are opaque on dark (#070f18), so they play only on dark surfaces and at 48px or more;
 * everywhere else the transparent still breathes instead. A missing file falls back to the initial on the persona colour.
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
  const dark = useDarkSurface();
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
      video={live && dark && size >= 48 ? { webm: media.webm, mp4: media.mp4 } : undefined}
      breathe={live}
    />
  );
}
