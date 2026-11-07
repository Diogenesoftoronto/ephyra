import { useState } from "react";
import { useApi } from "../app/ApiContext.tsx";
import { useAsync } from "../app/useAsync.ts";
import { Button, Card, Field, PageHeader, Skeleton } from "../kit.ts";
import { ApplicationMap } from "../components/ApplicationMap.tsx";
import { DocList, DraftList } from "../components/DocList.tsx";
import { Load } from "../components/Load.tsx";
import { describeError } from "../lib/errors.ts";
import { newOp } from "../lib/hooks.ts";
import "./WorkspacePage.css";

const AUTONOMY = "autonomy.md";

/**
 * The workspace opens on the application map: your areas, and how much the agents may do in each. Ask Velum in plain
 * words to change it, edit the cards in a draft, or drop into the documents for detail.
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
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

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
  const send = () =>
    run("ask", async () => {
      const id = await openDraft(AUTONOMY);
      await api.sendMessage(id, ask.trim(), newOp());
      return id;
    });
  const failure = error ? describeError(error) : null;

  return (
    <div className="page">
      <PageHeader
        title="Workspace"
        lede="Describe your application and how much the agents may do in each part. Velum drafts the policy; you publish it."
      />
      <Card
        title="Your application"
        meta="The policy in effect, as a map. Edit it in a draft."
        tone="tray"
        actions={
          <Button
            loading={busy === "edit"}
            disabled={!canDraft || busy !== null}
            onClick={() => void run("edit", () => openDraft(AUTONOMY))}
          >
            Edit the map
          </Button>
        }
      >
        <div className="stack">
          <Load state={map.state} retry={map.reload} skeleton={<Skeleton block />}>
            {(doc) => <ApplicationMap sketches={doc.sketches ?? []} />}
          </Load>
          <form
            className="ws-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (ask.trim() && canDraft) void send();
            }}
          >
            <Field
              label="Ask Velum"
              hint="In plain words, e.g. “Payments should never land without me; the marketing site can fix itself.”"
            >
              <textarea
                rows={2}
                value={ask}
                maxLength={2000}
                onChange={(e) => setAsk(e.target.value)}
                disabled={!canDraft}
              />
            </Field>
            <Button
              variant="primary"
              loading={busy === "ask"}
              disabled={!canDraft || busy !== null || ask.trim() === ""}
              onClick={() => void send()}
            >
              Ask Velum
            </Button>
          </form>
          {!canDraft && <p className="muted">Only approvers can start drafts.</p>}
          {failure && (
            <p role="alert">
              <strong>{failure.title}.</strong> {failure.body}
            </p>
          )}
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
              canDraft={canDraft}
              busyPath={busy?.startsWith("doc:") ? busy.slice(4) : null}
              onDraft={(path) => void run(`doc:${path}`, () => openDraft(path))}
            />
          )}
        </Load>
      </Card>
    </div>
  );
}
