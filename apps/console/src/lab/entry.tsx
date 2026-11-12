// The design lab: one simulated hour, seven layouts, three benches. Everything a layout needs arrives through
// LayoutProps, so the comparison is fair: same quests, same kit, same keys, same replay.
// State lives in the URL (?t=110&theme=dark&q=T-c0ffee&hood=1#/layouts/h) so a screenshot can be reproduced from its address.
import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { playFeedback } from "../lib/feedback.ts";
import { useMediaQuery } from "../lib/hooks.ts";
import { HOOD_TABS, Inspector, type HoodTab } from "../loop/Inspector.tsx";
import { byAttention, journeyOf, lastOf, type QuestView } from "../loop/model.ts";
import { Transport, type MeterVariant, type RowVariant } from "../loop/parts.tsx";
import { HERO_TICK, LAST_TICK, nowLine, runEventsAt, timelines, worldAt, type Injected } from "../loop/scenario.ts";
import { AlignmentLab, ComponentBench, MotionBench } from "./benches.tsx";
import { LAYOUTS, type LayoutId, type LayoutProps } from "./layouts.tsx";
import "../theme.css";
import "./lab.css";

type Page = { kind: "layout"; id: LayoutId } | { kind: "components" | "alignment" | "motion" };
const BENCHES = ["components", "alignment", "motion"] as const;

function pageOf(hash: string): Page {
  const [, a, b] = hash.replace(/^#/, "").split("/");
  if (a === "layouts") return { kind: "layout", id: LAYOUTS.find((layout) => layout.id === b)?.id ?? "h" };
  const bench = BENCHES.find((id) => id === a);
  return bench ? { kind: bench } : { kind: "layout", id: "h" };
}

const one = <T extends string>(value: string | null, allowed: readonly T[]): T | null => allowed.find((item) => item === value) ?? null;
const clamp = (tick: number) => Math.min(LAST_TICK, Math.max(0, Math.round(Number.isFinite(tick) ? tick : HERO_TICK)));
const typing = (target: EventTarget | null) => target instanceof HTMLElement
  && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
const native = (target: EventTarget | null) => target instanceof HTMLElement
  && ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "SUMMARY"].includes(target.tagName);

const KEYS: [string, string][] = [
  ["j  k", "Next or previous quest"], ["a", "Go to the one thing that needs you"], ["a  ↵", "Do it. Two keys, never one by accident"],
  ["i", "Open or close under the hood"], ["space", "Play or pause the hour"], ["[  ]", "Step one tick back or forward"],
  ["{  }", "Jump to the previous or next notable moment"], ["1 – 7", "Switch layout"], ["g", "Show the left edges"], ["?", "This list"],
];

/** Every distinct x where something in the layout starts. Fewer is calmer; the overlay draws them. */
function useRails(on: boolean, dep: unknown): number[] {
  const [rails, setRails] = useState<number[]>([]);
  useLayoutEffect(() => {
    if (!on) return setRails([]);
    const measure = () => {
      const edges = [...document.querySelectorAll<HTMLElement>(".lab-frame [data-rail], .lab-main > *, .lab-aside > * > *")]
        .filter((el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0)
        .map((el) => Math.round(el.getBoundingClientRect().left));
      setRails([...new Set(edges)].sort((a, b) => a - b));
    };
    measure();
    const timer = setTimeout(measure, 400);
    window.addEventListener("resize", measure);
    return () => { clearTimeout(timer); window.removeEventListener("resize", measure); };
  }, [on, dep]);
  return rails;
}

function Lab() {
  const start = useMemo(() => new URLSearchParams(location.search), []);
  const [page, setPage] = useState<Page>(() => pageOf(location.hash));
  const [tick, setTick] = useState(() => clamp(Number(start.get("t") ?? HERO_TICK)));
  const [playing, setPlaying] = useState(start.get("play") === "1");
  const [theme, setTheme] = useState<"light" | "dark">(() => one(start.get("theme"), ["light", "dark"] as const)
    ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [calm, setCalm] = useState(start.get("motion") === "reduced");
  const [grid, setGrid] = useState(start.get("grid") === "1");
  const [picked, setPicked] = useState<string | null>(start.get("q"));
  const [hood, setHood] = useState(start.get("hood") === "1");
  const [tab, setTab] = useState<HoodTab>(() => one(start.get("tab"), HOOD_TABS) ?? "events");
  const [injected, setInjected] = useState<Injected[]>([]);
  const [toast, setToast] = useState("");
  const row = one(start.get("row"), ["strip", "sentence", "card"] as const) as RowVariant | null;
  const meter: MeterVariant = one(start.get("meter"), ["path", "strip", "ring"] as const) ?? "path";
  const chrome = start.get("chrome") !== "0";
  const narrow = useMediaQuery("(max-width: 720px)");
  const help = useRef<HTMLDialogElement>(null);
  const aside = useRef<HTMLDivElement>(null);
  const scrub = useRef<ReturnType<typeof setTimeout>>(undefined);

  const world = useMemo(() => worldAt(tick, injected), [tick, injected]);
  const order = useMemo(() => [...world.views].sort(byAttention), [world]);
  const selected = world.quests.find((quest) => quest.view.short === picked || quest.id === picked)
    ?? world.quests.find((quest) => quest.id === world.fleet.focus) ?? null;
  const waiting = order.filter((view) => view.action !== null);
  const needs = world.quests.find((quest) => quest.id === waiting[0]?.id) ?? null;
  const timeline = selected ? timelines(injected).find((entry) => entry.id === selected.id) ?? null : null;
  const steps = useMemo(() => (selected ? journeyOf(selected.events, selected.trail) : []), [selected]);
  const moment = lastOf(world.beacons, (beacon) => beacon.tick <= tick);
  const short = selected?.view.short ?? null;
  const rails = useRails(grid && page.kind === "layout", `${page.kind === "layout" ? page.id : ""}:${tick}:${selected?.id}:${narrow}`);

  useEffect(() => {
    const onHash = () => setPage(pageOf(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    if (calm) root.dataset.motion = "reduced"; else delete root.dataset.motion;
  }, [theme, calm]);

  // The address always says what is on screen.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const put = (key: string, value: string | null) => (value === null ? params.delete(key) : params.set(key, value));
    put("t", tick === HERO_TICK ? null : String(tick));
    put("theme", theme);
    put("motion", calm ? "reduced" : null);
    put("grid", grid ? "1" : null);
    put("q", picked ? short ?? picked : null);
    put("hood", hood ? "1" : null);
    put("tab", hood && tab !== "events" ? tab : null);
    params.delete("play");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  }, [tick, theme, calm, grid, picked, short, hood, tab]);

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setTick((now) => {
      if (now >= LAST_TICK) { setPlaying(false); return now; }
      return now + 1;
    }), 400);
    return () => clearInterval(timer);
  }, [playing]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  const seek = useCallback((next: number) => {
    document.documentElement.dataset.scrub = "";
    clearTimeout(scrub.current);
    scrub.current = setTimeout(() => { delete document.documentElement.dataset.scrub; }, 260);
    setTick(clamp(next));
  }, []);

  const select = useCallback((id: string) => {
    setPicked(id);
    playFeedback("touch");
    if (matchMedia("(max-width: 1100px)").matches) {
      const quiet = document.documentElement.dataset.motion === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
      requestAnimationFrame(() => aside.current?.querySelector(".lab-aside")?.scrollIntoView({ behavior: quiet ? "auto" : "smooth", block: "start" }));
    }
  }, []);

  const inject = useCallback((quest: QuestView, action: Injected["action"], note?: string) => {
    setInjected((all) => [...all, { quest: quest.id, tick, action, ...(note ? { note } : {}) }]);
  }, [tick]);

  const act = useCallback((quest: QuestView) => {
    const action = quest.action;
    if (!action) return;
    if (action.kind === "decide") {
      inject(quest, "approve");
      playFeedback("connected");
      setToast(`Approved. ${quest.short} moves on by itself.`);
    } else if (action.kind === "resume") {
      inject(quest, "resume");
      setToast(`Resumed ${quest.short}.`);
    } else {
      setToast(`The lab cannot ${action.kind} for you. In the console this is one press.`);
    }
  }, [inject]);
  const revise = useCallback((quest: QuestView, note: string) => {
    inject(quest, "revise", note);
    setToast(`Sent ${quest.short} back with your note. It becomes the next attempt's first observation.`);
  }, [inject]);
  const drop = useCallback((quest: QuestView) => {
    inject(quest, "drop");
    setToast(`Dropped ${quest.short}. Nothing lands.`);
  }, [inject]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        if (help.current?.open) return;
        if (hood) { event.preventDefault(); setHood(false); }
        return;
      }
      if (typing(event.target) || help.current?.open) return;
      const move = (by: number) => {
        if (!order.length) return;
        const at = order.findIndex((view) => view.id === selected?.id);
        setPicked(order[(at + by + order.length) % order.length]!.id);
      };
      const jump = (forward: boolean) => {
        const next = forward ? world.beacons.find((beacon) => beacon.tick > tick) : lastOf(world.beacons, (beacon) => beacon.tick < tick);
        if (next) seek(next.tick);
      };
      const layout = /^[1-7]$/.test(event.key) ? LAYOUTS[Number(event.key) - 1] : undefined;
      if (layout) { location.hash = `#/layouts/${layout.id}`; return; }
      switch (event.key) {
        case "j": move(1); break;
        case "k": move(-1); break;
        // Two deliberate keys to approve: `a` brings you to the action, Enter presses it. Never one stray keystroke.
        case "a":
          if (!needs) return;
          setPicked(needs.id);
          requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-primary]")?.focus());
          break;
        case "i": if (selected) setHood((open) => !open); break;
        case "g": setGrid((on) => !on); break;
        case "?": help.current?.showModal(); break;
        case "[": seek(tick - 1); break;
        case "]": seek(tick + 1); break;
        case "{": jump(false); break;
        case "}": jump(true); break;
        case " ": if (native(event.target)) return; setPlaying((on) => !on); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, needs, hood, tick, world, seek]);

  // Closing the hood hands focus back to the control that opened it.
  const hoodWas = useRef(hood);
  useEffect(() => {
    if (hoodWas.current && !hood) document.querySelector<HTMLElement>("[data-open-hood]")?.focus();
    hoodWas.current = hood;
  }, [hood]);

  const props: LayoutProps = {
    world, selected, needs, moreNeeds: Math.max(0, waiting.length - 1), steps, now: timeline ? nowLine(timeline, tick) : null,
    narrow, row, meter, select, act, revise, drop, inspect: () => setHood(true),
  };
  const layout = page.kind === "layout" ? LAYOUTS.find((entry) => entry.id === page.id)! : null;
  const View = layout?.view;

  return (
    <div className="lab" data-page={page.kind} data-chrome={chrome || undefined}>
      {chrome && (
        <header className="lab-bar">
          <a className="lab-brand" href="#/layouts/h"><b>Ephyra</b><span>design lab</span></a>
          <nav aria-label="Lab">
            {LAYOUTS.map((entry, i) => (
              <a key={entry.id} href={`#/layouts/${entry.id}`} aria-current={page.kind === "layout" && page.id === entry.id ? "page" : undefined}
                title={entry.idea}>
                <kbd aria-hidden="true">{i + 1}</kbd>{entry.name}
              </a>
            ))}
            <span aria-hidden="true" />
            {BENCHES.map((id) => (
              <a key={id} href={`#/${id}`} aria-current={page.kind === id ? "page" : undefined}>{id[0]!.toUpperCase() + id.slice(1)}</a>
            ))}
          </nav>
          <div className="lab-toggles">
            <button type="button" className="lp-quiet" aria-pressed={theme === "dark"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              Dark
            </button>
            <button type="button" className="lp-quiet" aria-pressed={calm} onClick={() => setCalm(!calm)}>Calm</button>
            <button type="button" className="lp-quiet" aria-pressed={grid} onClick={() => setGrid(!grid)}>Edges</button>
            <button type="button" className="lp-quiet" onClick={() => help.current?.showModal()}>Keys<kbd aria-hidden="true">?</kbd></button>
          </div>
        </header>
      )}

      <main className="lab-stage" ref={aside}>
        {layout && chrome && <p className="lab-idea"><b>{layout.name}.</b> {layout.idea}</p>}
        {View && <View {...props} />}
        {page.kind === "components" && <ComponentBench world={world} />}
        {page.kind === "alignment" && <AlignmentLab world={world} />}
        {page.kind === "motion" && <MotionBench />}
      </main>

      <footer className="lab-transport">
        <Transport tick={tick} last={LAST_TICK} label={world.at.slice(11, 16)} playing={playing} beacons={world.beacons}
          onTick={seek} onPlay={setPlaying} />
        <p className="lab-sim">
          <span data-sim-label>Simulated quests. No agent ran.</span>
          {moment && <span className="lab-moment">{moment.short}: {moment.text}</span>}
          {injected.length > 0 && (
            <button type="button" className="lp-quiet" onClick={() => { setInjected([]); setToast("Your decisions were cleared."); }}>
              Undo my {injected.length === 1 ? "decision" : `${injected.length} decisions`}
            </button>
          )}
        </p>
      </footer>

      {hood && selected && timeline && (
        <Inspector tab={tab} onTab={setTab} onClose={() => setHood(false)}
          note="Simulated quest. The events and effects come from the real state machine; no agent ran and nothing landed."
          hood={{
            view: selected.view, events: selected.events, effects: selected.effects, runs: selected.runs,
            runEvents: (runId) => runEventsAt(timeline, runId, tick),
          }} />
      )}

      {rails.length > 0 && (
        <div className="lab-rails" aria-hidden="true" data-rails={rails.length}>
          {rails.map((x) => <i key={x} style={{ "--x": `${x}px` } as CSSProperties} />)}
          <b>{rails.length} left edges</b>
        </div>
      )}

      <div className="lab-toast" role="status" aria-live="polite" data-toast>{toast}</div>

      <dialog className="lab-help" ref={help} aria-labelledby="lab-help-title">
        <h2 id="lab-help-title">Keys</h2>
        <dl>{KEYS.map(([key, what]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>)}</dl>
        <form method="dialog"><button type="submit" className="lp-quiet">Close<kbd aria-hidden="true">esc</kbd></button></form>
      </dialog>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Lab /></StrictMode>);
