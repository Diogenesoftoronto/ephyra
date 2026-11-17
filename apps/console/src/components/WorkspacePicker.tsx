import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { haptic, sheetShouldClose } from "../lib/gesture.ts";
import { useMediaQuery } from "../lib/hooks.ts";
import type { WorkspaceAccess } from "@ephyra/core";
import { RepositoryMark } from "./RepositoryMark.tsx";
import "./WorkspacePicker.css";

export function WorkspacePicker({ workspaces, selected, onChoose }: {
  workspaces: WorkspaceAccess[]; selected: string; onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const current = workspaces.find(item => item.workspaceId === selected);
  /** On a phone the menu is a bottom sheet within thumb reach; drag it down or tap outside to close. */
  const sheet = useMediaQuery("(max-width: 560px) and (pointer: coarse)");
  const reduced = useReducedMotion();
  const spring = reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 520, damping: 40 };
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="workspace-switch" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={trigger} className="workspace-switch__trigger" type="button" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`Workspace: ${current?.name ?? "Choose workspace"}`}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      {current && <RepositoryMark key={current.workspaceId} name={current.name} sources={current.logoSources} />}
      <span className="workspace-switch__label">{current?.name ?? "Choose workspace"}</span><span aria-hidden="true">⌄</span>
    </button>
    <AnimatePresence>
    {open && sheet && <motion.div key="scrim" className="workspace-switch__scrim" aria-hidden="true"
      onPointerDown={() => { setOpen(false); trigger.current?.focus(); }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.18 }} />}
    {open && <motion.div ref={menu} id={id} role="menu" aria-label="Switch workspace" key="menu"
      className={sheet ? "workspace-switch__menu workspace-switch__menu--sheet" : "workspace-switch__menu"}
      initial={sheet ? { y: "100%" } : { opacity: 0, y: -4, scale: 0.98 }}
      animate={sheet ? { y: 0 } : { opacity: 1, y: 0, scale: 1 }}
      exit={sheet ? { y: "100%" } : { opacity: 0, y: -4, scale: 0.98 }}
      transition={sheet ? spring : { duration: reduced ? 0 : 0.14 }}
      drag={sheet ? "y" : false}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.05, bottom: 0.9 }}
      onDragEnd={(_, info) => {
        if (sheetShouldClose(info.offset.y, info.velocity.y)) { haptic(6); setOpen(false); trigger.current?.focus(); }
      }}
      onKeyDown={event => {
        const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {sheet && <span className="workspace-switch__grip" aria-hidden="true" />}
      {workspaces.map(item => <button key={item.workspaceId} type="button" role="menuitemradio"
        aria-checked={item.workspaceId === selected} onClick={() => {
          setOpen(false); trigger.current?.focus();
          if (item.workspaceId !== selected) { haptic(8); onChoose(item.workspaceId); }
        }}>
        <RepositoryMark name={item.name} sources={item.logoSources} />
        <span className="workspace-switch__name">{item.name}</span>
        <small>{item.role === "owner" ? "Owner" : item.role === "approver" ? "Approver" : "Viewer"}</small>
        <span aria-hidden="true">{item.workspaceId === selected ? "✓" : ""}</span>
      </button>)}
    </motion.div>}
    </AnimatePresence>
  </div>;
}
