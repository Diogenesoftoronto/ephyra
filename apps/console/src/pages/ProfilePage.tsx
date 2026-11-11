import { useCallback, useEffect, useRef, useState } from "react";
import type { OwnProfile } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { Button, Card, Notice, PageHeader } from "../kit.ts";
import { PersonIdentity } from "../components/PersonIdentity.tsx";
import { describeError } from "../lib/errors.ts";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { SoundToggle } from "../components/SoundToggle.tsx";
import "./ProfilePage.css";

/**
 * Your own account, reachable from every workspace including shared viewer ones. Profile edits belong to the Not Organic
 * portal; returning to this tab re-reads the profile from Not Organic.
 */
export function ProfilePage({ principal, onDisconnect, disconnectLabel = "Sign out", workspaceName, workspaceRole }: {
  principal?: string;
  onDisconnect?: () => void;
  disconnectLabel?: string;
  workspaceName?: string;
  workspaceRole?: string;
}) {
  const api = useApi();
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; profile: OwnProfile; refreshing: boolean } | { status: "error"; error: unknown }>({ status: "loading" });
  const left = useRef(false);
  const load = useCallback(async (fresh: boolean) => {
    if (!api.profile) return;
    setState((s) => (s.status === "ready" ? { ...s, refreshing: true } : s));
    try {
      setState({ status: "ready", profile: await api.profile(fresh), refreshing: false });
    } catch (error) {
      setState((s) => (s.status === "ready" ? { ...s, refreshing: false } : { status: "error", error }));
    }
  }, [api]);
  useEffect(() => { void load(false); }, [load]);
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "visible" && left.current) { left.current = false; void load(true); }
    };
    document.addEventListener("visibilitychange", back);
    window.addEventListener("focus", back);
    return () => { document.removeEventListener("visibilitychange", back); window.removeEventListener("focus", back); };
  }, [load]);
  if (!api.profile) {
    return (
      <div className="page">
        <PageHeader title="Your account" lede="This deployment uses a service token, so there is no personal Not Organic profile here." />
        <div className="profile-prefs"><ThemeToggle labelled /><SoundToggle /></div>
        {onDisconnect && <Button onClick={onDisconnect}>{disconnectLabel}</Button>}
      </div>
    );
  }
  const profile = state.status === "ready" ? state.profile : null;
  return (
    <div className="page profile-page">
      <PageHeader title="Your account" lede="Your name, handle and picture come from Not Organic. Ephyra shows them; it does not change them." />
      <Card title="Profile" actions={
        <Button size="sm" loading={state.status === "ready" && state.refreshing} onClick={() => void load(true)}>Refresh from Not Organic</Button>}>
        {state.status === "error" ? (
          <Notice tone="warn" title={describeError(state.error).title} body="Your profile could not be read from Not Organic. Your session and workspace access are unchanged."
            actions={<Button size="sm" onClick={() => void load(true)}>Reload profile</Button>} />
        ) : (
          <PersonIdentity did={profile?.did ?? principal ?? ""} profile={profile} loading={state.status === "loading"}
            avatarUrl={profile?.avatar && api.avatarUrl ? api.avatarUrl(profile.did) : null} size={64} />
        )}
        {profile?.status === "unavailable" && (
          <p className="muted">Not Organic did not return a verified profile for this session. Sign in again, or set your name and handle in the portal.</p>
        )}
        <div className="profile-manage">
          {profile?.manageUrl ? (
            <>
              <a className="ui-button ui-button--primary" href={profile.manageUrl} target="_blank" rel="noopener noreferrer"
                onClick={() => { left.current = true; }}>
                Edit name, handle and picture in Not Organic <span aria-hidden="true">↗</span>
              </a>
              <p className="muted">Opens the Not Organic portal in a new tab. When you come back, this page reads your profile again.</p>
            </>
          ) : state.status === "ready" ? (
            <p className="muted">This deployment does not know its Not Organic portal address, so it cannot link to profile editing.</p>
          ) : null}
        </div>
      </Card>
      <Card tone="quiet" title="Preferences" meta="Saved in this browser only.">
        <div className="profile-prefs">
          <ThemeToggle labelled />
          <SoundToggle />
        </div>
      </Card>
      <Card tone="quiet" title="Session">
        <dl className="profile-facts">
          <div><dt>Signed in with</dt><dd>Not Organic</dd></div>
          {workspaceName && <div><dt>Current workspace</dt><dd>{workspaceName}{workspaceRole ? ` · ${workspaceRole}` : ""}</dd></div>}
        </dl>
        <div className="profile-manage">
          {onDisconnect && <Button onClick={onDisconnect} disabled={disconnectLabel === "Signing out…"}>{disconnectLabel}</Button>}
          <a href="/auth/login?setup=1">Update account permissions</a>
        </div>
      </Card>
    </div>
  );
}
