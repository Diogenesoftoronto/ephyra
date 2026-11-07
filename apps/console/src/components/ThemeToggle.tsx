import { useEffect, useState } from "react";
import { Segmented } from "../kit.ts";

type Choice = "system" | "light" | "dark";
const KEY = "ephyra.theme";

const read = (): Choice => {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
};

/** Light, dark, or follow the system. The choice is remembered in this browser only. */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (choice === "system") root.removeAttribute("data-theme"); else root.dataset.theme = choice;
    try { if (choice === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, choice); } catch { /* storage may be blocked */ }
  }, [choice]);
  return (
    <Segmented label="Theme" value={choice} onChange={(id) => setChoice(id as Choice)}
      options={[{ id: "system", label: "Auto" }, { id: "light", label: "Light" }, { id: "dark", label: "Dark" }]} />
  );
}
