// A composed Overview built only from primitives, used to critique the visual system as a whole (not the real page).
// Order follows the work: an exception first, then decisions (the one framed tray), then what's running, then money.
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { PERSONAS, type PersonaId } from "@ephyra/core";
import {
  Avatar, BarChart, Button, Card, Checkpoint, Hash, Meter, Notice, PageHeader, PersonaTag, Row, Rows, Shell, Stat, Stats, Status,
  type NavItem,
} from "./primitives.tsx";

const nav: NavItem[] = [
  { id: "overview", label: "Overview", icon: "overview" }, { id: "inbox", label: "Inbox", icon: "inbox", count: 3 },
  { id: "runs", label: "Runs", icon: "runs" }, { id: "usage", label: "Usage", icon: "usage" },
  { id: "workspace", label: "Workspace", icon: "workspace", overflow: true }, { id: "personas", label: "Personas", icon: "personas", overflow: true },
];
const BASE = "/";
const avatar = (id: PersonaId, size: 24 | 32 | 48 = 32) => {
  const p = PERSONAS.find((x) => x.id === id)!;
  return <Avatar initial={p.name[0]!} color={`var(--persona-${p.id})`} tint={`var(--persona-${p.id}-tint)`} size={size}
    src={`${BASE}personas/${p.id}-64.webp`} label={p.name} />;
};
const usd = (n: number) => `$${n.toFixed(2)}`;
const usd0 = (n: number) => `$${n % 1 ? n.toFixed(1) : n}`;
const week = [["Fri", 0.8], ["Sat", 1.4], ["Sun", 0.6], ["Mon", 2.9], ["Tue", 3.6], ["Wed", 2.1], ["Today", 3.4]] as const;

function Overview() {
  return (
    <>
      <PageHeader title="Overview" lede="3 decisions waiting · 3 agents running · $14.82 recorded this week" />
      <Notice title="Rolled back T-19be04 · checkout" body={<>The error returned 6 minutes after landing, so Turri reverted <Hash value="9f2c1e7a44b0d3e1" /> and reopened the trail.</>}
        actions={<Button size="sm">Open trail</Button>} />
      <div style={{ height: "var(--s5)" }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: "var(--s5)", alignItems: "start" }}>
        <Card tone="tray" title="Needs your decision" meta="3 trails" actions={<Button size="sm" variant="ghost">Open inbox</Button>}>
          <Rows>
            <Row lead={<Checkpoint id="C" blocking compact />} title="Cart total shows NaN" meta="Landing · T-7f3a2c · cart · proof passed · rev 3"
              aside={<Button size="sm" variant="primary">Review</Button>} />
            <Row lead={<Checkpoint id="B" compact />} title="Search returns stale results" meta="Plan · T-0c11aa · search" aside={<Button size="sm">Review</Button>} />
            <Row lead={<Checkpoint id="A" compact />} title="Webhook retries double-charge" meta="Hypothesis · T-4be210 · payments"
              aside={<Button size="sm">Review</Button>} />
          </Rows>
        </Card>
        <Card tone="quiet" title="Working now" meta="3 agents" actions={<Button size="sm" variant="ghost">All runs</Button>}>
          <Rows>
            {([["lappet", "Writing the patch", "T-7f3a2c · cart", "Amp orb a1.small · 2 min"],
              ["nema", "Running the proof", "T-19be04 · checkout", "Local runner · 41 s"],
              ["bell", "Searching past trails", "T-0c11aa · search", "Amp orb a1.small · 5 min"]] as const).map(([id, what, trail, where]) => (
              <Row key={id} lead={avatar(id, 32)} title={what} meta={<><PersonaTag persona={id} /> · {trail} · {where}</>} aside={<Status state="running" />} />
            ))}
          </Rows>
        </Card>
      </div>
      <div style={{ height: "var(--s6)" }} />
      <Stats>
        <Stat label="Recorded spend, 7 days" value="$14.82" unknownCount={3} sub="Budget $40.00" />
        <Stat label="Landed, 7 days" value="6" sub="1 rolled back" />
        <Stat label="Trails open" value="11" sub="4 parked" />
        <Stat label="Proofs passed" value="9 of 10" sub="1 flaky, rerun" />
      </Stats>
      <div style={{ height: "var(--s6)" }} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: "var(--s5)", alignItems: "start" }}>
        <Card tone="quiet" title="Recorded spend" meta="Last 7 days">
          <BarChart label="Recorded spend per day, last 7 days" format={usd0} partial data={week.map(([d, v]) => ({ key: d, label: d, value: v }))} />
          <p className="ui-label">Today is so far. 3 entries this week have unknown cost and are not drawn.</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2) var(--s4)" }}>
            {(["lappet", "nema", "bell", "rho"] as const).map((p, i) => <PersonaTag key={p} persona={p}>{PERSONAS.find((x) => x.id === p)!.name} {["$6.10", "$4.02", "$3.55", "$1.15"][i]}</PersonaTag>)}
          </div>
        </Card>
        <Card tone="quiet" title="Trail budgets" meta="Over half used">
          <Meter label="T-7f3a2c · cart" used={3.9} max={5} unknown={2} format={usd} />
          <Meter label="T-0c11aa · search" used={2.6} max={5} format={usd} />
          <Meter label="T-2210ab · auth" used={5.3} max={5} format={usd} />
        </Card>
      </div>
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
