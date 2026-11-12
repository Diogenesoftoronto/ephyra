import { playFeedback } from "../lib/feedback.ts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMotionAllowed } from "../lib/motion.ts";
import { createJellyRenderer, type JellyRenderer } from "../lib/jelly-shader.ts";
import "./JellySpecimen.css";
import { CharacterGesture } from "./CharacterGesture.tsx";

export const SPECIMEN_ART = "/app/motion/ephyra-specimen-v2.png";

/** A small, explicitly playful interaction. It never represents health, connection, or agent activity. */
export function JellySpecimen({ size = 112, src = SPECIMEN_ART }: { size?: number; src?: string }) {
  return src === SPECIMEN_ART
    ? <CharacterGesture poster={src} clip="/app/juice/characters/ephyra-v2.webm" label="Ripple the Ephyra specimen" size={size} />
    : <ShaderSpecimen size={size} src={src} />;
}

function ShaderSpecimen({ size, src }: { size: number; src: string }) {
  const element = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const poster = useRef<HTMLImageElement>(null);
  const renderer = useRef<JellyRenderer | null>(null);
  const lastTouch = useRef(0);
  const point = useRef<readonly [number, number]>([0.5, 0.5]);
  const allowed = useMotionAllowed(element);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [rendered, setRendered] = useState(false);

  const ripple = () => {
    if (!allowed || failed || missing || !poster.current?.naturalWidth) return;
    lastTouch.current = performance.now();
    setPlaying(true);
  };
  useEffect(() => {
    if (!allowed) setPlaying(false);
  }, [allowed]);
  useEffect(() => {
    const target = canvas.current;
    const lost = () => {
      setFailed(true);
      setPlaying(false);
      setRendered(false);
    };
    target?.addEventListener("webglcontextlost", lost);
    return () => target?.removeEventListener("webglcontextlost", lost);
  }, []);
  useEffect(() => {
    setFailed(false);
    setMissing(false);
    setRendered(false);
    setPlaying(false);
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [src]);
  useEffect(() => {
    const target = canvas.current;
    const image = poster.current;
    if (!allowed || !playing || !target || !image?.complete || !image.naturalWidth) return;
    if (!renderer.current) {
      const pixels = Math.min(384, Math.round(size * Math.min(devicePixelRatio || 1, 2)));
      target.width = pixels;
      target.height = pixels;
      renderer.current = createJellyRenderer(target, image);
    }
    const draw = renderer.current;
    if (!draw) {
      setFailed(true);
      setPlaying(false);
      return;
    }
    let frame = 0;
    let previous = 0;
    const tick = (now: number) => {
      const elapsed = now - lastTouch.current;
      if (elapsed >= 2100) {
        setPlaying(false);
        return;
      }
      // 30fps is ample for a tiny specimen; the final half-second gently settles to its poster.
      if (now - previous >= 1000 / 30) {
        draw.render(elapsed / 2100, Math.min(1, elapsed / 100, (2100 - elapsed) / 500), point.current);
        setRendered(true);
        previous = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [allowed, playing, size, src]);

  return (
    <button
      ref={element}
      type="button"
      className="jelly-specimen"
      style={{ "--specimen-size": `${size}px` } as CSSProperties}
      aria-label="Ripple the Ephyra specimen"
      title="Touch the jelly"
      data-motion={allowed && playing && rendered && !failed ? "playing" : "still"}
      onPointerEnter={ripple}
      onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        point.current = [(event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height];
      }}
      onFocus={ripple}
      onClick={() => { ripple(); playFeedback("touch"); }}
    >
      <img
        ref={poster}
        src={missing ? "/app/brand/logo.svg" : src}
        alt=""
        width={512}
        height={512}
        onError={() => {
          if (!missing) setMissing(true);
        }}
      />
      <canvas ref={canvas} aria-hidden="true" />
    </button>
  );
}
