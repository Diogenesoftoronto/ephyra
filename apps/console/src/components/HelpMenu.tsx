import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PageId } from "../app/route.ts";
import { HELP, dismissTip, dismissedTips, docsUrl, nextTip, setTipsOff, tipsOff } from "../lib/help.ts";
import "./HelpMenu.css";

/** Tips and the help menu share one piece of browser state; this keeps every mounted copy in step. */
const CHANGED = "ephyra:tips";
const changed = () => window.dispatchEvent(new Event(CHANGED));
function useTips() {
  const [state, setState] = useState(() => ({ dismissed: dismissedTips(), off: tipsOff() }));
  useEffect(() => {
    const read = () => setState({ dismissed: dismissedTips(), off: tipsOff() });
    window.addEventListener(CHANGED, read);
    return () => window.removeEventListener(CHANGED, read);
  }, []);
  return state;
}

/** Help for the screen you are on: what it is for, what is worth knowing, where to read more, and a brief for an agent. */
export function HelpMenu({ page, brief }: { page: PageId; brief: () => string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "manual">("idle");
  const { off } = useTips();
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The panel is drawn on the page, not inside the bar: the bar is its own stacking context and later content would cover it.
  const [place, setPlace] = useState<{ top: number; right: number; theme?: string }>({ top: 0, right: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = trigger.current?.getBoundingClientRect();
      const theme = trigger.current?.closest<HTMLElement>("[data-theme]")?.dataset.theme;
      if (box) setPlace({ top: box.bottom + window.scrollY + 8, right: document.documentElement.clientWidth - box.right, ...(theme ? { theme } : {}) });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const help = HELP[page];

  useEffect(() => {
    if (!open) return;
    heading.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  useEffect(() => { setOpen(false); setCopied("idle"); }, [page]);
  useEffect(() => { if (copied === "manual") text.current?.select(); }, [copied]);

  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(brief());
      setCopied("done");
    } catch {
      // Say what happened: the brief is shown, selected, for the person to copy themselves.
      setCopied("manual");
    }
  };

  return (
    <div className="help-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="help-menu__trigger"
        aria-label="Help"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => { setOpen((value) => !value); setCopied("idle"); }}
      >
        <span aria-hidden="true">?</span>
        <span>Help</span>
      </button>
      {open && createPortal(
        <div className="help-menu__panel" id={`${id}-panel`} ref={panel} role="dialog" aria-labelledby={`${id}-title`}
          data-theme={place.theme} style={{ top: place.top, right: place.right }}>
          <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{help.title}</h2>
          <p className="help-menu__about">{help.about}</p>
          <ul className="help-menu__tips">
            {help.tips.map((tip) => (
              <li key={tip.id}>
                {tip.text}{" "}
                {tip.docs && <a href={docsUrl(tip.docs)} target="_blank" rel="noopener">Read more</a>}
              </li>
            ))}
          </ul>
          <div className="help-menu__links">
            <a href={docsUrl(help.docs)} target="_blank" rel="noopener">The guide to this screen ↗</a>
            <a href={docsUrl("troubleshooting")} target="_blank" rel="noopener">Something is stuck ↗</a>
            <a href={docsUrl("index")} target="_blank" rel="noopener">All documentation ↗</a>
          </div>
          <div className="help-menu__agent">
            <p><strong>Working with a coding agent?</strong> Copy a brief with this workspace's details. It contains no credential.</p>
            <button type="button" className="ui-button ui-button--primary" onClick={copy}>
              {copied === "done" ? "Copied. Paste it into your agent" : "Copy a brief for your agent"}
            </button>
            {copied === "manual" && (
              <>
                <p className="help-menu__manual" role="status">Clipboard access is unavailable. The brief is selected below; copy it yourself.</p>
                <textarea ref={text} readOnly rows={6} value={brief()} aria-label="Brief for your agent" />
              </>
            )}
            <span className="help-menu__status" role="status" aria-live="polite">{copied === "done" ? "The brief was copied to the clipboard." : ""}</span>
          </div>
          <p className="help-menu__foot">
            <span>Press <kbd>?</kbd> for keyboard shortcuts.</span>
            <button type="button" className="help-menu__toggle" onClick={() => { setTipsOff(!off); changed(); }} aria-pressed={!off}>
              {off ? "Show tips" : "Hide tips"}
            </button>
          </p>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** One optional tip per page visit, outside the reading flow. Every tip also stays available in Help. */
export function PageTip({ page }: { page: PageId }) {
  const { dismissed, off } = useTips();
  return off ? null : <TipToast key={page} page={page} dismissed={dismissed} />;
}

function TipToast({ page, dismissed }: { page: PageId; dismissed: string[] }) {
  // Bind this visit to one tip: dismissing it must not immediately queue another toast.
  const [tip] = useState(() => nextTip(page, dismissed, false));
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 1200);
    const visibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const dismiss = () => {
    setVisible(false);
    if (tip) { dismissTip(tip.id); changed(); }
  };
  useEffect(() => {
    if (!tip || !visible || hovered || focused || hidden) return;
    const timer = window.setTimeout(() => {
      setVisible(false);
      dismissTip(tip.id);
      changed();
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [tip, visible, hovered, focused, hidden]);
  if (!tip || !visible || dismissed.includes(tip.id)) return null;
  return (
    <aside className="page-tip" aria-label="Tip" data-paused={hovered ? "hover" : focused ? "focus" : hidden ? "hidden" : undefined}
      onMouseEnter={() => { if (window.matchMedia("(hover: hover)").matches) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span className="page-tip__label">Tip</span>
      <span className="page-tip__text" role="status">
        {tip.text}{" "}
        {tip.docs && <a href={docsUrl(tip.docs)} target="_blank" rel="noopener">Read more</a>}
      </span>
      <button type="button" className="page-tip__dismiss" aria-label="Dismiss tip" onClick={dismiss}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </aside>
  );
}
