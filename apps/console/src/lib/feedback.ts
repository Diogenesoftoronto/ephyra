export type FeedbackSound = "touch" | "copy" | "connected" | "invitation" | "message" | "attention";
export const SOUND_KEY = "ephyra.sound";
const listeners = new Set<() => void>();
let enabled = false;
let initialized = false;
let current: HTMLAudioElement | undefined;
let previous = -Infinity;

const stop = () => { if (current) { current.pause(); current.currentTime = 0; } current = undefined; };
function initialize() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  try { enabled = localStorage.getItem(SOUND_KEY) === "on"; } catch { /* Off until chosen in this tab. */ }
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("storage", event => {
    if (event.key === SOUND_KEY || event.key === null) {
      enabled = event.key !== null && event.newValue === "on";
      if (!enabled) stop();
      for (const listener of listeners) listener();
    }
  });
}
export function soundEnabled() { initialize(); return enabled; }
export function subscribeSound(listener: () => void) { initialize(); listeners.add(listener); return () => { listeners.delete(listener); }; }
export function setSoundEnabled(value: boolean) {
  initialize(); enabled = value;
  try { localStorage.setItem(SOUND_KEY, value ? "on" : "off"); } catch { /* Memory-only preference. */ }
  if (!value) stop();
  for (const listener of listeners) listener();
}
/** No preloading, autoplay, overlapping sounds, hidden-tab sounds or error celebrations. */
export function playFeedback(sound: FeedbackSound) {
  if (!soundEnabled() || typeof document === "undefined" || document.hidden || performance.now() - previous < 500) return;
  previous = performance.now();
  stop();
  const audio = new Audio(`/app/juice/sounds/${sound}.mp3`);
  current = audio;
  audio.volume = 0.35;
  audio.preload = "none";
  void audio.play().catch(() => { if (current === audio) current = undefined; });
  audio.onended = () => { if (current === audio) current = undefined; };
}
