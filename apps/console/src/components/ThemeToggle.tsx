import { useEffect, useId, useState, type ReactNode } from "react";
import "./ThemeToggle.css";

type Choice = "system" | "light" | "dark";
const KEY = "ephyra.theme";
const EVENT = "ephyra:theme";

const read = (): Choice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};
function apply(choice: Choice) {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = choice;
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    /* storage may be blocked */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: choice }));
}

const ICONS: Record<Choice, ReactNode> = {
  system: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  dark: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
};
const LABELS: Record<Choice, string> = { system: "Auto", light: "Light", dark: "Dark" };

/**
 * Theme: follow the system, or choose light or dark. A radio group, so the current choice is announced and visible
 * (filled segment plus a check) rather than implied by a switch position.
 */
export function ThemeToggle({ labelled = false }: { labelled?: boolean }) {
  const [choice, setChoice] = useState<Choice>(read);
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const id = useId();
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    const sync = (e: Event) => setChoice((e as CustomEvent<Choice>).detail);
    media.addEventListener("change", update);
    window.addEventListener(EVENT, sync);
    return () => { media.removeEventListener("change", update); window.removeEventListener(EVENT, sync); };
  }, []);
  const choose = (next: Choice) => { setChoice(next); apply(next); };
  const options: Choice[] = ["system", "light", "dark"];
  return (
    <div className="theme-toggle" data-labelled={labelled ? "" : undefined}>
      <span className="theme-toggle__legend" id={id}>Theme</span>
      <div
        role="radiogroup"
        aria-labelledby={id}
        className="theme-toggle__group"
        onKeyDown={(e) => {
          const i = options.indexOf(choice);
          const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? options[(i + 1) % 3]
            : e.key === "ArrowLeft" || e.key === "ArrowUp" ? options[(i + 2) % 3] : null;
          if (!next) return;
          e.preventDefault();
          choose(next);
          (e.currentTarget.querySelector(`[data-choice="${next}"]`) as HTMLElement | null)?.focus();
        }}
      >
        {options.map((o) => (
          <button
            key={o}
            type="button"
            role="radio"
            data-choice={o}
            aria-checked={choice === o}
            tabIndex={choice === o ? 0 : -1}
            title={o === "system" ? `Match your device (now ${systemDark ? "dark" : "light"})` : `${LABELS[o]} theme`}
            onClick={() => choose(o)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {ICONS[o]}
            </svg>
            <span className="theme-toggle__text">{LABELS[o]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
