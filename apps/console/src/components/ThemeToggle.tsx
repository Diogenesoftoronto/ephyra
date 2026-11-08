import { useEffect, useState } from "react";
import { Icon } from "../kit.ts";
import "./ThemeToggle.css";

type Choice = "system" | "light" | "dark";
const KEY = "ephyra.theme";

const read = (): Choice => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
};

/** Follow the system until the user explicitly chooses light or dark. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>(read);
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (choice === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = choice;
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      /* storage may be blocked */
    }
  }, [choice]);
  const dark = choice === "system" ? systemDark : choice === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-label="Dark mode"
      aria-checked={dark}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="theme-toggle"
      onClick={() => setChoice(dark ? "light" : "dark")}
    >
      <span className="theme-toggle-track" aria-hidden="true">
        <Icon name="sun" />
        <Icon name="moon" />
        <span className="theme-toggle-thumb">
          <Icon name={dark ? "moon" : "sun"} />
        </span>
      </span>
    </button>
  );
}
