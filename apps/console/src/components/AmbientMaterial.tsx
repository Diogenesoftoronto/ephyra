import { useEffect, useRef, useState } from "react";
import { useMotionAllowed } from "../lib/motion.ts";
import { useMediaQuery } from "../lib/hooks.ts";
import "./AmbientMaterial.css";

/** One short entrance gesture, with an explicit replay. Never a loading or agent-activity indicator. */
export function AmbientMaterial({ base }: { base: string }) {
  const layer = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const started = useRef(false);
  const forcedColors = useMediaQuery("(forced-colors: active)");
  const allowed = useMotionAllowed(layer, !forcedColors);
  const [loaded, setLoaded] = useState(false);
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saveData] = useState(() => typeof navigator !== "undefined" &&
    Boolean((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData));

  useEffect(() => {
    if (allowed && !started.current && !saveData) {
      started.current = true;
      setLoaded(true);
      setRequested(true);
    }
    if (!allowed) setRequested(false);
  }, [allowed, saveData]);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    if (!allowed || !requested || failed) { node.pause(); setPlaying(false); return; }
    let current = true;
    void node.play().then(() => { if (current) setPlaying(true); }, () => {
      if (current) { setPlaying(false); setRequested(false); }
    });
    return () => { current = false; node.pause(); };
  }, [allowed, requested, loaded, failed]);

  function toggle() {
    if (!allowed || failed) return;
    if (requested) { setRequested(false); return; }
    setLoaded(true);
    if (video.current?.ended) video.current.currentTime = 0;
    setRequested(true);
  }

  return <>
    <div className="ambient-material" ref={layer} aria-hidden="true" data-playing={playing}
      style={{ backgroundImage: `url("${base}.webp")` }}>
      {loaded && <video ref={video} muted playsInline preload="none" tabIndex={-1}
        onEnded={() => { setPlaying(false); setRequested(false); }}
        onError={() => { setFailed(true); setPlaying(false); setRequested(false); }}>
        <source src={`${base}.webm`} type="video/webm" />
        <source src={`${base}.mp4`} type="video/mp4" />
      </video>}
    </div>
    <button className="material-scene__motion" type="button" onClick={toggle} disabled={!allowed || failed}
      aria-label={requested ? "Pause background light" : "Play background light"}
      title={allowed ? "A short decorative light study" : "Still artwork follows your device’s motion preference"}>
      {requested ? "Pause light" : "Play light"}
    </button>
  </>;
}
