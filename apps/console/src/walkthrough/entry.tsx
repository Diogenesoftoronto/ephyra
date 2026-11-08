import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AccountSettings, Trail, TrailEvent } from "@ephyra/core";
import { App } from "../app/App.tsx";
import { ApiProvider } from "../app/ApiContext.tsx";
import { FakeApi } from "../fake/api.ts";
import { FakeAccountApi, ACCOUNT_FIXTURE } from "../fake/account.ts";
import { FakeSetupApi } from "../fake/setup.ts";
import { FakeTeamApi } from "../fake/team.ts";
import { ME, STORY_NOW } from "../fake/fixtures.ts";
import { TrailPanel } from "../pages/TrailPanel.tsx";
import { VoiceProvider } from "../voice/Voice.tsx";
import type { InboxEntry, TrailDetail } from "../api.ts";
import sample from "./sample.json";
import "../theme.css";
import "../layout.css";
import "../materials.css";
import "./walkthrough.css";

const productScenes = ["onboarding", "overview", "runs", "workspace", "personas", "team"];
const trailScenes = Object.keys(sample.moments);
const acceptsScene = (value: unknown): value is string => typeof value === "string" && [...productScenes, ...trailScenes].includes(value);

/** This adapter reads the CLI's recorded example. It never submits a live action. */
class RecordedTourApi extends FakeApi {
  readonly detail: TrailDetail;
  readonly items: InboxEntry[];
  constructor(scene: string) {
    super({ empty: true, now: STORY_NOW });
    const snapshot = sample.moments[scene as keyof typeof sample.moments];
    const trail = snapshot.trail as Trail;
    const events = snapshot.events as TrailEvent[];
    const has = (type: string) => events.some(event => event.type === type);
    this.detail = { trail, events, artefacts: [
      ...(has("research_completed") ? [{ path: "hypothesis.md", content: sample.hypothesis }] : []),
      ...(has("plan_completed") ? [{ path: "plan.md", content: sample.plan }] : []),
      { path: "evidence/index.json", content: JSON.stringify(has("research_completed") ? sample.evidence : sample.evidence.slice(0, 1), null, 2) },
    ] };
    const checkpoint = ({ hypothesis: "A", explain: "A", revise: "A", plan: "B", proof: "C" } as const)[scene as "hypothesis"];
    const proof = events.find(event => event.type === "proof_completed");
    this.items = checkpoint ? [{
      trailId: trail.id, short: trail.short, title: trail.title, area: trail.area, risk: trail.risk,
      severity: trail.severity, state: trail.state, kind: "checkpoint", checkpoint, blocking: true,
      bound: { rev: trail.rev, ...(trail.head ? { head: trail.head } : {}),
        ...(proof?.type === "proof_completed" ? { proofDigest: proof.data.digest } : {}) },
      artefact: { path: checkpoint === "A" ? "hypothesis.md" : checkpoint === "B" ? "plan.md" : "proof.json",
        summary: checkpoint === "A" ? "Review the cause" : checkpoint === "B" ? "Review the plan" : "Review the recorded proof" },
      createdAt: trail.updatedAt,
    }] : [];
  }
  override async trail(): Promise<TrailDetail> { return structuredClone(this.detail); }
  override async inbox() { return structuredClone(this.items); }
}

function RecordedTrail({ scene }: { scene: string }) {
  const api = useMemo(() => new RecordedTourApi(scene), [scene]);
  const id = api.detail.trail.id;
  useEffect(() => {
    let done = false;
    const reveal = () => {
      if (done || !document.querySelector(".trail-head")) return;
      const title = scene === "proof" ? "Recorded proof" : scene === "plan" ? "plan.md"
        : ["hypothesis", "explain"].includes(scene) ? "hypothesis.md" : null;
      let target: HTMLElement | null = title ? [...document.querySelectorAll<HTMLElement>(".ui-card")]
        .find(card => [...card.querySelectorAll("h2,h3,h4")].some(heading => heading.textContent === title)) ?? null : null;
      if (scene === "explain") {
        const details = document.querySelector<HTMLDetailsElement>('[aria-label="Review evidence"] details');
        if (details) { details.open = true; target = details; }
      }
      if (scene === "revise") target = document.querySelector('[aria-label="Shared quest discussion"]');
      if (["watching", "set", "rollback"].includes(scene)) target = document.querySelector('[aria-label="Timeline"]');
      if (scene === "triaged") { done = true; scrollTo(0, 0); return; }
      if (!target) return;
      target.dataset.tourFocus = "";
      // scrollIntoView also scrolls the containing landing page. Only move this document.
      const inset = (document.querySelector(".tour-recorded-heading")?.getBoundingClientRect().height ?? 0) + 20;
      scrollTo({ top: scrollY + target.getBoundingClientRect().top - inset, behavior: "instant" });
      done = true;
    };
    const observer = new MutationObserver(reveal); observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
    reveal(); return () => observer.disconnect();
  }, [scene]);
  return <ApiProvider api={api}><VoiceProvider api={api} context={{ kind: "trail", id }}
    label="Sample quest" scopeKey={scene} canSpend={false}>
    <div className="tour-recorded">
      <header className="tour-recorded-heading"><img src="/app/brand/logo.svg" width="24" height="24" alt="" />
        <b>Ephyra</b><span>Inbox / Quest</span><small>Recorded example · read-only</small></header>
      <TrailPanel key={scene} trailId={id} items={api.items} canAct={false} principal={ME} />
    </div>
  </VoiceProvider></ApiProvider>;
}

function WorkspaceSample({ scene }: { scene: string }) {
  const api = useMemo(() => new FakeApi({ now: STORY_NOW, streamIntervalMs: Infinity }), []);
  const accountApi = useMemo(() => new FakeAccountApi(), []);
  const [settings, setSettings] = useState<AccountSettings>({ ...ACCOUNT_FIXTURE,
    onboarding: { ...ACCOUNT_FIXTURE.onboarding, status: "complete" as const } });
  const team = useMemo(() => new FakeTeamApi(), []);
  const automation = useMemo(() => new FakeSetupApi(), []);
  useEffect(() => { location.hash = `#/${scene}`; }, [scene]);
  return <App api={api} demo identity={{ principal: ME, kind: "human", approver: true }}
    account={{ api: accountApi, settings, onChange: setSettings, automation }} team={{ api: team }} />;
}

function Tour() {
  const initial = new URLSearchParams(location.search).get("scene");
  const [scene, setScene] = useState(acceptsScene(initial) ? initial : "overview");
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== parent || event.origin !== location.origin || event.data?.type !== "ephyra:tour") return;
      if (acceptsScene(event.data.scene)) {
        setScene(event.data.scene);
        // Reselecting a workspace tab also returns from any internal sample navigation.
        if (productScenes.includes(event.data.scene)) location.hash = `#/${event.data.scene}`;
      }
      if (event.data.theme === "light" || event.data.theme === "dark") document.documentElement.dataset.theme = event.data.theme;
    };
    addEventListener("message", receive);
    parent.postMessage({ type: "ephyra:tour-ready" }, location.origin);
    return () => removeEventListener("message", receive);
  }, []);
  return <div data-tour-scene={scene}>
    {trailScenes.includes(scene) ? <RecordedTrail scene={scene} /> : <WorkspaceSample scene={scene} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Tour />);
