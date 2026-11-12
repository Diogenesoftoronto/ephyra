import { useState } from "react";
import type { AccountSettings, MirrorUpdate } from "@ephyra/core";
import type { AccountApi } from "../account-api.ts";
import { Button, Field, Tag } from "../kit.ts";
import { AccountSaveFeedback } from "./AccountForms.tsx";
import { useAccountWrite } from "./useAccountWrite.ts";
import "./MirrorsForm.css";

const PROPOSAL: Record<string, string> = {
  github: "GitHub pull requests", gitlab: "GitLab merge requests", forgejo: "Forgejo pull requests",
  tangled: "Tangled pulls", radicle: "Radicle patches",
};

/** Where `pull_request` landings go for this repository, in words, or why they cannot go anywhere yet. */
export function proposalTarget(settings: AccountSettings): { ready: boolean; text: string } {
  const repository = settings.repository;
  if (!repository) return { ready: false, text: "Connect a repository first." };
  const kind = repository.forge?.kind ?? "git";
  if (kind === "radicle") return { ready: true, text: "Radicle patches, opened by this server's own Radicle identity when it has one." };
  if (kind === "tangled") return { ready: true, text: "Tangled pulls." };
  if (kind === "git") return { ready: false, text: "This host has no pull request API Ephyra knows, so pull requests park for you." };
  if (!repository.credentialConfigured)
    return { ready: false, text: `${PROPOSAL[kind]}, once you save an access token that can open them.` };
  return { ready: true, text: `${PROPOSAL[kind]}.` };
}

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function MirrorsForm({ api, settings, onChange }: { api: AccountApi; settings: AccountSettings;
  onChange: (settings: AccountSettings) => void }) {
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const write = useAccountWrite(api, onChange);
  const mirrors = settings.mirrors ?? [];
  const target = proposalTarget(settings);
  if (!settings.repository) return null;
  return (
    <section className="account-form mirrors" aria-label="Mirrors and pull requests">
      <div className="mirrors__target">
        <h3>Pull requests</h3>
        <p><Tag>{target.ready ? "Ready" : "Not yet"}</Tag> {target.text}</p>
      </div>
      <h3>Mirrors</h3>
      <p className="account-hint">
        When Ephyra moves the base branch, it pushes the same commit to each mirror that is behind. A mirror with commits of its
        own is left alone and shown here. Radicle and Tangled are kept in step by your own <code>git push</code>.
      </p>
      {mirrors.length === 0 ? <p className="mirrors__empty">No mirrors.</p> : (
        <ul className="mirrors__list">
          {mirrors.map((mirror) => (
            <li key={mirror.id} className="mirrors__item">
              <div className="mirrors__address">
                <strong>{mirror.host}</strong>
                <code>{mirror.url}</code>
                <small data-status={mirror.last?.status ?? "none"}>
                  {mirror.last
                    ? `${mirror.last.status === "ok" ? "Up to date" : "Failed"} · ${when(mirror.last.at)} · ${mirror.last.detail}`
                    : "Not pushed yet."}
                  {mirror.credentialConfigured ? " Token saved." : ""}
                </small>
              </div>
              <Button size="sm" variant="ghost" disabled={write.locked} aria-label={`Remove mirror ${mirror.host}`}
                onClick={() => void write.save({ expectedVersion: settings.version, id: mirror.id },
                  (value, key) => api.removeMirror(value, key), "Mirror removed.")}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {mirrors.length < 5 && (
        <form className="mirrors__add" aria-label="Add a mirror" onSubmit={async (event) => {
          event.preventDefault();
          const input: MirrorUpdate = { expectedVersion: settings.version, url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}) };
          if (await write.save(input, (value, key) => api.saveMirror(value, key), "Mirror added.")) { setUrl(""); setToken(""); }
        }}>
          <fieldset className="account-fields" disabled={write.locked}>
            <Field label="Mirror address" hint="HTTPS. GitHub, GitLab or a Forgejo host. Codeberg is not allowed: it forbids AI-generated code.">
              <input type="url" required maxLength={2048} autoCapitalize="none" spellCheck={false} value={url}
                placeholder="https://github.com/team/project" onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Access token (optional)" hint="Needs permission to push to the base branch. It is never shown again.">
              <input type="password" autoComplete="new-password" maxLength={8192} value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
            <Button type="submit" size="sm">Add mirror</Button>
          </fieldset>
        </form>
      )}
      <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
    </section>
  );
}
