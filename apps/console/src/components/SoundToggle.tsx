import { useSyncExternalStore } from "react";
import { playFeedback, setSoundEnabled, soundEnabled, subscribeSound } from "../lib/feedback.ts";
import "./SoundToggle.css";

export function SoundToggle() {
  const enabled = useSyncExternalStore(subscribeSound, soundEnabled, () => false);
  return <button type="button" className="sound-toggle" role="switch" aria-checked={enabled}
    aria-label="Interface sounds" title={enabled ? "Turn interface sounds off" : "Turn interface sounds on"}
    onClick={() => { setSoundEnabled(!enabled); if (!enabled) playFeedback("touch"); }}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {enabled ? <path d="M16 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /> : <path d="m17 10 4 4m0-4-4 4" />}
    </svg>
    <span>Sound {enabled ? "on" : "off"}</span>
  </button>;
}
