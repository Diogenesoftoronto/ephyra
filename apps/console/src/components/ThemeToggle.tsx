import { useEffect, useId, useState, type ReactNode } from "react";
import "./ThemeToggle.css";

type Choice = "light" | "dark";
const KEY = "ephyra.theme";
const EVENT = "ephyra:theme";

const read = (): Choice => {
  const current = typeof document === "undefined" ? undefined : document.documentElement.dataset.theme;
  if (current === "light" || current === "dark") return current;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* storage may be blocked */
  }
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};
function apply(choice: Choice) {
  document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* storage may be blocked */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: choice }));
}

const ICONS: Record<Choice, ReactNode> = {
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
};
const LABELS: Record<Choice, string> = { light: "Light", dark: "Dark" };
const OPTIONS: Choice[] = ["light", "dark"];

/**
 * Two icon buttons, one selected theme. Use the device preference until the person makes an explicit choice.
 */
export function ThemeToggle({ labelled = false }: { labelled?: boolean }) {
  const [choice, setChoice] = useState<Choice>(read);
  const id = useId();
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setChoice(read());
    const storage = (e: StorageEvent) => {
      if (e.key !== KEY && e.key !== null) return;
      if (e.newValue === "light" || e.newValue === "dark") document.documentElement.dataset.theme = e.newValue;
      else document.documentElement.removeAttribute("data-theme");
      sync();
    };
    media.addEventListener("change", sync);
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", storage);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", storage);
    };
  }, []);
  const choose = (next: Choice) => { setChoice(next); apply(next); };
  return (
    <div className="theme-toggle" data-labelled={labelled ? "" : undefined}>
      <span className="theme-toggle__legend" id={id}>Theme</span>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="theme-toggle__group"
        onKeyDown={(e) => {
          const next = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(e.key)
            ? choice === "light" ? "dark" : "light"
            : e.key === "Home" ? "light" : e.key === "End" ? "dark" : null;
          if (!next) return;
          e.preventDefault();
          choose(next);
          (e.currentTarget.querySelector(`[data-choice="${next}"]`) as HTMLElement | null)?.focus();
        }}
      >
        {OPTIONS.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            data-choice={o}
            aria-checked={choice === o}
            tabIndex={choice === o ? 0 : -1}
            aria-label={LABELS[o]}
            onClick={() => choose(o)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {ICONS[o]}
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
