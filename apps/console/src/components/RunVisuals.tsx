import type { AgentRun, AgentRunEvent, RunVisual } from "@ephyra/core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Card, Empty } from "../kit.ts";
import { runPresentations, visualDocument, type SavedVisual } from "../lib/run-presentations.ts";
import "./RunVisuals.css";

function VisualFrame({ visual }: { visual: RunVisual }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDialogElement>(null);
  const expand = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [height, setHeight] = useState(visual.height);
  const [expanded, setExpanded] = useState(false);
  const source = useMemo(() => visualDocument(visual.html), [visual.html]);
  const toggle = () => {
    const dialog = stage.current;
    if (!dialog) return;
    dialog.close();
    if (dialog.matches(":modal") || expanded) { dialog.show(); setExpanded(false); expand.current?.focus(); }
    else { dialog.showModal(); setExpanded(true); }
  };
  function sendTheme() {
    const style = getComputedStyle(document.documentElement);
    const names = { background: "bg", foreground: "ink", card: "surface", border: "line", accent: "jelly-deep",
      "muted-foreground": "muted", "font-sans": "font-body", "font-mono": "font-mono" };
    const variables = Object.fromEntries(Object.entries(names).map(([to, from]) => [`--${to}`, style.getPropertyValue(`--${from}`)]));
    const scheme = document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    frame.current?.contentWindow?.postMessage({ type: "ephyra:visual-theme", variables, scheme }, "*");
  }
  useEffect(() => {
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", sendTheme);
    return () => { observer.disconnect(); media.removeEventListener("change", sendTheme); };
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== "object") return;
      if (event.data.type === "ephyra:visual-size" && Number.isFinite(event.data.height)) {
        setHeight(Math.min(1200, Math.max(160, Math.ceil(event.data.height))));
      }
      if (event.data.type === "ephyra:visual-escape" && expanded) toggle();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [expanded]);
  return <dialog open ref={stage} className={`run-visual-stage${expanded ? " run-visual-stage--expanded" : ""}`}
    aria-labelledby={id} onCancel={(event) => { event.preventDefault(); if (expanded) toggle(); }}>
    <header><strong id={id}>{visual.title}</strong>
      <button ref={expand} type="button" className="ui-button ui-button--ghost ui-button--sm" onClick={toggle}>
        {expanded ? "Close expanded view" : "Expand visual"}
      </button>
    </header>
    <iframe ref={frame} title={visual.title} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer"
      style={expanded ? undefined : { height }} onLoad={sendTheme} />
  </dialog>;
}

function VisualDeck({ entries }: { entries: SavedVisual[] }) {
  const [selected, setSelected] = useState(entries[0]!);
  const latest = entries.find((entry) => entry.visual.id === selected.visual.id);
  return <div className="run-visual-deck">
    {entries.length > 1 && <div className="run-visual-picker" role="group" aria-label="Agent visuals">
      {entries.map((entry) => <button key={entry.visual.id} type="button" aria-pressed={selected.visual.id === entry.visual.id}
        onClick={() => setSelected(entry)}>{entry.visual.title}</button>)}
    </div>}
    {latest && latest.seq !== selected.seq && <p className="run-visual-update" role="status">
      The agent shared a newer version. <Button size="sm" onClick={() => setSelected(latest)}>Load update</Button>
    </p>}
    <VisualFrame key={`${selected.visual.id}:${selected.seq}`} visual={selected.visual} />
    <p className="run-visual-note">Shared by the agent · {new Date(selected.at).toLocaleString()} · Presentation, not proof.</p>
  </div>;
}

/** Saved pages remain inspectable when a runner stops; portal availability remains external. */
export function RunVisuals({ run, events }: { run: AgentRun; events: readonly AgentRunEvent[] }) {
  const { visuals, portals } = useMemo(() => runPresentations(run, events), [run, events]);
  return <Card title="From the agent" tone="quiet" className="run-presentations" meta={`${visuals.length} saved`}>
    {visuals.length ? <VisualDeck key={run.id} entries={visuals} />
      : <Empty title="Nothing shared yet" body="Interactive pages and visual explanations appear here when the agent shares them." />}
    {portals.length > 0 && <section className="run-portals" aria-label="App previews">
      <h3>App previews</h3>
      <p className="run-visual-note">Opens the app running with the agent. It may need your Amp sign-in or a running sandbox.</p>
      {portals.map((url, i) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">
        Open app preview{portals.length > 1 ? ` ${i + 1}` : ""} ↗ <span>{new URL(url).host}{new URL(url).pathname}</span>
      </a>)}
    </section>}
  </Card>;
}
