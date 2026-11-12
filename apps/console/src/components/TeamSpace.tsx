import { useEffect, useMemo, useState } from "react";
import {
  AUTONOMY_LEVELS, personLabel, type ActivityItem, type AreaSketch, type InvestigationQuestion, type PeopleConnection,
  type PersonProfile, type TeamRole, type Trail,
} from "@ephyra/core";
import type { InboxEntry } from "../api.ts";
import { useOptionalApi } from "../app/ApiContext.tsx";
import type { TeamApi } from "../team-api.ts";
import { Badge, Card, Empty, Rows, Skeleton } from "../kit.ts";
import { useNow } from "../lib/clock.tsx";
import { relativeTime } from "../lib/format.ts";
import {
  asks, blockers, channelStatus, load, recentCounts, running, waitingKey, workGroups,
  type Ask, type Delivery, type WaitingOn,
} from "../lib/team-space.ts";
import { guidance, patterns } from "../lib/team-guidance.ts";
import { ActivityRow } from "./ActivityFeed.tsx";
import { PersonIdentity } from "./PersonIdentity.tsx";
import "./TeamSpace.css";

type Part<T> = T | "unavailable";
interface Data {
  inbox: Part<InboxEntry[]>; questions: Part<InvestigationQuestion[]>; trails: Part<Trail[]>;
  activity: Part<ActivityItem[]>; people: Map<string, PersonProfile> | null; sketches: AreaSketch[] | undefined;
  roster: Part<{ did: string; role: TeamRole | "owner" | null; label?: string }[]>;
}
const ok = <T,>(r: PromiseSettledResult<T>): Part<T> => (r.status === "fulfilled" ? r.value : "unavailable");

const ROLE = { owner: "Owner", approver: "Approver", viewer: "Viewer" } as const;
const DELIVERY: Record<Delivery, { label: string; tone: "neutral" | "ok" | "warn" | "info" }> = {
  inbox: { label: "In Ephyra inbox", tone: "neutral" },
  bridge: { label: "Sent through bridge", tone: "info" },
  unconfirmed: { label: "Delivery unconfirmed", tone: "warn" },
  not_sent: { label: "Not sent yet", tone: "warn" },
};
const KIND: Record<Ask["kind"], { tile: string; label: string; act: string }> = {
  question: { tile: "?", label: "Question", act: "Answer" },
  checkpoint: { tile: "", label: "Checkpoint", act: "Review" },
  spend: { tile: "$", label: "Spend", act: "Decide" },
  parked: { tile: "‖", label: "Parked", act: "Resume" },
};
const CHECKPOINT = { A: "hypothesis", B: "plan", C: "landing" } as const;

/**
 * The team as one shared space: what Ephyra is asking people for, who each ask waits on, what the agents are doing,
 * and where asks are delivered. Each source loads on its own, so one missing feed never blanks the page.
 */
export function TeamSpace({ teamApi, channels }: {
  teamApi?: TeamApi;
  /** Saved delivery settings. `undefined` when this viewer cannot see them; `null` when none are saved. */
  channels?: PeopleConnection | null;
}) {
  const api = useOptionalApi();
  const now = useNow(30_000);
  const [data, setData] = useState<Data | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    const none = Promise.reject(new Error("unavailable"));
    none.catch(() => undefined);
    void Promise.allSettled([
      api ? api.inbox() : none, api ? api.questions() : none, api ? api.trails() : none, api ? api.activity(40) : none,
      api?.profiles ? api.profiles() : none, teamApi ? teamApi.team() : none,
      api ? api.doc("autonomy.md") : none,
    ]).then(([inbox, questions, trails, activity, profiles, team, autonomy]) => {
      if (!live) return;
      const people = profiles.status === "fulfilled" ? new Map(profiles.value.people.map((p) => [p.did, p])) : null;
      const roster: Data["roster"] = team.status === "fulfilled"
        ? [{ did: team.value.ownerDid, role: "owner" }, ...team.value.invitations
            .filter((i) => i.acceptedBy && !i.revokedAt).map((i) => ({ did: i.acceptedBy!, role: i.role, label: i.label }))]
        : people ? [...people.values()].map((p) => ({ did: p.did, role: null })) : "unavailable";
      const sketches = autonomy.status === "fulfilled" ? autonomy.value.sketches : undefined;
      setData({ inbox: ok(inbox), questions: ok(questions), trails: ok(trails), activity: ok(activity), people, roster, sketches });
    });
    return () => { live = false; };
  }, [api, teamApi]);

  const view = useMemo(() => {
    if (!data) return null;
    const trails = data.trails === "unavailable" ? [] : data.trails;
    const list = asks({
      inbox: data.inbox === "unavailable" ? [] : data.inbox,
      questions: data.questions === "unavailable" ? [] : data.questions,
      trails,
    });
    const byId = new Map(trails.map((t) => [t.id, t]));
    return {
      byId, patterns: patterns(list, byId, trails, data.sketches, now),
      asks: list, blockers: blockers(list), load: load(list, trails), groups: workGroups(trails),
      counts: recentCounts(trails, now), agents: data.activity === "unavailable" ? [] : running(data.activity),
    };
  }, [data, now]);

  if (!data || !view) return <div className="space"><p role="status" className="sr-only">Loading what the team is doing…</p><Skeleton lines={6} /></div>;

  const name = (w: WaitingOn): string => {
    if (w.kind === "approvers") return "Any approver";
    if (w.kind === "nobody") return "No recipient";
    if (w.kind === "contact") return w.alias;
    const p = data.people?.get(w.did);
    if (p?.status === "verified") return personLabel(p);
    const member = data.roster !== "unavailable" ? data.roster.find((r) => r.did === w.did) : undefined;
    return member?.label ?? w.alias ?? "A teammate";
  };
  const blocking = view.asks.filter((a) => a.blocking).length;
  const missing = (["inbox", "questions", "trails", "activity"] as const).filter((k) => data[k] === "unavailable");

  return (
    <div className="space">
      <dl className="space-strip" aria-label="Team at a glance">
        <div data-tone={blocking ? "warn" : undefined}><dt>Waiting on people</dt>
          <dd>{data.inbox === "unavailable" && data.questions === "unavailable" ? "—" : view.asks.length}</dd>
          {blocking > 0 && <dd className="space-strip__sub">{blocking} blocking</dd>}</div>
        <div data-tone={view.agents.length ? "live" : undefined}><dt>Agents working</dt>
          <dd>{data.activity === "unavailable" ? "—" : view.agents.length}</dd></div>
        <div><dt>Open quests</dt><dd>{data.trails === "unavailable" ? "—" : view.counts.open}</dd></div>
        <div><dt>Landed · 30 days</dt><dd>{data.trails === "unavailable" ? "—" : view.counts.landed}</dd>
          {view.counts.ended > 0 && <dd className="space-strip__sub">{view.counts.ended} ended unlanded</dd>}</div>
      </dl>
      {missing.length > 0 && <p className="space-note" role="status">Some activity could not be loaded ({missing.join(", ")}). Counts may be incomplete.</p>}

      <div className="space-grid">
        <div className="space-main">
          <Card title="Ephyra is asking" meta={view.asks.length ? `${view.asks.length} open` : undefined}>
            {view.asks.length === 0
              ? <Empty title="Nobody is holding anything up" body="Questions, checkpoints, and spend requests appear here." />
              : <ul className="space-asks">{view.asks.map((a) => (
                <li key={a.key} className="space-ask" data-blocking={a.blocking ? "" : undefined}>
                  <span className="space-ask__tile" data-kind={a.kind} aria-hidden="true">{a.checkpoint ?? KIND[a.kind].tile}</span>
                  <div className="space-ask__body">
                    <a className="space-ask__title" href={`#/inbox/${encodeURIComponent(a.trailId)}`}>{a.title}</a>
                    <p className="space-ask__meta">
                      <span className="sr-only">{KIND[a.kind].label}{a.checkpoint ? ` ${a.checkpoint}, ${CHECKPOINT[a.checkpoint]}` : ""}. </span>
                      {a.short && <span className="mono">{a.short}</span>}
                      <span>Waiting on <strong>{name(a.waitingOn)}</strong></span>
                      <span>{relativeTime(a.since, now)}</span>
                      {a.delivery && <Badge tone={DELIVERY[a.delivery].tone}>{DELIVERY[a.delivery].label}</Badge>}
                      {a.blocking && <Badge tone="warn">Blocking</Badge>}
                    </p>
                  </div>
                  <a className="ui-button ui-button--sm ui-button--secondary" href={`#/inbox/${encodeURIComponent(a.trailId)}`}
                    aria-label={`${KIND[a.kind].act}: ${a.title}`}>{KIND[a.kind].act}</a>
                  <Why ask={a} g={guidance(a, {
                    trail: view.byId.get(a.trailId), trails: data.trails === "unavailable" ? [] : data.trails, sketches: data.sketches,
                    bridge: channelStatus(channels).bridge, shadowVerdict: a.shadowVerdict,
                    recipientHasAccount: a.waitingOn.kind === "person" ? true : a.waitingOn.kind === "contact" ? false : undefined,
                  })} />
                </li>))}</ul>}
          </Card>

          {view.patterns.length > 0 && <Card title="Toward more autonomy" meta="Last 30 days">
            <table className="space-patterns">
              <thead><tr><th scope="col">Area</th><th scope="col">Level</th><th scope="col">Waiting</th><th scope="col">Decided</th>
                <th scope="col">Next move</th></tr></thead>
              <tbody>{view.patterns.slice(0, 6).map((p) => <tr key={p.area}>
                <th scope="row">{p.area}</th>
                <td>{p.level ? AUTONOMY_LEVELS.find((l) => l.id === p.level)!.label : data.sketches === undefined ? "Unknown" : "Not set"}</td>
                <td>{p.open}</td><td>{p.decided}</td>
                <td><a href="#/workspace">{p.move}</a></td>
              </tr>)}</tbody>
            </table>
            <p className="space-note">Every time a person steps in is a rule Ephyra doesn't have yet. Write the rule down, and the same stop
              stops coming back.</p>
          </Card>}

          <Card title="Working on" meta={view.agents.length ? `${view.agents.length} running now` : undefined}>
            {view.agents.length > 0 && <Rows className="space-agents">{view.agents.slice(0, 4).map((i) => <ActivityRow key={i.id} item={i} />)}</Rows>}
            {view.groups.every((g) => g.trails.length === 0)
              ? <Empty title="No open quests" body="When Ephyra picks up a signal, its quest shows up here." />
              : <div className="space-board">{view.groups.filter((g) => g.trails.length).map((g) => (
                <section key={g.id} className="space-lane" aria-labelledby={`space-lane-${g.id}`}>
                  <h3 id={`space-lane-${g.id}`}>{g.label} <span>{g.trails.length}</span></h3>
                  <ul>{g.trails.slice(0, 5).map((t) => (
                    <li key={t.id}>
                      <a href={`#/inbox/${encodeURIComponent(t.id)}`}><span className="mono">{t.short}</span> {t.title}</a>
                      <span className="space-lane__meta">{t.area}{t.owner?.kind === "human" ? ` · ${name({ kind: "person", did: t.owner.id })}` : ""}</span>
                    </li>))}
                    {g.trails.length > 5 && <li className="space-lane__more">+ {g.trails.length - 5} more</li>}
                  </ul>
                </section>))}</div>}
          </Card>
        </div>

        <aside className="space-rail" aria-label="People and channels">
          <Card title="People">
            {data.roster === "unavailable"
              ? <p className="space-note">The roster is visible to the workspace owner.</p>
              : <ul className="space-people">{data.roster.map((r) => {
                const l = view.load.get(r.did);
                return <li key={r.did}>
                  <PersonIdentity did={r.did} details={false} invitedAs={r.label} size={32}
                    profile={data.people?.get(r.did) ?? null}
                    avatarUrl={data.people?.get(r.did)?.avatar && api?.avatarUrl ? api.avatarUrl(r.did) : null} />
                  {r.role ? <Badge>{ROLE[r.role]}</Badge> : <span />}
                  {(l?.waiting || l?.owns) ? <span className="space-people__load">
                    {l.waiting ? <span data-tone="warn">{l.waiting} waiting on them</span> : null}
                    {l.owns ? <span>owns {l.owns} {l.owns === 1 ? "quest" : "quests"}</span> : null}
                  </span> : null}
                </li>;
              })}</ul>}
            {view.blockers.some((b) => b.waitingOn.kind !== "person") && <ul className="space-pools" aria-label="Asks not tied to one person">
              {view.blockers.filter((b) => b.waitingOn.kind !== "person").map((b) => (
                <li key={waitingKey(b.waitingOn)}><span>{name(b.waitingOn)}{b.waitingOn.kind === "contact" ? " · contact" : ""}</span>
                  <span data-tone={b.blocking ? "warn" : undefined}>{b.count} waiting</span></li>))}
            </ul>}
          </Card>
          <Channels channels={channels} />
        </aside>
      </div>
    </div>
  );
}

function Why({ ask, g }: { ask: Ask; g: ReturnType<typeof guidance> }) {
  return (
    <details className="space-why">
      <summary>Why a person?<span className="sr-only"> for {ask.title}</span></summary>
      <div className="space-why__body">
        <ul className="space-why__facts">{g.why.map((w) => <li key={w}>{w}</li>)}</ul>
        <p><strong>Why not alone:</strong> {g.notAlone}</p>
        {g.steps.length > 0 && <>
          <h4>So Ephyra can handle this next time</h4>
          <ol className="space-why__steps">{g.steps.map((s) => <li key={s.id}>
            {s.href ? <a href={s.href}>{s.title}</a> : <strong>{s.title}</strong>}
            <span>{s.detail}</span>
            {s.evidence && <small>Based on {s.evidence}.</small>}
          </li>)}</ol>
        </>}
      </div>
    </details>
  );
}

const MESSENGERS = ["Slack", "Discord", "Teams", "Matrix"] as const;

function Channels({ channels }: { channels?: PeopleConnection | null }) {
  const s = channelStatus(channels);
  const bridge = {
    connected: { label: "Connected", tone: "ok" as const },
    incomplete: { label: "Needs URL and key", tone: "warn" as const },
    off: { label: "Off", tone: "neutral" as const },
    unknown: { label: "Owner only", tone: "neutral" as const },
  }[s.bridge];
  return (
    <Card title="Channels" actions={s.bridge !== "unknown" ? <a className="space-link" href="#/settings">Set up</a> : undefined}>
      <ul className="space-channels">
        <li><span><strong>Ephyra inbox</strong><small>Owner questions and checkpoints</small></span><Badge tone="ok">On</Badge></li>
        <li><span><strong>Delivery bridge</strong><small>{s.host ?? "Your relay for other contacts"}
          {s.contacts ? ` · ${s.contacts} ${s.contacts === 1 ? "contact" : "contacts"}` : ""}</small></span>
          <Badge tone={bridge.tone}>{bridge.label}</Badge></li>
        <li><span><strong>{MESSENGERS.join(", ")}</strong><small>Reach them through your bridge</small></span><Badge>No native app yet</Badge></li>
      </ul>
      <p className="space-note">Ephyra posts each checked question to the bridge with a signed answer link, and your relay decides where it goes.</p>
    </Card>
  );
}
