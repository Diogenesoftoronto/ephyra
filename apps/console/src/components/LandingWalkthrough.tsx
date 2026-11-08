import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountSettings } from "@ephyra/core";
import { App } from "../app/App.tsx";
import { useAsync } from "../app/useAsync.ts";
import { FakeApi } from "../fake/api.ts";
import { ACCOUNT_FIXTURE, FakeAccountApi, loadAccountCatalogFixture } from "../fake/account.ts";
import { FakeSetupApi } from "../fake/setup.ts";
import { ME } from "../fake/fixtures.ts";
import { readWalkthroughSelection, walkthroughNavigationAllowed, type WalkthroughSelection } from "../lib/landing-walkthrough.ts";
import { Load } from "./Load.tsx";
import "./LandingWalkthrough.css";

/** The production console components, backed exclusively by fictional in-memory adapters. */
export function LandingWalkthrough({ parentOrigin }: { parentOrigin: string | null }) {
  const [selection, setSelection] = useState<WalkthroughSelection>();
  const [notice, setNotice] = useState("");
  const selected = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!parentOrigin || parent === window) return;
    const receive = (event: MessageEvent) => {
      const value = readWalkthroughSelection(event, parentOrigin, parent);
      if (!value || value.key === selected.current) return;
      selected.current = value.key;
      setSelection(value);
      setNotice("");
    };
    addEventListener("message", receive);
    parent.postMessage({ type: "ephyra.walkthrough.ready" }, parentOrigin);
    return () => removeEventListener("message", receive);
  }, [parentOrigin]);
  useEffect(() => {
    if (!selection || !parentOrigin) return;
    const target = `#/inbox/${encodeURIComponent(selection.detail.trail.id)}`;
    history.replaceState(null, "", `${location.pathname}${location.search}${target}`);
    dispatchEvent(new HashChangeEvent("hashchange"));
    scrollTo(0, 0);
    parent.postMessage({ type: "ephyra.walkthrough.applied", step: selection.step,
      trailId: selection.detail.trail.id, state: selection.detail.trail.state }, parentOrigin);
  }, [selection, parentOrigin]);
  useEffect(() => {
    const navigate = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || walkthroughNavigationAllowed(link.href, location.href)) return;
      event.preventDefault();
      setNotice("This sample stays in the demo workspace. Use Open app on the landing page to connect your own account.");
    };
    document.addEventListener("click", navigate, true);
    return () => document.removeEventListener("click", navigate, true);
  }, []);
  if (!parentOrigin) return <main className="walkthrough-waiting"><h1>Sample console unavailable</h1>
    <p>Open the walkthrough from the Ephyra landing page.</p></main>;
  return <div className="landing-walkthrough" data-walkthrough-step={selection?.step}>
    {notice && <p className="walkthrough-notice" role="status">{notice}</p>}
    {selection ? <WalkthroughWorkspace key={selection.key} selection={selection} /> : <main className="walkthrough-waiting" role="status">
      <p>Loading the sample workspace…</p><p>The real console uses fictional data here.</p>
    </main>}
  </div>;
}

export function WalkthroughWorkspace({ selection }: { selection: WalkthroughSelection }) {
  const api = useMemo(() => {
    const value = new FakeApi({ now: Date.parse(selection.detail.trail.updatedAt), seedConversation: false });
    value.installWalkthrough(selection.detail);
    return value;
  }, [selection.key]);
  const accountApi = useMemo(() => new FakeAccountApi({ initial: {
    ...structuredClone(ACCOUNT_FIXTURE), did: ME, workspaceId: "landing-sample-workspace",
    repository: { url: "https://git.example.org/sample/checkout.git", branch: "main", head: selection.detail.trail.base.sha,
      verifiedAt: selection.detail.trail.createdAt, credentialConfigured: false },
    onboarding: { status: "complete", updatedAt: selection.detail.trail.updatedAt },
  } }), [selection.key]);
  const automation = useMemo(() => new FakeSetupApi(), [selection.key]);
  const account = useAsync(() => accountApi.settings(), `walkthrough:${selection.key}`);
  const change = (value: AccountSettings) => account.set(value);
  return <Load state={account.state} retry={account.reload}>{settings => <App api={api} demo
    identity={{ principal: ME, kind: "human", approver: true }}
    account={{ api: accountApi, settings, onChange: change, automation, loadCatalog: loadAccountCatalogFixture }} />}</Load>;
}
