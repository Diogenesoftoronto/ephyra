// Visual primitives. Pages compose these and add layout only; no page defines colours, radii, shadows or type sizes.
import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import type { PersonaId } from "@ephyra/core";
import { Icon, type IconName } from "./icons.tsx";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
const personaStyle = (p: PersonaId): CSSProperties => ({ ["--persona-color" as string]: `var(--persona-${p})` });

// ── Shell ──
export type NavItem = { id: string; label: string; icon?: IconName; count?: number };
export function Shell({ nav, current, onNavigate, user, children, className }: {
  nav: NavItem[]; current: string; onNavigate: (id: string) => void; user?: { name: string; detail?: string; avatar?: ReactNode };
  children: ReactNode; className?: string;
}) {
  return (
    <div className={cx("ui-shell", className)}>
      <aside className="ui-rail">
        <a className="ui-brand" href="/app/"><img src={`${import.meta.env?.BASE_URL ?? "/app/"}brand/logo.svg`} alt="" /><b>Ephyra</b></a>
        <nav className="ui-nav" aria-label="Console">
          {nav.map((n) => (
            <button key={n.id} type="button" aria-current={n.id === current ? "page" : undefined} onClick={() => onNavigate(n.id)}>
              {n.icon && <Icon name={n.icon} />}<span>{n.label}</span>
              {n.count ? <span className="count" aria-label={`${n.count} waiting`}>{n.count}</span> : null}
            </button>
          ))}
        </nav>
        {user && <div className="ui-rail-foot">{user.avatar}<div className="who">{user.name}{user.detail && <span>{user.detail}</span>}</div></div>}
      </aside>
      <main className="ui-main">{children}</main>
    </div>
  );
}

export function PageHeader({ title, lede, actions, className }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cx("ui-page-header", className)}>
      <div><h1>{title}</h1>{lede && <p>{lede}</p>}</div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("ui-tag", className)}>{children}</span>;
}

// ── Card ──
export function Card({ title, meta, actions, tone = "plain", persona, children, className, as: As = "section" }: {
  title?: ReactNode; meta?: ReactNode; actions?: ReactNode; tone?: "plain" | "inset" | "live" | "alert"; persona?: PersonaId;
  children?: ReactNode; className?: string; as?: "section" | "article" | "div";
}) {
  return (
    <As className={cx("ui-card", tone !== "plain" && `ui-card--${tone}`, className)} data-persona={persona}
      style={persona ? personaStyle(persona) : undefined}>
      {(title || meta || actions) && (
        <header>{title && <h2>{title}</h2>}{meta && <span className="meta">{meta}</span>}{actions && <div className="actions">{actions}</div>}</header>
      )}
      {children}
    </As>
  );
}

// ── Stat ──
export function Stat({ label, value, sub, unknownCount, tone, className }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; unknownCount?: number; tone?: "live" | "bad"; className?: string;
}) {
  return (
    <div className={cx("ui-stat", tone && `ui-stat--${tone}`, className)}>
      <Tag>{label}</Tag>
      <span className="value">{value}</span>
      {unknownCount ? <span className="unknown">+ {unknownCount} with unknown cost</span> : null}
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

// ── Badge, persona tag ──
export function Badge({ tone = "neutral", children, className }: {
  tone?: "neutral" | "ok" | "warn" | "bad" | "info" | "live"; children: ReactNode; className?: string;
}) {
  return <span className={cx("ui-badge", tone !== "neutral" && `ui-badge--${tone}`, className)}>{children}</span>;
}
export function PersonaTag({ persona, children, className }: { persona: PersonaId; children?: ReactNode; className?: string }) {
  return <span className={cx("ui-persona", className)} style={personaStyle(persona)}>{children ?? persona[0]!.toUpperCase() + persona.slice(1)}</span>;
}

// ── Button ──
export function Button({ variant = "secondary", size = "md", loading, children, className, disabled, ...rest }:
  { variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx("ui-button", `ui-button--${variant}`, size === "sm" && "ui-button--sm", className)}>
      {loading && <span className="spin" aria-hidden="true" />}{children}
    </button>
  );
}

// ── Avatar ──
export function Avatar({ src, video, initial, color, size = 32, live, label, className }: {
  src?: string; video?: { webm?: string; mp4?: string }; initial: string; color: string; size?: 24 | 32 | 48 | 96;
  live?: boolean; label?: string; className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const style = { ["--size" as string]: `${size}px`, ["--persona-color" as string]: color } as CSSProperties;
  const motion = video && size >= 48 && typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <span className={cx("ui-avatar", live && "ui-avatar--live", className)} style={style} role={label ? "img" : undefined} aria-label={label}>
      {broken || !src ? <span aria-hidden="true">{initial}</span>
        : motion ? (
          <video autoPlay loop muted playsInline poster={src} onError={() => setBroken(true)}>
            {video.webm && <source src={video.webm} type="video/webm" />}{video.mp4 && <source src={video.mp4} type="video/mp4" />}
          </video>
        ) : <img src={src} alt="" onError={() => setBroken(true)} />}
    </span>
  );
}

// ── Meter ──
export function Meter({ used, max, unknown, label, format = String, className }: {
  used: number; max: number; unknown?: number; label: ReactNode; format?: (n: number) => string; className?: string;
}) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div className={cx("ui-meter", used > max && "ui-meter--over", className)}>
      <div className="row"><span>{label}</span><span className="num">{format(used)} / {format(max)}</span></div>
      <div className="track" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={used} aria-label={typeof label === "string" ? label : undefined}>
        <div className="fill" style={{ width: `${pct}%` }} />
        {unknown ? <div className="unknown" style={{ left: `${pct}%`, width: "18px" }} title={`${unknown} with unknown cost`} /> : null}
      </div>
    </div>
  );
}

// ── Hash ──
export function Hash({ value, chars = 7, className }: { value: string; chars?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => {});
  return (
    <span className={cx("ui-hash", className)} title={value}>
      {value.length > chars ? value.slice(0, chars) : value}
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy ${value}`}><Icon name={copied ? "check" : "copy"} /></button>
    </span>
  );
}

// ── Segmented ──
export function Segmented<T extends string>({ options, value, onChange, label, name, className }: {
  options: readonly { id: T; label: string; hint?: string }[]; value: T; onChange: (v: T) => void; label: ReactNode; name?: string;
  className?: string;
}) {
  const group = name ?? `seg-${String(label).replace(/\W+/g, "-").toLowerCase()}`;
  const hint = options.find((o) => o.id === value)?.hint;
  return (
    <fieldset className={cx("ui-seg", className)}>
      <legend><Tag>{label}</Tag></legend>
      <div className="track">
        {options.map((o) => (
          <label key={o.id}>
            <input type="radio" name={group} value={o.id} checked={o.id === value} onChange={() => onChange(o.id)} />
            <span className="opt">{o.label}</span>
          </label>
        ))}
      </div>
      {hint !== undefined && <p className="hint" aria-live="polite">{hint}</p>}
    </fieldset>
  );
}

// ── Field ──
export function Field({ label, hint, error, children, className }: {
  label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <label className={cx("ui-field", className)} data-invalid={error ? "" : undefined}>
      <span className="label">{label}</span>{children}
      {error ? <span className="error" role="alert">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

// ── Empty, skeleton ──
export function Empty({ title, body, action, className }: { title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string }) {
  return <div className={cx("ui-empty", className)}><Icon name="specimen" /><h3>{title}</h3>{body && <p>{body}</p>}{action}</div>;
}
export function Skeleton({ lines = 3, block, className }: { lines?: number; block?: boolean; className?: string }) {
  return (
    <div className={cx("ui-skel", block && "ui-skel--block", className)} aria-hidden="true">
      {Array.from({ length: block ? 1 : lines }, (_, i) => <i key={i} />)}
    </div>
  );
}
