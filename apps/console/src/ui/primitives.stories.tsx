import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { AUTONOMY_LEVELS, PERSONAS, type AutonomyLevel } from "@ephyra/core";
import {
  Avatar, Badge, Button, Card, Empty, Field, Hash, Meter, PageHeader, PersonaTag, Segmented, Skeleton, Stat, Tag,
} from "./primitives.tsx";

const meta: Meta = { title: "UI/Primitives" };
export default meta;
type S = StoryObj;
const row = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" } as const;

export const Buttons: S = {
  render: () => (
    <div style={row}>
      <Button variant="primary">Approve and land</Button><Button>Request changes</Button>
      <Button variant="ghost">Comment</Button><Button variant="danger">Roll back</Button>
      <Button variant="primary" loading>Publishing</Button><Button size="sm">Claim</Button><Button disabled>Disabled</Button>
    </div>
  ),
};
export const Badges: S = {
  render: () => (
    <div style={row}>
      <Badge>shadow</Badge><Badge tone="ok">proof passed</Badge><Badge tone="warn">2 warnings</Badge>
      <Badge tone="bad">failed</Badge><Badge tone="info">checkpoint B</Badge><Badge tone="live">running</Badge>
      {PERSONAS.map((p) => <PersonaTag key={p.id} persona={p.id}>{p.name}</PersonaTag>)}
    </div>
  ),
};
export const Stats: S = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 24 }}>
      <Stat label="Spend · 7 days" value="$14.82" unknownCount={3} sub="of $40.00 budget" />
      <Stat label="Running now" value="3" tone="live" sub="2 orbs, 1 local" />
      <Stat label="Waiting for you" value="4" sub="1 blocking landing" />
      <Stat label="Rolled back" value="1" tone="bad" sub="T-7f3a2c, 14 min ago" />
    </div>
  ),
};
export const Cards: S = {
  render: () => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
      <Card title="Cart total shows NaN" meta="T-7f3a2c · cart" actions={<Badge tone="info">B</Badge>}>
        <p>Nema reproduced it: a coupon with no amount makes <code>subtotal</code> undefined.</p>
      </Card>
      <Card tone="live" title="Writing the patch" meta="Lappet · orb a1.small" persona="lappet">
        <p className="muted">Started 2 min ago. 14 tool calls, 1 blocked by policy.</p>
      </Card>
      <Card tone="alert" title="Watch failed" meta="T-19be04 · checkout">
        <p>The error returned 6 minutes after landing. Turri rolled the change back.</p>
      </Card>
      <Card tone="inset" title="Inset"><p className="muted">For secondary groupings inside a page.</p></Card>
    </div>
  ),
};
export const Avatars: S = {
  render: () => (
    <div style={row}>
      {PERSONAS.map((p) => (
        <Avatar key={p.id} initial={p.name[0]!} color={`var(--persona-${p.id})`} size={48} src={`/personas/${p.id}.webp`}
          live={p.id === "lappet"} label={p.name} />
      ))}
      {[24, 32, 96].map((s) => <Avatar key={s} initial="V" color="var(--persona-velum)" size={s as 24} />)}
    </div>
  ),
};
export const Meters: S = {
  render: () => (
    <div style={{ display: "grid", gap: 20, maxWidth: 420 }}>
      <Meter label="T-7f3a2c spend" used={1.24} max={5} format={(n) => `$${n.toFixed(2)}`} />
      <Meter label="T-19be04 spend" used={3.9} max={5} unknown={2} format={(n) => `$${n.toFixed(2)}`} />
      <Meter label="T-0c11aa tokens" used={412_000} max={400_000} format={(n) => `${Math.round(n / 1000)}k`} />
    </div>
  ),
};
export const Hashes: S = { render: () => <div style={row}><Hash value="9f2c1e7a44b0d3e1" /><Hash value="sha256:5b1e09c2aa71" chars={14} /></div> };
export const AutonomyLadder: S = {
  render: function Ladder() {
    const [v, setV] = useState<AutonomyLevel>("patch");
    return <div style={{ maxWidth: 560 }}><Segmented label="Autonomy" value={v} onChange={setV}
      options={AUTONOMY_LEVELS.map((l) => ({ id: l.id, label: l.label, hint: l.means }))} /></div>;
  },
};
export const Fields: S = {
  render: () => (
    <div style={{ display: "grid", gap: 16, maxWidth: 420 }}>
      <Field label="Area name" hint="Lowercase, used in autonomy.md"><input defaultValue="payments" /></Field>
      <Field label="Paths" error="src/pay/** matches nothing in this repository"><input defaultValue="src/pay/**" /></Field>
      <Field label="What matters here"><textarea defaultValue="Nothing lands here without a named human approving C." /></Field>
    </div>
  ),
};
export const Tags: S = { render: () => <div style={row}><Tag>checkpoint</Tag><Tag>proof digest</Tag><Tag>spend · 7 days</Tag></div> };
export const Header: S = {
  render: () => <PageHeader title="Usage" lede="What your agents spent and did over the last 7 days."
    actions={<><Button size="sm">Last 7 days</Button><Button size="sm" variant="ghost">Export CSV</Button></>} />,
};
export const EmptyState: S = {
  render: () => <Card><Empty title="Nothing is waiting for you" body="When an agent needs a decision, it appears here."
    action={<Button size="sm">Open trails</Button>} /></Card>,
};
export const Loading: S = { render: () => <div style={{ display: "grid", gap: 16, maxWidth: 420 }}><Skeleton /><Skeleton block /></div> };
