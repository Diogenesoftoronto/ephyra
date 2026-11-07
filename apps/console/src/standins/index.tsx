// TEMPORARY stand-ins for the primitives that `lane/console-style` is building in src/ui. Same names and props.
// Throwaway: they use the existing theme tokens and are deleted when src/ui lands (see src/kit.ts).
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PersonaId } from "@ephyra/core";
import "./standins.css";

type Cls = { className?: string };
const cx = (...c: Array<string | false | undefined>) => c.filter(Boolean).join(" ");

export type NavItem = { id: string; label: string; icon?: ReactNode; count?: number };
export function Shell({ nav, current, onNavigate, user, children, className }: {
  nav: NavItem[]; current: string; onNavigate: (id: string) => void; user?: ReactNode; children: ReactNode } & Cls) {
  return (
    <div className={cx("ui-shell", className)}>
      <header className="ui-shell-top"><strong className="ui-shell-logo">Ephyra</strong>{user && <span className="ui-shell-user">{user}</span>}</header>
      <nav className="ui-shell-nav" aria-label="Main">
        {nav.map((n) => (
          <a key={n.id} href={`#/${n.id}`} aria-current={n.id === current ? "page" : undefined}
            onClick={(e) => { e.preventDefault(); onNavigate(n.id); }}>
            {n.icon}<span>{n.label}</span>{n.count ? <b className="ui-shell-count">{n.count}</b> : null}
          </a>
        ))}
      </nav>
      <main className="ui-shell-main">{children}</main>
    </div>
  );
}

export function PageHeader({ title, lede, actions, className }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode } & Cls) {
  return (
    <div className={cx("ui-pageheader", className)}>
      <div><h1>{title}</h1>{lede && <p className="muted">{lede}</p>}</div>
      {actions && <div className="ui-pageheader-actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, meta, actions, tone = "plain", children, className }: {
  title?: ReactNode; meta?: ReactNode; actions?: ReactNode; tone?: "plain" | "inset" | "live" | "alert"; children?: ReactNode } & Cls) {
  return (
    <section className={cx("ui-card", `ui-card-${tone}`, className)}>
      {(title || meta || actions) && (
        <header className="ui-card-head">
          <div>{title && <h2>{title}</h2>}{meta && <div className="muted ui-card-meta">{meta}</div>}</div>
          {actions && <div className="ui-card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, unknownCount, tone, className }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; unknownCount?: number; tone?: "ok" | "warn" | "bad" } & Cls) {
  return (
    <div className={cx("ui-stat", tone && `ui-stat-${tone}`, className)}>
      <div className="ui-stat-label">{label}</div>
      <div className="ui-stat-value num">{value}</div>
      {unknownCount ? <div className="ui-stat-sub"><Badge tone="warn">{unknownCount} unknown</Badge></div> : null}
      {sub && <div className="ui-stat-sub muted">{sub}</div>}
    </div>
  );
}

export type BadgeTone = "neutral" | "ok" | "warn" | "bad" | "info" | "live";
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode } & Cls) {
  return <span className={cx("ui-badge", `ui-badge-${tone}`, className)}>{children}</span>;
}

export function PersonaTag({ persona, children, className }: { persona: PersonaId; children?: ReactNode } & Cls) {
  return <span className={cx("ui-persona-tag", className)} style={{ "--p": `var(--persona-${persona})`, "--pt": `var(--persona-${persona}-tint)` } as never}>
    {children ?? persona}</span>;
}

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: {
  variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md"; loading?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx("ui-btn", `ui-btn-${variant}`, `ui-btn-${size}`, className)}>
      {loading ? <span className="ui-spinner" aria-hidden /> : null}{children}
    </button>
  );
}

export function Avatar({ src, video, initial, color, size = 48, live, className }: {
  src?: string; video?: string | string[]; initial: string; color: string; size?: 24 | 32 | 48 | 96; live?: boolean } & Cls) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const videos = typeof video === "string" ? [video] : video ?? [];
  return (
    <span className={cx("ui-avatar", live && "ui-avatar-live", className)} style={{ width: size, height: size, "--c": color } as never}>
      {src && !broken ? <img src={src} alt="" width={size} height={size} onError={() => setBroken(true)} /> : <b aria-hidden>{initial}</b>}
      {videos.length > 0 && !broken && (
        <video autoPlay loop muted playsInline aria-hidden onError={() => setBroken(true)}>
          {videos.map((v) => <source key={v} src={v} />)}
        </video>
      )}
    </span>
  );
}

export function Meter({ used, max, unknown, label, className }: { used: number; max: number; unknown?: number; label: string } & Cls) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className={cx("ui-meter", pct >= 90 && "ui-meter-hot", className)}>
      <div className="ui-meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(used, max)}>
        <i style={{ width: `${pct}%` }} />
      </div>
      {unknown ? <span className="ui-meter-unknown muted">+ {unknown} unknown</span> : null}
    </div>
  );
}

export function Hash({ value, chars = 8, className }: { value: string; chars?: number } & Cls) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, () => undefined);
  };
  return (
    <span className={cx("ui-hash mono", className)}>
      <span title={value}>{value.replace(/^sha256:/, "").slice(0, chars)}</span>
      <button type="button" className="ui-hash-copy" onClick={copy} aria-label={`Copy ${value.slice(0, chars)}`}>{copied ? "copied" : "copy"}</button>
    </span>
  );
}

export function Segmented({ options, value, onChange, label, className }: {
  options: Array<{ id: string; label: string; hint?: string }>; value: string; onChange: (id: string) => void; label: string } & Cls) {
  return (
    <div className={cx("ui-segmented", className)} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={o.id === value} title={o.hint} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode } & Cls) {
  return (
    <label className={cx("ui-field", !!error && "ui-field-error", className)}>
      <span className="ui-field-label">{label}</span>
      {children}
      {hint && <span className="ui-field-hint muted">{hint}</span>}
      {error && <span className="ui-field-err" role="alert">{error}</span>}
    </label>
  );
}

export function Table({ className, children, label }: { children: ReactNode; label: string } & Cls) {
  return <div className="ui-table-wrap" role="region" aria-label={label} tabIndex={0}><table className={cx("ui-table", className)}>{children}</table></div>;
}

export function Empty({ title, body, action, className }: { title: ReactNode; body?: ReactNode; action?: ReactNode } & Cls) {
  return <div className={cx("ui-empty", className)}><h3>{title}</h3>{body && <p className="muted">{body}</p>}{action}</div>;
}

export function Skeleton({ lines = 3, block, className }: { lines?: number; block?: boolean } & Cls) {
  return (
    <div className={cx("ui-skeleton", className)} role="status" aria-label="Loading">
      {block ? <i className="ui-skel-block" /> : Array.from({ length: lines }, (_, i) => <i key={i} style={{ width: `${92 - ((i * 17) % 40)}%` }} />)}
    </div>
  );
}

export function Tag({ children, className }: { children: ReactNode } & Cls) {
  return <span className={cx("ui-tag", className)}>{children}</span>;
}
