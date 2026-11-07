import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../ui/icons.tsx";
import "./CommandMenu.css";

export const COMMANDS = [
  { id: "overview", label: "Go to overview", key: "o", detail: "Workspace activity and next steps" },
  { id: "inbox", label: "Open inbox", key: "i", detail: "Trails waiting for your review" },
  { id: "runs", label: "Open runs", key: "r", detail: "Agent work and execution records" },
  { id: "usage", label: "View usage", key: "u", detail: "Model requests, tokens and recorded costs" },
  { id: "workspace", label: "Open workspace", key: "w", detail: "Draft autonomy and other documents" },
  { id: "personas", label: "Meet the agents", key: "p", detail: "Roles and responsibilities" },
  { id: "settings", label: "Open settings", key: "s", detail: "Repository, model access and account" },
] as const;

export function searchCommands(query: string) {
  const needle = query.trim().toLowerCase();
  const byName = COMMANDS.filter((command) => `${command.id} ${command.label}`.toLowerCase().includes(needle));
  const byDescription = COMMANDS.filter((command) =>
    !byName.includes(command) && command.detail.toLowerCase().includes(needle));
  return [...byName, ...byDescription];
}

export function typingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]",
      ),
    )
  );
}

/** One command registry drives both discoverable controls and safe, navigation-only shortcuts. */
export function CommandMenu({
  onNavigate = (id) => {
    location.hash = `#/${id}`;
  },
}: {
  onNavigate?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [theme, setTheme] = useState<string | undefined>();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const prefix = useRef(0);
  const id = useId();
  const matches = searchCommands(query);
  const show = () => {
    restore.current = document.activeElement as HTMLElement;
    setTheme(restore.current?.closest<HTMLElement>("[data-theme]")?.dataset.theme);
    setQuery("");
    setActive(0);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    restore.current?.focus();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        if (document.querySelector("dialog[open]") && !open) return;
        event.preventDefault();
        open ? close() : show();
        return;
      }
      if (
        open ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        typingTarget(event.target) ||
        document.querySelector("dialog[open]")
      ) {
        prefix.current = 0;
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        show();
        return;
      }
      if (Date.now() - prefix.current < 900) {
        prefix.current = 0;
        const command = COMMANDS.find((c) => c.key === event.key.toLowerCase());
        if (command) {
          event.preventDefault();
          onNavigate(command.id);
          return;
        }
      }
      prefix.current = event.key.toLowerCase() === "g" ? Date.now() : 0;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onNavigate]);
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      input.current?.focus();
    } else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);
  const choose = (index: number) => {
    const command = matches[index];
    if (command) {
      close();
      onNavigate(command.id);
    }
  };
  return (
    <>
      <button
        className="command-trigger"
        type="button"
        onClick={show}
        aria-haspopup="dialog"
        aria-label="Open commands and keyboard shortcuts"
        aria-keyshortcuts="Control+k Meta+k"
      >
        <span aria-hidden="true">⌕</span>
        <span>Commands</span>
        <kbd>⌘ / Ctrl K</kbd>
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          data-theme={theme}
          className="command-menu"
          aria-labelledby={`${id}-title`}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              const r = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < r.left ||
                event.clientX > r.right ||
                event.clientY < r.top ||
                event.clientY > r.bottom
              )
                close();
            }
          }}
        >
          <div className="command-menu__head">
            <h2 id={`${id}-title`}>Where would you like to go?</h2>
            <button type="button" className="command-close" onClick={close} aria-label="Close commands">
              Esc
            </button>
          </div>
          <input
            ref={input}
            role="combobox"
            aria-label="Find a page or command"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={matches[active] ? `${id}-${active}` : undefined}
            autoComplete="off"
            placeholder="Search pages, settings, usage…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActive((a) => Math.max(0, Math.min(matches.length - 1, a + (event.key === "ArrowDown" ? 1 : -1))));
              }
              if (event.key === "Home" || event.key === "End") {
                event.preventDefault();
                setActive(event.key === "Home" ? 0 : Math.max(0, matches.length - 1));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                choose(active);
              }
            }}
          />
          <ul id={`${id}-list`} role="listbox" aria-label="Commands">
            {matches.map((command, index) => (
              <li
                id={`${id}-${index}`}
                key={command.id}
                role="option"
                aria-selected={index === active}
                onPointerMove={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <Icon name={command.id} />
                <span>
                  <b>{command.label}</b>
                  <small>{command.detail}</small>
                </span>
                <kbd>G {command.key.toUpperCase()}</kbd>
              </li>
            ))}
            {!matches.length && (
              <li className="command-empty" role="presentation">
                No matching command. Try “settings” or “workspace”.
              </li>
            )}
          </ul>
          <footer>
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> Move <kbd>↵</kbd> Open
            </span>
            <span>
              <kbd>?</kbd> Shortcuts, outside an editor
            </span>
          </footer>
        </dialog>,
        document.body,
      )}
    </>
  );
}
