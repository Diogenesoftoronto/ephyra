import { useEffect, useRef, useState } from "react";
import { Button, Field } from "../kit.ts";
import { detectRepositorySource, listGitHubRepositories, REPOSITORY_SOURCES, type RepositoryChoice, type RepositorySource } from "../lib/repository-picker.ts";
import "./RepositoryPicker.css";

export function RepositoryPicker({ value, disabled, onSelect, onSource }: {
  value: string; disabled: boolean; onSelect: (repository: RepositoryChoice) => void; onSource: (placeholder: string) => void;
}) {
  const [source, setSource] = useState<RepositorySource>(detectRepositorySource(value) ?? "github");
  const [owner, setOwner] = useState("");
  const [repos, setRepos] = useState<RepositoryChoice[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const active = useRef<AbortController | null>(null);
  const ownerInput = useRef<HTMLInputElement>(null);
  const entry = REPOSITORY_SOURCES.find(item => item.id === source)!;
  useEffect(() => {
    const detected = detectRepositorySource(value);
    if (detected) setSource(detected);
  }, [value]);
  useEffect(() => { onSource(entry.placeholder); }, [entry.placeholder, onSource]);
  useEffect(() => () => active.current?.abort(), []);
  const cancel = () => {
    active.current?.abort(); active.current = null;
    setBusy(false); setRepos([]); setMessage(""); setError(false); setPage(0); setMore(false);
  };
  async function search(nextPage = 1) {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(false); setMessage("");
    if (nextPage === 1) setRepos([]);
    try {
      const found = await listGitHubRepositories(owner.trim(), nextPage, controller.signal);
      if (active.current !== controller) return;
      setRepos(current => nextPage === 1 ? found : [...current, ...found]);
      setPage(nextPage); setMore(found.length === 30);
      setMessage(found.length
        ? `${found.length} public repositories loaded. Choose one to fill in its address.`
        : "No public repositories found. You can paste a private repository link below.");
    } catch (cause) {
      if (active.current !== controller || controller.signal.aborted) return;
      setError(true); setMessage(cause instanceof Error ? cause.message : "Lookup failed. Paste a repository link below.");
      ownerInput.current?.focus();
    } finally { if (active.current === controller) setBusy(false); }
  }
  return <div className="repository-picker">
    <div className="repository-sources" role="group" aria-label="Repository platform">
      {REPOSITORY_SOURCES.map(item => <button key={item.id} type="button" disabled={disabled} aria-pressed={source === item.id}
        onClick={() => { cancel(); setSource(item.id); }}>
        <span className="repository-source-mark" style={{ maskImage: `url(/app/brand/${item.id}.svg)` }} aria-hidden="true" />
        {item.name}
      </button>)}
    </div>
    <div className="repository-platform-help">
      <a href={entry.home} target="_blank" rel="noreferrer">Open {source === "git" ? "Radicle" : entry.name} <span aria-hidden="true">↗</span></a>
      <span>Choose a repository there, then paste its link below.</span>
    </div>
    {source === "github" && <details className="repository-discovery">
      <summary>Find a public GitHub repository</summary>
      <div className="repository-lookup">
        <Field label="GitHub username or organization" error={error ? message : undefined}>
          <input ref={ownerInput} value={owner} maxLength={39} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder="octocat" disabled={disabled} onChange={e => { cancel(); setOwner(e.target.value); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (!busy && !disabled) void search(); } }} />
        </Field>
        <Button type="button" disabled={disabled || busy} loading={busy} onClick={() => void search()}>Find repositories</Button>
      </div>
      <p className="account-hint" role="status">{!error ? message : ""}</p>
      {repos.length > 0 && <ul className="repository-results" aria-label="Public GitHub repositories">
        {repos.map(repo => <li key={repo.url}><button type="button" disabled={disabled} onClick={() => {
          onSelect(repo); setMessage(`${repo.name} selected. Connect it below to verify access.`);
        }} aria-pressed={value === repo.url}>
          <strong>{repo.name}</strong><span>{repo.description || repo.branch}</span>
          {value === repo.url && <span className="repository-selected">Selected ✓</span>}
        </button></li>)}
      </ul>}
      {more && <Button size="sm" disabled={busy || disabled} onClick={() => void search(page + 1)}>Load more repositories</Button>}
    </details>}
  </div>;
}
