// Visual primitives. Pages compose these and add layout only; no page defines colours, radii, shadows or type sizes.
import {
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { PersonaId } from "@ephyra/core";
import { Icon, type IconName } from "./icons.tsx";

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");
const personaStyle = (p: PersonaId): CSSProperties => ({
  ["--persona-color" as string]: `var(--persona-${p})`,
});

// ── Shell ──
/** `overflow: true` items move into the "More" sheet on phones, keeping the bottom bar to five. */
export type NavItem = { id: string; label: string; icon?: IconName; count?: number; overflow?: boolean };
export function Shell({
  nav,
  current,
  onNavigate,
  user,
  children,
  className,
}: {
  nav: NavItem[];
  current: string;
  onNavigate: (id: string) => void;
  user?: { name: string; detail?: string; avatar?: ReactNode };
  children: ReactNode;
  className?: string;
}) {
  const [more, setMore] = useState(false);
  const extra = nav.filter((n) => n.overflow);
  const go = (id: string) => {
    setMore(false);
    onNavigate(id);
  };
  return (
    <div className={cx("ui-shell", className)}>
      {more && extra.length > 0 && (
        <div className="ui-sheet ui-nav" role="menu" aria-label="More">
          {extra.map((n) => (
            <button
              key={n.id}
              type="button"
              role="menuitem"
              aria-current={n.id === current ? "page" : undefined}
              onClick={() => go(n.id)}
            >
              {n.icon && <Icon name={n.icon} />}
              <span>{n.label}</span>
            </button>
          ))}
        </div>
      )}
      <aside className="ui-rail">
        <a className="ui-brand" href="/app/">
          <img src={`${import.meta.env?.BASE_URL ?? "/app/"}brand/logo.svg`} alt="" />
          <b>Ephyra</b>
        </a>
        <nav className="ui-nav" aria-label="Console">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              aria-current={n.id === current ? "page" : undefined}
              onClick={() => go(n.id)}
              data-overflow={n.overflow ? "" : undefined}
            >
              {n.icon && <Icon name={n.icon} />}
              <span>{n.label}</span>
              {n.count ? (
                <span className="count" aria-label={`${n.count} waiting`}>
                  {n.count}
                </span>
              ) : null}
            </button>
          ))}
          {extra.length > 0 && (
            <button
              type="button"
              className="ui-more"
              aria-expanded={more}
              aria-current={extra.some((n) => n.id === current) ? "page" : undefined}
              onClick={() => setMore((m) => !m)}
            >
              <Icon name="more" />
              <span>More</span>
            </button>
          )}
        </nav>
        {user && (
          <div className="ui-rail-foot">
            {user.avatar}
            <div className="who">
              {user.name}
              {user.detail && <span>{user.detail}</span>}
            </div>
          </div>
        )}
      </aside>
      <main className="ui-main">{children}</main>
    </div>
  );
}

export function PageHeader({
  title,
  lede,
  actions,
  className,
}: {
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx("ui-page-header", className)}>
      <div>
        <h1>{title}</h1>
        {lede && <p>{lede}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("ui-tag", className)}>{children}</span>;
}

// ── Card ──
export function Card({
  title,
  meta,
  actions,
  tone = "plain",
  persona,
  children,
  className,
  as: As = "section",
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tone?: "plain" | "quiet" | "tray" | "inset" | "live" | "alert";
  persona?: PersonaId;
  children?: ReactNode;
  className?: string;
  as?: "section" | "article" | "div";
}) {
  return (
    <As
      className={cx("ui-card", tone !== "plain" && `ui-card--${tone}`, className)}
      style={persona ? personaStyle(persona) : undefined}
    >
      {(title || meta || actions) && (
        <header>
          {title && <h2>{title}</h2>}
          {meta && <span className="meta">{meta}</span>}
          {actions && <div className="actions">{actions}</div>}
        </header>
      )}
      {children}
    </As>
  );
}

// ── Stat ──
export function Stat({
  label,
  value,
  sub,
  unknownCount,
  tone,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  unknownCount?: number;
  tone?: "live" | "bad";
  className?: string;
}) {
  return (
    <div className={cx("ui-stat", tone && `ui-stat--${tone}`, className)}>
      <span className="ui-label">{label}</span>
      <span className="value">{value}</span>
      {unknownCount ? <span className="unknown">+ {unknownCount} with unknown cost</span> : null}
      {sub && <span className="sub">{sub}</span>}
    </div>
  );
}

// ── Badge, persona tag ──
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "ok" | "warn" | "bad" | "info";
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("ui-badge", tone !== "neutral" && `ui-badge--${tone}`, className)}>{children}</span>
  );
}
export function PersonaTag({
  persona,
  children,
  className,
}: {
  persona: PersonaId;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx("ui-persona", className)} style={personaStyle(persona)}>
      {children ?? persona[0]!.toUpperCase() + persona.slice(1)}
    </span>
  );
}

// ── Button ──
export function Button({
  variant = "secondary",
  size = "md",
  loading,
  children,
  className,
  disabled,
  ...rest
}: {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx("ui-button", `ui-button--${variant}`, size === "sm" && "ui-button--sm", className)}
    >
      {loading && <span className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

// ── Avatar ──
export function Avatar({
  src,
  video,
  initial,
  color,
  tint,
  size = 32,
  breathe,
  label,
  className,
}: {
  src?: string;
  video?: { webm?: string; mp4?: string };
  initial: string;
  color: string;
  tint?: string;
  size?: 24 | 32 | 48 | 96;
  /** Breathe the transparent still (works on any surface; the video loops are opaque, dark-surface only). */
  breathe?: boolean;
  label?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const style = {
    ["--size" as string]: `${size}px`,
    ["--persona-color" as string]: color,
    ...(tint ? { ["--persona-tint" as string]: tint } : {}),
  } as CSSProperties;
  const motion =
    video &&
    size >= 48 &&
    typeof matchMedia === "function" &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <span
      className={cx("ui-avatar", breathe && "ui-avatar--breathe", className)}
      style={style}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {broken || !src ? (
        <span aria-hidden="true">{initial}</span>
      ) : motion ? (
        <video autoPlay loop muted playsInline poster={src} onError={() => setBroken(true)}>
          {video.webm && <source src={video.webm} type="video/webm" />}
          {video.mp4 && <source src={video.mp4} type="video/mp4" />}
        </video>
      ) : (
        <img src={src} alt="" onError={() => setBroken(true)} />
      )}
    </span>
  );
}

// ── Meter ──
/** Recorded values only. Unknown costs are stated in the note, never drawn as a quantity. */
export function Meter({
  used,
  max,
  unknown,
  label,
  format = String,
  className,
}: {
  used: number;
  max: number;
  unknown?: number;
  label: ReactNode;
  format?: (n: number) => string;
  className?: string;
}) {
  const frac = max > 0 ? Math.min(1, Math.max(0, used / max)) : used > 0 ? 1 : 0;
  const percent = max > 0 ? `${Math.round((used / max) * 100)}% used` : "No spend allowed";
  return (
    <div className={cx("ui-meter", used > max && "ui-meter--over", className)}>
      <div className="row">
        <span>{label}</span>
        <span className="num">
          <b>{format(used)}</b> of {format(max)}
        </span>
      </div>
      <div
        className="track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={Math.max(1, max)}
        aria-valuenow={Math.min(used, Math.max(1, max))}
        aria-valuetext={`${format(used)} used of ${format(max)}${unknown ? "; total incomplete" : ""}`}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <div className="fill" style={{ ["--pct" as string]: frac } as CSSProperties} />
      </div>
      <span className="note">
        {unknown && max > 0 ? "At least " : ""}
        {percent}
        {used > max && (
          <>
            {" "}
            · <strong>{format(used - max)} over budget</strong>
          </>
        )}
        {unknown ? (
          <>
            {" "}
            ·{" "}
            <span className="unknown">
              {unknown} more {unknown === 1 ? "entry" : "entries"} with unknown cost
            </span>
          </>
        ) : null}
      </span>
    </div>
  );
}

// ── Hash ──
export function Hash({ value, chars = 7, className }: { value: string; chars?: number; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  return (
    <span className={cx("ui-hash", className)} title={value}>
      {value.length > chars ? value.slice(0, chars) : value}
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy ${value}`}>
        <Icon name={copied ? "check" : "copy"} />
      </button>
    </span>
  );
}

// ── Segmented ──
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  name,
  className,
}: {
  options: readonly { id: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: ReactNode;
  name?: string;
  className?: string;
}) {
  const group = name ?? `seg-${String(label).replace(/\W+/g, "-").toLowerCase()}`;
  const hint = options.find((o) => o.id === value)?.hint;
  return (
    <fieldset className={cx("ui-seg", className)}>
      <legend>
        <Tag>{label}</Tag>
      </legend>
      <div className="track">
        {options.map((o) => (
          <label key={o.id}>
            <input
              type="radio"
              name={group}
              value={o.id}
              checked={o.id === value}
              onChange={() => onChange(o.id)}
            />
            <span className="opt">{o.label}</span>
          </label>
        ))}
      </div>
      {hint !== undefined && (
        <p className="hint" aria-live="polite">
          {hint}
        </p>
      )}
    </fieldset>
  );
}

// ── Field ──
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const control =
    isValidElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>(children) &&
    (typeof children.type !== "string" || ["input", "select", "textarea"].includes(children.type))
      ? children
      : null;
  const controlId = control?.props.id ?? id;
  const descriptionId = error || hint ? `${id}-description` : undefined;
  return (
    <div
      className={cx("ui-field", className)}
      data-invalid={error ? "" : undefined}
      role={control ? undefined : "group"}
      aria-labelledby={control ? undefined : `${id}-label`}
    >
      {control ? (
        <label className="label" htmlFor={controlId}>
          {label}
        </label>
      ) : (
        <span className="label" id={`${id}-label`}>
          {label}
        </span>
      )}
      {control
        ? cloneElement(control, {
            id: controlId,
            "aria-describedby":
              [control.props["aria-describedby"], descriptionId].filter(Boolean).join(" ") || undefined,
            "aria-invalid": error ? true : control.props["aria-invalid"],
          })
        : children}
      {error ? (
        <span className="error" role="alert" id={descriptionId}>
          {error}
        </span>
      ) : hint ? (
        <span className="hint" id={descriptionId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

// ── Empty, skeleton ──
export function Empty({
  title,
  body,
  action,
  className,
}: {
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("ui-empty", className)}>
      <Icon name="specimen" />
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}
export function Skeleton({
  lines = 3,
  block,
  className,
}: {
  lines?: number;
  block?: boolean;
  className?: string;
}) {
  return (
    <div className={cx("ui-skel", block && "ui-skel--block", className)} aria-hidden="true">
      {Array.from({ length: block ? 1 : lines }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}

// ── Status ──
export function Status({
  state,
  children,
  className,
}: {
  state: "running" | "waiting" | "done" | "failed" | "stale";
  children?: ReactNode;
  className?: string;
}) {
  const text = {
    running: "Running",
    waiting: "Waiting",
    done: "Done",
    failed: "Failed",
    stale: "Updates delayed",
  }[state];
  return <span className={cx("ui-status", `ui-status--${state}`, className)}>{children ?? text}</span>;
}

// ── Checkpoint ──
const CHECKPOINT = { A: "Hypothesis", B: "Plan", C: "Landing" } as const;
/** `compact` shows only the lettered tile (use in rows, and put the step name in the row's meta). */
export function Checkpoint({
  id,
  blocking,
  label,
  compact,
  className,
}: {
  id: "A" | "B" | "C";
  blocking?: boolean;
  label?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "ui-checkpoint",
        blocking && "ui-checkpoint--blocking",
        compact && "ui-checkpoint--compact",
        className,
      )}
    >
      <i aria-hidden="true">{id}</i>
      <span>{label ?? CHECKPOINT[id]}</span>
      <span className="sr-only">{`checkpoint ${id}${blocking ? ", blocking" : ""}`}</span>
    </span>
  );
}

// ── Rows ──
export const checkpointName = (id: "A" | "B" | "C") => CHECKPOINT[id];
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("ui-rows", className)}>{children}</div>;
}
export function Row({
  lead,
  title,
  meta,
  aside,
  className,
  href,
}: {
  href?: string;
  lead?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  className?: string;
}) {
  const As = href ? "a" : "div";
  return (
    <As href={href} className={cx("ui-row", !lead && "ui-row--no-lead", className)}>
      {lead && <span className="lead">{lead}</span>}
      <span className="title">{title}</span>
      {meta && <span className="meta">{meta}</span>}
      {aside && <span className="aside">{aside}</span>}
    </As>
  );
}

// ── Notice ──
export function Notice({
  tone = "bad",
  title,
  body,
  actions,
  className,
}: {
  tone?: "bad" | "warn";
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx("ui-notice", tone === "warn" && "ui-notice--warn", className)}
      role={tone === "bad" ? "alert" : "status"}
    >
      <Icon name="undo" />
      <div>
        <div className="title">{title}</div>
        {body && <div className="body">{body}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Stats({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("ui-stats", className)}>{children}</div>;
}

// ── Bar chart ──
/** Daily bars with a labelled axis. `partial` marks the last bar as the day so far. Values are recorded amounts only. */
export function BarChart({
  data,
  format = String,
  partial,
  label,
  className,
}: {
  data: { key: string; label: string; value: number }[];
  format?: (n: number) => string;
  partial?: boolean;
  label: string;
  className?: string;
}) {
  const host = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    if (!host.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const W = width,
    H = width < 400 ? 160 : 180,
    left = 44,
    bottom = 24,
    top = 24;
  const labelEvery = Math.max(1, Math.ceil((data.length * 36) / (W - left)));
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const step = niceStep(max / 3);
  const ceil = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(ceil / step) + 1 }, (_, i) => i * step);
  const bw = (W - left) / data.length;
  const y = (v: number) => top + (H - top - bottom) * (1 - v / ceil);
  return (
    <figure ref={host} className={cx("ui-chart", className)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <g className="grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={W} y1={y(t)} y2={y(t)} />
              <text x={left - 8} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
        </g>
        {data.map((d, i) => {
          const last = i === data.length - 1;
          return (
            <g
              key={d.key}
              className={cx("bar", last && "hi", last && partial && "partial")}
              tabIndex={0}
              aria-label={`${d.label}: ${format(d.value)}`}
            >
              <rect
                x={left + i * bw + bw * 0.2}
                y={y(d.value)}
                width={bw * 0.6}
                height={Math.max(0, y(0) - y(d.value))}
                rx={3}
              />
              <text x={left + i * bw + bw / 2} y={y(d.value) - 6} textAnchor="middle">
                {format(d.value)}
              </text>
            </g>
          );
        })}
        <g className="days">
          {data.map(
            (d, i) =>
              (i % labelEvery === 0 || i === data.length - 1) && (
                <text key={d.key} x={left + i * bw + bw / 2} y={H - 6} textAnchor="middle">
                  {d.label}
                </text>
              ),
          )}
        </g>
      </svg>
    </figure>
  );
}
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? 10 * p;
}
