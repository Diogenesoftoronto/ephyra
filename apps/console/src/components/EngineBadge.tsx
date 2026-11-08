import type { AgentRun } from "@ephyra/core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { engineBrand } from "../lib/engine-brand.ts";
import { EXECUTOR_LABEL } from "./ExecutorChip.tsx";
import "./EngineBadge.css";

/** Agent identity at a glance; exact recorded execution details on hover, focus, or tap. */
export function EngineBadge({ engine, executor }: { engine?: string | null; executor?: AgentRun["executor"] }) {
  const brand = engineBrand(engine);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const name = brand?.name ?? (engine ? "Recorded engine" : "Engine not reported");
  const details = [
    { label: "Engine", value: engine || "Not reported" },
    ...(executor ? [
      { label: "Execution", value: EXECUTOR_LABEL[executor.kind] },
      { label: "Runner ID", value: executor.id || "Not reported" },
      ...(executor.project ? [{ label: "Project", value: executor.project }] : []),
    ] : []),
  ];

  function show() { clearTimeout(timer.current); setOpen(true); }
  function leave() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!hovered.current && document.activeElement !== trigger.current) setOpen(false);
    }, 140);
  }

  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!trigger.current || !tooltip.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const tip = tooltip.current.getBoundingClientRect();
      if (anchor.bottom < 0 || anchor.top > innerHeight) { setOpen(false); return; }
      setPosition({
        left: Math.max(8, Math.min(anchor.left + anchor.width / 2 - tip.width / 2, innerWidth - tip.width - 8)),
        top: anchor.bottom + tip.height + 8 <= innerHeight ? anchor.bottom + 8 : Math.max(8, anchor.top - tip.height - 8),
      });
    }
    function dismiss(event: Event) {
      if (!(event.target instanceof Node)) return;
      if (!trigger.current?.contains(event.target) && !tooltip.current?.contains(event.target)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", dismiss);
    document.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", dismiss);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open, engine, executor]);

  return <>
    <button type="button" className="engine-badge" ref={trigger}
      data-brand={brand?.id ?? "unknown"} aria-label={`${name}: show engine and runner details`}
      aria-describedby={open ? id : undefined} onFocus={show} onBlur={leave} onClick={show}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") { hovered.current = true; show(); } }}
      onPointerLeave={() => { hovered.current = false; leave(); }}>
      {brand && failedImage !== brand.id ? (
        <img src={`/app/engines/${brand.id}.svg`} alt="" width={24} height={24}
          onError={() => setFailedImage(brand.id)} draggable={false} />
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
          strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="4" /><path d="m7 9 3 3-3 3m6 0h4" />
        </svg>
      )}
    </button>
    {open && createPortal(
      <div className="engine-tooltip" role="tooltip" id={id} ref={tooltip} style={position}
        onPointerEnter={() => { hovered.current = true; clearTimeout(timer.current); }}
        onPointerLeave={() => { hovered.current = false; leave(); }}>
        <strong>{name}</strong>
        <dl>{details.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </div>, document.body,
    )}
  </>;
}
