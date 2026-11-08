import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMotionAllowed } from "../lib/motion.ts";
import { playFeedback } from "../lib/feedback.ts";
import "./CharacterGesture.css";

/** One optional greeting, never a proxy for agent progress. Provider sound is replaced by the opt-in UI cue. */
export function CharacterGesture({ poster, clip, label, size = 112 }: { poster: string; clip: string; label: string; size?: number }) {
  const element = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const allowed = useMotionAllowed(element);
  const [loaded, setLoaded] = useState(false);
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const movie = video.current;
    if (!movie || !requested || !allowed || failed) {
      movie?.pause(); setPlaying(false);
      if (!allowed) setRequested(false);
      return;
    }
    let active = true;
    movie.currentTime = 0;
    void movie.play().then(() => { if (active) setPlaying(true); }).catch(() => {
      if (active) { setPlaying(false); setRequested(false); }
    });
    return () => { active = false; movie.pause(); };
  }, [requested, allowed, failed, clip]);
  const greet = () => { if (allowed && !failed) { setLoaded(true); setRequested(true); } };
  return <button ref={element} type="button" className="character-gesture jelly-specimen"
    style={{ "--specimen-size": `${size}px` } as CSSProperties} aria-label={playing ? `Pause ${label.toLowerCase()}` : label}
    title={playing ? "Pause greeting" : "Say hello"} data-motion={playing ? "playing" : "still"}
    onPointerEnter={() => {
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      if (matchMedia("(hover: hover)").matches && !connection?.saveData) greet();
    }}
    onClick={() => { if (requested) setRequested(false); else { greet(); playFeedback("touch"); } }}>
    <img src={missing ? "/app/brand/logo.svg" : poster} width={512} height={512} alt="" onError={() => setMissing(true)} />
    <video ref={video} src={loaded && !failed ? clip : undefined} muted playsInline preload="none" aria-hidden="true"
      onLoadedData={() => {
        // Browsers that decode VP9 without alpha keep the approved still instead of showing a black rectangle.
        const movie = video.current;
        if (!movie) return;
        try {
          const canvas = document.createElement("canvas"); canvas.width = canvas.height = 2;
          const context = canvas.getContext("2d");
          context?.drawImage(movie, 0, 0, 2, 2, 0, 0, 2, 2);
          if (!context || context.getImageData(0, 0, 1, 1).data[3]! > 24) setFailed(true);
        } catch { setFailed(true); }
      }}
      onEnded={() => { setPlaying(false); setRequested(false); }} onError={() => { setFailed(true); setPlaying(false); setRequested(false); }} />
  </button>;
}
