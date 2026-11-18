import { useCallback, useRef, useState } from "react";
import type { AreaSketch } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, Empty, PageHeader, Segmented, Skeleton } from "../kit.ts";
import { ApplicationMap } from "../components/ApplicationMap.tsx";
import { DraftEditor } from "../components/DraftEditor.tsx";
import { WorkspaceAsk } from "../components/WorkspaceAsk.tsx";
import { DocList, DraftList } from "../components/DocList.tsx";
import { Load } from "../components/Load.tsx";
import { describeError } from "../lib/errors.ts";
import { newOp } from "../lib/hooks.ts";
import { blockingDraft, changesLabel, pendingChanges, reusableDraft } from "../lib/policy-board.ts";
import type { DraftView, PolicyDocView } from "../api.ts";
import "./WorkspacePage.css";

const AUTONOMY = "autonomy.md";
type View = "map" | "raw";
const VIEWS: Array<{ id: View; label: string }> = [{ id: "map", label: "Map" }, { id: "raw", label: "Raw" }];

/** Thrown when someone opened and worked in a draft of the document after this page loaded. */
class DraftInTheWay extends Error {
  constructor() {
    super("A draft of autonomy.md was opened while you were editing. Continue that draft, or discard it first. Your edits here were not saved.");
  }
}
/** Thrown when asking Velum for a draft would leave unsaved edits behind. */
class UnsavedEdits extends Error {
  constructor() {
    super("Review and publish your edits here, or discard them, then ask Velum for a draft.");
  }
}
const explain = (error: unknown) =>
  error instanceof DraftInTheWay
    ? { title: "A draft is already open", body: error.message, kind: "other" as const }
    : error instanceof UnsavedEdits
      ? { title: "You have unsaved edits", body: error.message, kind: "other" as const }
      : describeError(error);

/**
 * The workspace opens on the policy board: your areas, and how much the agents may do in each. Change the board right
 * here, or the raw document behind it; either way the edits go into a draft, where they are reviewed and published.
 * Ask Velum in plain words to draft a change, or drop into the documents for detail.
 */
export function WorkspacePage({
  canDraft = true,
  onOpenDraft = (id: string) => {
    location.hash = `#/workspace/${id}`;
  },
}: {
  canDraft?: boolean;
  onOpenDraft?: (id: string) => void;
}) {
  const api = useApi();
  const map = useAsync(() => api.doc(AUTONOMY), "ws:map");
  const docs = useAsync(() => api.docs(), "ws:docs");
  const drafts = useAsync(() => api.drafts(), "ws:drafts");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [view, setView] = useState<View>("map");
  const [working, setWorking] = useState<AreaSketch[] | null>(null);
  const [rawDirty, setRawDirty] = useState(false);
  const [stageError, setStageError] = useState<unknown>(null);
  // The draft a save created or adopted. A save that failed after this point retries into the same draft.
  const staged = useRef<DraftView | null>(null);
  const [stagedId, setStagedId] = useState<string | null>(null);
  const onRawDirty = useCallback((dirty: boolean) => setRawDirty(dirty), []);

  const openDraft = async (path: string): Promise<string> => {
    const open = (await api.drafts("open")).find((d) => d.path === path);
    return open ? open.id : (await api.createDraft(path, newOp())).id;
  };
  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    setError(null);
    try {
      onOpenDraft(await fn());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const published = map.state.status === "ready" ? map.state.data : null;
  const sketches = published?.sketches ?? [];
  const pending = pendingChanges(sketches, working);
  const dirty = pending > 0 || rawDirty;
  const draftList = drafts.state.status === "ready" ? drafts.state.data : null;
  // An open draft that someone worked in owns the document: inline edits would overwrite its map.
  const blocking = published && draftList ? blockingDraft(draftList, AUTONOMY, published) : null;
  const inTheWay = blocking && blocking.id !== stagedId ? blocking : null;
  // Until the drafts are known, nothing new may be started; edits already under way stay editable.
  const editable = canDraft && published !== null && !inTheWay && (draftList !== null || dirty);

  /**
   * Put an edit into a draft and go there. The draft is opened once: an untouched open draft is reused, otherwise a new
   * one is created. A failure keeps the local edits; nothing is shown as saved.
   */
  const stage = async (doc: PolicyDocView, write: (draft: DraftView) => Promise<DraftView>) => {
    let target = staged.current;
    if (!target) {
      const open = await api.drafts("open");
      if (blockingDraft(open, AUTONOMY, doc)) {
        drafts.reload();
        throw new DraftInTheWay();
      }
      target = reusableDraft(open, AUTONOMY, doc) ?? (await api.createDraft(AUTONOMY, newOp()));
      staged.current = target;
      setStagedId(target.id);
    }
    await write(target);
    onOpenDraft(target.id);
  };
  const publishMap = async () => {
    if (!published || !working) return;
    setBusy("stage");
    setStageError(null);
    try {
      await stage(published, (draft) => api.updateSketches(draft.id, working, draft.baseDigest, newOp()));
    } catch (e) {
      setStageError(e);
    } finally {
      setBusy(null);
    }
  };
  /** Rejects on failure so the editor keeps the text and shows why. */
  const saveRaw = async (doc: PolicyDocView, text: string) => {
    setBusy("stage");
    setStageError(null);
    try {
      await stage(doc, (draft) => api.updateContent(draft.id, text, draft.baseDigest, newOp()));
    } catch (e) {
      setStageError(e);
      throw e;
    } finally {
      setBusy(null);
    }
  };

  /** Rejects on failure so the composer keeps the words. */
  const send = async (text: string) => {
    if (dirty) {
      const unsaved = new UnsavedEdits();
      setError(unsaved);
      throw unsaved;
    }
    setBusy("ask");
    setError(null);
    try {
      const id = await openDraft(AUTONOMY);
      await api.sendMessage(id, text, newOp());
      onOpenDraft(id);
    } catch (e) {
      setError(e);
      throw e;
    } finally {
      setBusy(null);
    }
  };
  const failure = error ? explain(error) : null;
  const stageFailure = stageError ? explain(stageError) : null;
  const header = (
    <PageHeader
      title="Workspace"
      lede="Describe your application and how much the agents may do in each part. Velum drafts the policy; you publish it."
    />
  );

  // A connected repository always has policy documents, even before setup writes its own. None means no repository,
  // and an unconnected workspace has no policy: nothing here may pass for one.
  if (docs.state.status === "ready" && docs.state.data.length === 0)
    return (
      <div className="page">
        {header}
        <Card tone="tray" title="Your application">
          <Empty
            title="No repository connected"
            body={"The map shows your repository's autonomy policy. Connect a repository and setup reads it, "
              + "or drafts one from what it finds there. Until then the agents do nothing."}
            action={<a href="#/onboarding" className="ui-button ui-button--sm ui-button--primary">Connect a repository</a>}
          />
        </Card>
      </div>
    );

  return (
    <div className="page">
      {header}
      <Card
        title="Your application"
        meta={editable
          ? "The policy in effect. Open an area to change it; edits are reviewed in a draft before they are published."
          : "The policy in effect."}
        tone="tray"
        actions={
          <fieldset className="ws-view" disabled={dirty || busy === "stage"}>
            <Segmented label="Policy view" name="ws-view" value={view} onChange={setView} options={VIEWS} />
          </fieldset>
        }
      >
        <div className="stack">
          {dirty && (
            <p className="muted ws-note">
              {view === "map"
                ? "Review and publish, or discard, these edits before switching to the raw document."
                : "Save or revert these edits before switching to the map."}
            </p>
          )}
          {inTheWay && (
            <div className="ws-locked">
              <p>
                A draft of <span className="mono">{AUTONOMY}</span> is already open, so the policy is read-only here.
                Make your changes in that draft.
              </p>
              <Button size="sm" disabled={busy !== null} onClick={() => onOpenDraft(inTheWay.id)}>Continue the draft</Button>
            </div>
          )}
          <Load state={map.state} retry={map.reload} skeleton={<Skeleton block />}>
            {(doc) =>
              view === "map" ? (
                <>
                  <ApplicationMap
                    sketches={working ?? doc.sketches ?? []}
                    original={editable || working ? (doc.sketches ?? []) : undefined}
                    onChange={editable && busy !== "stage" ? setWorking : undefined}
                    revision={doc.digest}
                  />
                  {pending > 0 && (
                    <div className="ws-changes" role="group" aria-label="Unpublished edits">
                      <strong>{changesLabel(pending)}</strong>
                      <span className="muted">Not saved yet.</span>
                      <Button variant="primary" size="sm" loading={busy === "stage"} disabled={busy !== null || Boolean(inTheWay)}
                        onClick={() => void publishMap()}>
                        Review and publish
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy === "stage"}
                        onClick={() => { setWorking(null); setStageError(null); }}>
                        Discard
                      </Button>
                    </div>
                  )}
                  {stageFailure && (
                    <p role="alert">
                      <strong>{stageFailure.title}.</strong> {stageFailure.body}
                    </p>
                  )}
                </>
              ) : (
                <DraftEditor
                  path={doc.path}
                  content={doc.content}
                  warnings={doc.warnings}
                  readOnly={!editable}
                  saveLabel="Save to a draft"
                  cleanLabel={editable ? "No edits" : "Read-only"}
                  onSave={(text) => saveRaw(doc, text)}
                  onDirtyChange={onRawDirty}
                />
              )
            }
          </Load>
          {stageFailure?.kind === "unknown-outcome" && stagedId && (
            <p className="ws-locked">
              <span>Your edits are still here. Draft <span className="mono">{stagedId}</span> may or may not hold them.</span>
              <a href={`#/workspace/${stagedId}`} className="ui-button ui-button--sm ui-button--secondary">Open the draft to check</a>
            </p>
          )}
          <WorkspaceAsk canDraft={canDraft} busy={busy === "ask"} failure={failure} onDraft={(text) => send(text)} />
        </div>
      </Card>
      <Card tone="quiet" title="Drafts">
        <Load state={drafts.state} retry={drafts.reload} skeleton={<Skeleton lines={3} />}>
          {(list) => <DraftList drafts={list} />}
        </Load>
      </Card>
      <Card
        tone="quiet"
        title="Documents"
        meta="The files behind the map, for detail: autonomy, thresholds and intents."
      >
        <Load state={docs.state} retry={docs.reload} skeleton={<Skeleton lines={4} />}>
          {(list) => (
            <DocList
              docs={list}
              canDraft={canDraft && !dirty}
              busyPath={busy?.startsWith("doc:") ? busy.slice(4) : null}
              onDraft={(path) => void run(`doc:${path}`, () => openDraft(path))}
            />
          )}
        </Load>
      </Card>
    </div>
  );
}
