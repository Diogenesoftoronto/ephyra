import { PERSONAS, type PersonaId } from "@ephyra/core";
import { Avatar } from "../kit.ts";
import { usePrefersReducedMotion } from "../lib/hooks.ts";

/** Where the persona art lives once built and served: /app/personas/<id>.{webp,webm,mp4} (assets from another lane). */
export const personaMedia = (id: PersonaId, base = "/app/personas") => ({
  still: `${base}/${id}.webp`, webm: `${base}/${id}.webm`, mp4: `${base}/${id}.mp4`,
});

/**
 * A persona's face: the still, looping when motion is allowed, and the persona's initial on its colour when a file is
 * missing. With `prefers-reduced-motion` the loop is never loaded.
 */
export function PersonaAvatar({ persona, size = 48, live, base }: { persona: PersonaId; size?: 24 | 32 | 48 | 96; live?: boolean; base?: string }) {
  const reduced = usePrefersReducedMotion();
  const p = PERSONAS.find((x) => x.id === persona)!;
  const media = personaMedia(persona, base);
  return (
    <Avatar src={media.still} video={reduced || size < 48 ? undefined : [media.webm, media.mp4]} initial={p.name[0]!} color={`var(${p.color})`}
      size={size} live={live} />
  );
}
