import { useEffect, useId, useRef, useState } from "react";
import type { KnowledgeSelection, KnowledgeSourceView, KnowledgeUpdate } from "@ephyra/core";
import { Button, Field, Tag } from "../kit.ts";
import { useAsync } from "../app/useAsync.ts";
import { AccountSaveFeedback, type AccountPageProps } from "./AccountForms.tsx";
import { useAccountWrite } from "./useAccountWrite.ts";
import { eligibleKnowledgeTool, knowledgeLink, knowledgeToolKey, unavailableSelection } from "./knowledge-selection.ts";
import "./KnowledgeConnections.css";

export function KnowledgeConnections(props: AccountPageProps) {
  const scope = `${props.settings.did}:${props.settings.workspaceId}`;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  return <KnowledgeForm key={scope} {...props} onChange={(next) => {
    if (live.current && latestScope.current === scope && next.did === props.settings.did && next.workspaceId === props.settings.workspaceId) {
      props.onChange(next);
    }
  }} />;
}

function KnowledgeForm({ api, settings, onChange }: AccountPageProps) {
  const saved = settings.knowledge?.workspaceId === settings.workspaceId ? settings.knowledge : undefined;
  const enabled = saved?.enabled === true;
  const [selections, setSelections] = useState<KnowledgeSelection[]>(() => structuredClone(saved?.sources ?? []));
  const [selectionError, setSelectionError] = useState<string>();
  const write = useAccountWrite(api, onChange);
  const catalog = useAsync(() => api.knowledge(), `${settings.did}:${settings.workspaceId}:${enabled}:${saved?.updatedAt ?? ""}`);
  useEffect(() => {
    setSelections(structuredClone(saved?.sources ?? []));
    setSelectionError(undefined);
  }, [settings.version, settings.workspaceId]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") catalog.reload(); };
    addEventListener("focus", refresh);
    addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      removeEventListener("focus", refresh);
      removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [catalog.reload]);
  const data = catalog.state.status === "ready" ? catalog.state.data : null;
  const refreshingCatalog = catalog.state.status === "ready" && catalog.state.refreshing;
  const available = data?.status === "available";
  const manageUrl = knowledgeLink(data?.manageUrl);
  const authorizeUrl = knowledgeLink(data?.authorizeUrl);
  const invalid = available ? selections.filter((selection) =>
    unavailableSelection(selection, data.sources.find((source) => source.id === selection.id))) : [];
  const dirty = JSON.stringify(selections) !== JSON.stringify(saved?.sources ?? []);
  function change(id: string, next: Partial<KnowledgeSelection>) {
    const before = selections.find((selection) => selection.id === id) ?? { id, resources: false };
    const value = { ...before, ...next };
    const remaining = selections.filter((selection) => selection.id !== id);
    const values = value.resources || value.searchTool ? [...remaining, value] : remaining;
    if (values.length > 8) { setSelectionError("Choose up to eight sources for this workspace."); return; }
    setSelectionError(undefined);
    setSelections(values);
  }
  async function save(nextEnabled: boolean, sources: KnowledgeSelection[]) {
    const input: KnowledgeUpdate = {
      expectedVersion: settings.version, workspaceId: settings.workspaceId, enabled: nextEnabled, sources,
    };
    const next = await write.save(input, (value, key) => api.saveKnowledge(value, key),
      nextEnabled ? "Knowledge preferences saved." : "Knowledge disconnected from this workspace.");
    if (next) catalog.reload();
  }
  return (
    <section className="knowledge-connections" aria-label="Knowledge and MCP connections">
      <div>
        <h2>Knowledge and MCP connections</h2>
        <p className="account-hint">
          Give Ephyra the context it needs to investigate. Choose sources once, and it can read and search them automatically while working.
        </p>
      </div>
      {!enabled ? (
        <div className="knowledge-intro">
          <p>Optional. You can connect documents and research tools through your Not Organic account now or later.</p>
          <Button variant="primary" disabled={write.locked} loading={write.busy} onClick={() => void save(true, [])}>
            Connect knowledge
          </Button>
        </div>
      ) : (
        <>
          {catalog.state.status === "loading" && <p role="status" className="account-hint">Loading your available connections…</p>}
          {catalog.state.status === "error" && (
            <p role="status" className="account-feedback" data-tone="warning">
              Your connections could not be reached. Saved choices are kept. Refresh to check access before changing them.
            </p>
          )}
          {data && <p className="account-hint" role="status">{data.detail}</p>}
          {data?.status === "needs_sign_in" && authorizeUrl && (
            <a className="ui-button ui-button--primary" href={authorizeUrl}>Continue with Not Organic</a>
          )}
          {available && data.sources.length === 0 && (
            <p>No sources are available to Ephyra yet. Add a connection or allow access in Not Organic, then refresh here.</p>
          )}
          {available && data.sources.map((source) => (
            <KnowledgeSource
              key={source.id} source={source} selection={selections.find((selection) => selection.id === source.id)}
              disabled={write.locked || refreshingCatalog}
              onChange={(next) => change(source.id, next)}
            />
          ))}
          {selections.filter((selection) => !available || !data.sources.some((source) => source.id === selection.id)).map((selection) => (
            <div className="knowledge-source knowledge-source--unavailable" key={selection.id}>
              <strong>{selection.id}</strong>
              <p>{available ? unavailableSelection(selection, undefined) : "Saved connection. Current access has not been verified."}</p>
              <Button size="sm" disabled={write.locked} onClick={() => change(selection.id, { resources: false, searchTool: undefined })}>
                Remove saved source
              </Button>
            </div>
          ))}
          {selectionError && <p role="alert">{selectionError}</p>}
          {invalid.length > 0 && <p className="account-hint">Remove unavailable choices or select their current versions before saving.</p>}
          <div className="account-actions">
            <Button
              variant="primary" loading={write.busy}
              disabled={write.locked || refreshingCatalog || !dirty || invalid.length > 0 || (!available && selections.length > 0)}
              onClick={() => void save(true, selections)}
            >
              Save connections
            </Button>
            <Button variant="ghost" disabled={write.locked} onClick={() => void save(false, [])}>Disconnect knowledge</Button>
          </div>
        </>
      )}
      <AccountSaveFeedback state={write.state} onRefresh={() => void write.refresh()} />
      <div className="knowledge-management">
        {manageUrl && <a href={manageUrl} target="_blank" rel="noopener noreferrer">Manage connections in Not Organic ↗</a>}
        <Button variant="ghost" disabled={write.busy || catalog.state.status === "loading"}
          onClick={catalog.reload}>Refresh connections</Button>
        <p className="account-hint">
          Not Organic manages connection credentials and this application’s access. Disconnecting here stops Ephyra’s use for this workspace.
        </p>
      </div>
    </section>
  );
}

export function KnowledgeSource({ source, selection, disabled, onChange }: {
  source: KnowledgeSourceView; selection?: KnowledgeSelection; disabled?: boolean;
  onChange: (next: Partial<KnowledgeSelection>) => void;
}) {
  const id = useId();
  const eligible = source.tools.filter(eligibleKnowledgeTool);
  const selected = selection?.searchTool;
  const exact = selected && eligible.find((tool) => knowledgeToolKey(tool) === knowledgeToolKey(selected) && tool.queryField === selected.queryField);
  const unavailable = selection ? unavailableSelection(selection, source) : null;
  return (
    <fieldset className="knowledge-source" disabled={disabled}>
      <legend>{source.label || source.id}</legend>
      {unavailable && <p className="knowledge-unavailable" role="status">{unavailable}</p>}
      {(source.resourcesAllowed || selection?.resources) && (
        <label className="account-checkbox">
          <input type="checkbox" checked={selection?.resources ?? false} disabled={!source.resourcesAllowed && !selection?.resources}
            onChange={(event) => onChange({ resources: event.currentTarget.checked })} />
          Read shared resources{!source.resourcesAllowed ? " (access removed)" : ""}
        </label>
      )}
      {(eligible.length > 0 || selected) && (
        <Field label="Search tool" hint="Ephyra can use your chosen tool automatically during research.">
          <select value={exact ? knowledgeToolKey(exact) : selected ? "unavailable" : ""} onChange={(event) => {
            const tool = eligible.find((item) => knowledgeToolKey(item) === event.currentTarget.value);
            onChange({ searchTool: tool?.queryField ? {
              name: tool.name, definitionHash: tool.definitionHash, queryField: tool.queryField,
            } : undefined });
          }}>
            <option value="">No search tool</option>
            {selected && !exact && <option value="unavailable" disabled>Saved tool unavailable: {selected.name}</option>}
            {eligible.map((tool) => <option key={knowledgeToolKey(tool)} value={knowledgeToolKey(tool)}>{tool.name}</option>)}
          </select>
        </Field>
      )}
      {!source.resourcesAllowed && eligible.length === 0 && !selection && (
        <p className="account-hint">This connection has no supported resources or research tools available.</p>
      )}
      {source.tools.length > 0 && (
        <details className="knowledge-tool-details">
          <summary id={id}>About this connection’s tools</summary>
          <ul aria-labelledby={id}>
            {source.tools.map((tool) => (
              <li key={knowledgeToolKey(tool)}>
                <strong>{tool.name}</strong> {!eligibleKnowledgeTool(tool) && <Tag>Unavailable</Tag>}
                {tool.description && <p>{tool.description}</p>}
                {tool.unavailableReason && <p>{tool.unavailableReason}</p>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {selection && <Button variant="ghost" size="sm" onClick={() => onChange({ resources: false, searchTool: undefined })}>
        Remove saved source
      </Button>}
    </fieldset>
  );
}
