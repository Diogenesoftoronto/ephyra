import { useEffect, useId, useRef, useState } from "react";
import type { WorkspaceAccess } from "@ephyra/core";
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
      <span>{current?.name ?? "Choose workspace"}</span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div ref={menu} id={id} role="menu" aria-label="Switch workspace" className="workspace-switch__menu"
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
      {workspaces.map(item => <button key={item.workspaceId} type="button" role="menuitemradio"
        aria-checked={item.workspaceId === selected} onClick={() => {
          setOpen(false); trigger.current?.focus();
          if (item.workspaceId !== selected) onChoose(item.workspaceId);
        }}>
        <span className="workspace-switch__name">{item.name}</span>
        <small>{item.role === "owner" ? "Owner" : item.role === "approver" ? "Approver" : "Viewer"}</small>
        <span aria-hidden="true">{item.workspaceId === selected ? "✓" : ""}</span>
      </button>)}
    </div>}
  </div>;
}
