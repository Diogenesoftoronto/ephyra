// A composed screen built only from primitives, used to critique the visual system as a whole (not a real page).
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { PERSONAS } from "@ephyra/core";
import { Avatar, Badge, Button, Card, Hash, Meter, PageHeader, PersonaTag, Shell, Stat, Tag, type NavItem } from "./primitives.tsx";

const nav: NavItem[] = [
  { id: "overview", label: "Overview", icon: "overview" }, { id: "inbox", label: "Inbox", icon: "inbox", count: 4 },
  { id: "runs", label: "Runs", icon: "runs" }, { id: "usage", label: "Usage", icon: "usage" },
  { id: "workspace", label: "Workspace", icon: "workspace" }, { id: "personas", label: "Personas", icon: "personas" },
];
const days = [0.8, 1.4, 0.6, 2.9, 3.6, 2.1, 3.4];
const avatar = (id: string, size: 24 | 32 | 48 = 32, live = false) => {
  const p = PERSONAS.find((x) => x.id === id)!;
  return <Avatar initial={p.name[0]!} color={`var(--persona-${p.id})`} size={size} src={`/personas/${p.id}.webp`} live={live} label={p.name} />;
};

function Overview() {
  const max = Math.max(...days);
  return (
    <>
      <PageHeader title="Good afternoon" lede="Three agents are working. Four trails are waiting for a decision."
        actions={<Button variant="primary">Open inbox</Button>} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "var(--s6)", marginBottom: "var(--s6)" }}>
        <Stat label="Running now" value="3" tone="live" sub="2 in orbs · 1 local" />
        <Stat label="Waiting for you" value="4" sub="1 blocks a landing" />
        <Stat label="Spend · 7 days" value="$14.82" unknownCount={3} sub="of $40 budget" />
        <Stat label="Landed · 7 days" value="6" sub="1 rolled back" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: "var(--s4)" }}>
        <Card title="Working now" meta="live" actions={<Button size="sm" variant="ghost">All runs</Button>}>
          {[["lappet", "Writing the patch", "T-7f3a2c · cart", "orb · 2m"], ["nema", "Running the proof", "T-19be04 · checkout", "local · 41s"],
            ["bell", "Searching past trails", "T-0c11aa · search", "orb · 5m"]].map(([id, what, trail, where]) => (
            <div key={id} style={{ display: "flex", gap: "var(--s3)", alignItems: "center" }}>
              {avatar(id!, 32, true)}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{what}</div>
                <div className="muted" style={{ fontSize: "var(--fs-small)" }}>{trail}</div>
              </div>
              <Badge tone="live">{where}</Badge>
            </div>
          ))}
        </Card>
        <Card title="Waiting for you" meta="4 trails" actions={<Button size="sm" variant="ghost">Inbox</Button>}>
          {[["C", "Cart total shows NaN", "cart · proof passed", true], ["B", "Search returns stale results", "search · plan ready", false],
            ["A", "Webhook retries double-charge", "payments · hypothesis", false]].map(([cp, title, sub, blocking]) => (
            <div key={String(title)} style={{ display: "flex", gap: "var(--s3)", alignItems: "center" }}>
              <Badge tone={blocking ? "warn" : "info"}>{String(cp)}</Badge>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{String(title)}</div>
                <div className="muted" style={{ fontSize: "var(--fs-small)" }}>{String(sub)}</div>
              </div>
              <Button size="sm" variant={blocking ? "primary" : "secondary"}>Review</Button>
            </div>
          ))}
        </Card>
        <Card title="Spend" meta="last 7 days">
          <svg viewBox="0 0 280 90" role="img" aria-label="Spend per day" style={{ width: "100%", height: "auto" }}>
            {days.map((d, i) => (
              <rect key={i} x={i * 40 + 6} y={84 - (d / max) * 76} width={28} height={(d / max) * 76} rx={5}
                fill={i === days.length - 1 ? "var(--jelly)" : "color-mix(in oklch, var(--jelly) 45%, var(--surface-2))"} />
            ))}
          </svg>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s3)" }}>
            {(["lappet", "nema", "bell", "rho"] as const).map((p, i) => <PersonaTag key={p} persona={p}>{["$6.10", "$4.02", "$3.55", "$1.15"][i]}</PersonaTag>)}
          </div>
        </Card>
        <Card title="Budgets" meta="trails over half">
          <Meter label="T-7f3a2c · cart" used={3.9} max={5} unknown={2} format={(n) => `$${n.toFixed(2)}`} />
          <Meter label="T-0c11aa · search" used={2.6} max={5} format={(n) => `$${n.toFixed(2)}`} />
        </Card>
        <Card tone="alert" title="Rolled back" meta="14 min ago" persona="turri">
          <p>The checkout error came back six minutes after landing. Turri reverted <Hash value="9f2c1e7a44b0d3e1" /> and reopened the trail.</p>
          <div><Button size="sm">Open T-19be04</Button></div>
        </Card>
      </div>
      <div style={{ marginTop: "var(--s6)" }}><Tag>This is a composition for critique, not a page</Tag></div>
    </>
  );
}

const meta: Meta = { title: "UI/Composition", parameters: { layout: "fullscreen" } };
export default meta;
export const OverviewInShell: StoryObj = {
  render: function Frame() {
    const [cur, setCur] = useState("overview");
    return <Shell nav={nav} current={cur} onNavigate={setCur} user={{ name: "dio", detail: "dio.pds.notorganic.info", avatar: avatar("velum", 32) }}>
      <Overview /></Shell>;
  },
};
