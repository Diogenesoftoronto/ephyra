import { useEffect, useState } from "react";
import type { AreaSketch, Draft } from "@ephyra/core";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { useDraftSession } from "../app/useDraftSession.ts";
import { VelumThread } from "../assistant/VelumThread.tsx";
import { Badge, Button, Card, PageHeader, Segmented, Skeleton } from "../kit.ts";
import { ApplicationMap } from "../components/ApplicationMap.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { DraftEditor } from "../components/DraftEditor.tsx";
import { Load } from "../components/Load.tsx";
import { PublishBar } from "../components/PublishBar.tsx";
import { changedCount, diffSketches } from "../lib/sketch-diff.ts";
import { describeError } from "../lib/errors.ts";
import { newOp, useMediaQuery } from "../lib/hooks.ts";
import "./DraftPage.css";

type Tab = "map" | "document" | "changes" | "chat";

/**
 * A draft: chat with Velum, the application map, the generated document and what would change, then apply and publish.
 * Wide screens keep the chat beside the work; narrow screens make it a tab.
 */
export function DraftPage({
  draftId,
  canPublish = true,
  onOpenDraft = (id: string) => {
    location.hash = `#/workspace/${id}`;
  },
}: {
  draftId: string;
  canPublish?: boolean;
  onOpenDraft?: (id: string) => void;
}) {
  const api = useApi();
  const s = useDraftSession(api, draftId);
  return (
    <div className="page">
      <p className="draft-back">
        <a href="#/workspace">← Workspace</a>
      </p>
      <Load state={s.state} retry={s.reload} skeleton={<Skeleton block />}>
        {(draft) => <DraftBody draft={draft} s={s} canPublish={canPublish} onOpenDraft={onOpenDraft} />}
      </Load>
    </div>
  );
}

function DraftBody({
  draft,
  s,
  canPublish,
  onOpenDraft,
}: {
  draft: Draft;
  s: ReturnType<typeof useDraftSession>;
  canPublish: boolean;
  onOpenDraft: (id: string) => void;
}) {
  const api = useApi();
  const wide = useMediaQuery("(min-width: 1000px)");
  const hasMap = draft.kind === "autonomy";
  const [tab, setTab] = useState<Tab>(hasMap ? "map" : "document");
  const open = draft.status === "open";
  const [dirty, setDirty] = useState(false);
  const tabs: Array<{ id: Tab; label: string }> = [
    ...(hasMap ? [{ id: "map" as const, label: "Map" }] : []),
    { id: "document", label: "Document" },
    { id: "changes", label: "Changes" },
    ...(wide ? [] : [{ id: "chat" as const, label: "Velum" }]),
  ];
  const active: Tab = tabs.some((t) => t.id === tab) ? tab : tabs[0]!.id;
  const startOver = async () => {
    onOpenDraft((await api.createDraft(draft.path, newOp())).id);
  };

  const chat = (
    <VelumThread
      messages={draft.messages}
      pending={s.pending}
      busy={s.pending !== undefined}
      failure={s.failure}
      disabled={!open || !canPublish || dirty}
      disabledReason={
        dirty
          ? "Save or discard your edits to continue with Velum."
          : !open
            ? "This draft is closed."
            : undefined
      }
      currentContent={draft.content}
      currentSketches={s.draftMap ?? undefined}
      onSend={async (t) => {
        await s.send(t);
      }}
      onApplyProposal={s.applyProposal}
      formHost={s.formHost}
      ideas={hasMap ? undefined : ["Add a sentence about guest checkout."]}
    />
  );

  return (
    <>
      <PageHeader
        title={<span className="mono">{draft.path}</span>}
        lede="A draft. Nothing changes in production until you publish and it lands."
        actions={
          <Badge tone={draft.status === "open" ? "info" : draft.status === "published" ? "ok" : "neutral"}>
            {draft.status}
          </Badge>
        }
      />
      <div className="draft-layout" data-wide={wide}>
        <div className="draft-main stack">
          <fieldset className="draft-tabs" disabled={dirty}>
            <Segmented
              label="Draft views"
              value={active}
              onChange={(id) => setTab(id as Tab)}
              options={tabs}
            />
          </fieldset>
          {dirty && (
            <p className="muted">
              Save or discard these edits before switching views or applying a proposal.
            </p>
          )}
          {active === "map" && (
            <MapTab draft={draft} s={s} editable={open && canPublish} onDirtyChange={setDirty} />
          )}
          {active === "document" && (
            <DraftEditor
              path={draft.path}
              content={draft.content}
              warnings={draft.warnings}
              readOnly={!open || !canPublish}
              onSave={s.saveContent}
              onDirtyChange={setDirty}
            />
          )}
          {active === "changes" && <ChangesTab draft={draft} />}
          {active === "chat" && (
            <Card tone="quiet" title="Velum">
              {chat}
            </Card>
          )}
          <PublishBar
            unsaved={dirty}
            draft={draft}
            canPublish={canPublish}
            onPublish={s.publish}
            onDiscard={s.discard}
            onStartOver={() => void startOver()}
          />
        </div>
        {wide && (
          <aside className="draft-chat" aria-label="Velum">
            <Card tone="quiet" title="Velum">
              {chat}
            </Card>
          </aside>
        )}
      </div>
    </>
  );
}

function MapTab({
  draft,
  s,
  editable,
  onDirtyChange,
}: {
  draft: Draft;
  s: ReturnType<typeof useDraftSession>;
  editable: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [working, setWorking] = useState<AreaSketch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    onDirtyChange(Boolean(working));
    return () => onDirtyChange(false);
  }, [working, onDirtyChange]);
  const saved = s.draftMap;
  if (!saved) return <Skeleton block />;
  const sketches = working ?? saved;
  const pending = working ? changedCount(diffSketches(saved, working)) : 0;
  const save = async () => {
    if (!working) return;
    setBusy(true);
    setError(null);
    try {
      await s.saveMap(working);
      setWorking(null);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const failure = error ? describeError(error) : null;
  return (
    <div className="stack">
      <p className="muted">
        Areas marked “changed” differ from the policy in effect. Level, risk and paths are mapped to concrete
        settings by the server.
      </p>
      <ApplicationMap
        sketches={sketches}
        original={s.liveMap ?? undefined}
        onChange={editable ? setWorking : undefined}
      />
      {editable && (
        <div className="draft-map-actions">
          <Button
            variant="primary"
            loading={busy}
            disabled={!working || pending === 0}
            onClick={() => void save()}
          >
            {pending
              ? `Save ${pending} change${pending === 1 ? "" : "s"} to the draft`
              : "No unsaved changes"}
          </Button>
          {working && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setWorking(null);
                setError(null);
              }}
            >
              Discard edits
            </Button>
          )}
        </div>
      )}
      {failure && (
        <p role="alert">
          <strong>{failure.title}.</strong> {failure.body}
        </p>
      )}
      {draft.warnings.length > 0 && (
        <p className="muted">
          The document has {draft.warnings.length} parser warning{draft.warnings.length === 1 ? "" : "s"}; see
          the Document tab.
        </p>
      )}
    </div>
  );
}

function ChangesTab({ draft }: { draft: Draft }) {
  const api = useApi();
  const doc = useAsync(() => api.doc(draft.path), `doc:${draft.path}`);
  return (
    <Load state={doc.state} retry={doc.reload} skeleton={<Skeleton lines={5} />}>
      {(live) => (
        <div className="stack">
          {live.digest !== draft.baseDigest && (
            <Card tone="alert" title="The live document changed">
              <p role="alert">
                It changed after this draft started, so publishing will be refused. The diff below is against
                the live document.
              </p>
            </Card>
          )}
          <DiffView
            before={live.content}
            after={draft.content}
            label={`Changes to ${draft.path}`}
            context={3}
          />
        </div>
      )}
    </Load>
  );
}
