import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { BootstrapAssessment, BootstrapResponse, SetupRun } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import type { SetupApi } from "../setup-api.ts";
import { useAsync } from "../app/useAsync.ts";
import { Button, Field, Tag } from "../kit.ts";
import { Load } from "./Load.tsx";
import "./BootstrapSetup.css";

type BootstrapRequest = BootstrapAssessment["requests"][number];
export type PendingBootstrapAnswer = Pick<BootstrapResponse, "setupId" | "head" | "requestId"> & { operationKey: string };
export const bootstrapScope = (principal: string, workspace: string) => `ephyra.bootstrap.pending:${JSON.stringify([principal, workspace])}:`;
const pendingKey = (scope: string, value: PendingBootstrapAnswer) => `${scope}${JSON.stringify([value.setupId, value.head, value.requestId])}`;

export function pendingBootstrapAnswers(scope: string): PendingBootstrapAnswer[] {
  const pending: PendingBootstrapAnswer[] = [];
  try {
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(scope)) continue;
      try {
        const value = JSON.parse(sessionStorage.getItem(key)!);
        if (typeof value.setupId === "string" && /^[a-f0-9]{32}$/.test(value.setupId)
          && typeof value.head === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.head)
          && typeof value.requestId === "string" && /^[a-f0-9]{64}$/.test(value.requestId)
          && typeof value.operationKey === "string" && /^[A-Za-z0-9:._-]{8,160}$/.test(value.operationKey)
          && key === pendingKey(scope, value)) {
          pending.push({ setupId: value.setupId, head: value.head, requestId: value.requestId, operationKey: value.operationKey });
        }
      } catch { /* Invalid local references never authorize an answer. */ }
    }
  } catch { /* The mounted form retains its own uncertain state when storage is unavailable. */ }
  return pending;
}

export function rememberBootstrapAnswer(scope: string, value: PendingBootstrapAnswer) {
  try {
    const metadata = { setupId: value.setupId, head: value.head, requestId: value.requestId, operationKey: value.operationKey };
    sessionStorage.setItem(pendingKey(scope, metadata), JSON.stringify(metadata));
  } catch { /* Memory only. Answer content is never stored here. */ }
}
export function forgetBootstrapAnswer(scope: string, value: PendingBootstrapAnswer) {
  try { sessionStorage.removeItem(pendingKey(scope, value)); } catch { /* Memory only. */ }
}
export function bootstrapAnswerRecorded(run: SetupRun | null, pending: PendingBootstrapAnswer): boolean {
  return run?.id === pending.setupId && run.repository.head === pending.head
    && run.bootstrap?.setupId === pending.setupId && run.bootstrap.head === pending.head
    && run.bootstrap.requests.some((request) => request.id === pending.requestId && request.answer?.operationKey === pending.operationKey) === true;
}
export function bootstrapAnswerSuperseded(current: SetupRun | null, exact: SetupRun | null, pending: PendingBootstrapAnswer): boolean {
  const question = exact?.bootstrap?.requests.find(request => request.id === pending.requestId);
  return Boolean(current && current.id !== pending.setupId && exact?.id === pending.setupId && exact.repository.head === pending.head
    && exact.bootstrap?.setupId === pending.setupId && exact.bootstrap.head === pending.head && question && !question.answer);
}

const coverageLabels = {
  repository: "Repository", checks: "Repository checks", telemetry: "Error telemetry",
  deployment: "Deployed revision", knowledge: "Product context", contact: "Contact",
};
const statusLabels = {
  observed: "Observed", configured: "Connected, awaiting observation", missing: "Needs a connection", unknown: "Unverified",
};
const timestamp = (value: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC") : value;
};

/** Read-only coverage also appears on the setup screen. Each status describes its own evidence. */
export function BootstrapCoverage({ assessment, compact = false }: { assessment: BootstrapAssessment; compact?: boolean }) {
  return <section className="bootstrap-coverage" aria-label="Repository observation coverage">
    <dl className="bootstrap-coverage-list" data-compact={compact || undefined}>
      {assessment.coverage.map((coverage) => <div key={coverage.id} data-status={coverage.status}>
        <dt>{coverageLabels[coverage.id]}</dt>
        <dd><Tag>{statusLabels[coverage.status]}</Tag><p>{coverage.summary}</p>
          {!compact && coverage.checkedAt && <small>Checked <time dateTime={coverage.checkedAt}>{timestamp(coverage.checkedAt)}</time></small>}
          {!compact && coverage.references.length > 0 && <details>
            <summary>Inspect references</summary>
            <ul>{coverage.references.map((reference, index) => <li key={index}><code>{reference}</code></li>)}</ul>
          </details>}
        </dd>
      </div>)}
    </dl>
  </section>;
}

export function BootstrapAssessmentView({ run, children }: { run: SetupRun; children?: ReactNode }) {
  const assessment = run.bootstrap;
  if (!assessment) return <div className="bootstrap-empty">
    <p>Repository setup is {run.status}. Its observation assessment has not been recorded yet.</p>
    <a href="#/onboarding">Follow repository setup</a>
  </div>;
  return <>
    <p className="bootstrap-bound">{run.repository.branch} · <code title={assessment.head}>{assessment.head.slice(0, 12)}</code></p>
    <BootstrapCoverage assessment={assessment} />
    <p className="bootstrap-timestamp">Assessed <time dateTime={assessment.assessedAt}>{timestamp(assessment.assessedAt)}</time>.
      {" "}Next check <time dateTime={assessment.nextAssessmentAt}>{timestamp(assessment.nextAssessmentAt)}</time>.</p>
    {children}
    {assessment.contextReports.length > 0 && <details className="bootstrap-sources">
      <summary>Submitted application context ({assessment.contextReports.length} reports)</summary>
      {assessment.contextReports.map((report) => <article className="bootstrap-context-report" key={report.id}>
        <p className="account-hint">{report.kind === "agent" ? "Agent" : "Owner"}: {report.by} · {timestamp(report.at)}</p>
        <p>{report.summary}</p>
        {report.journeys?.map((journey, index) => <div key={index}>
          <h3>{journey.name}</h3><p>{journey.expectedBehavior}</p>
          {journey.evidencePaths.length > 0 && <ul>{journey.evidencePaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
        </div>)}
      </article>)}
    </details>}
    <details className="bootstrap-sources">
      <summary>What Ephyra read ({assessment.sources.length} sources)</summary>
      <p>Repository text is recorded as context. Source files and owner answers do not grant authority or prove a check passed.</p>
      {assessment.sources.map((source) => <details key={`${source.path}:${source.digest}`}>
        <summary><code>{source.path}</code></summary>
        <p>Commit <code>{source.commit}</code></p>
        <p>Digest <code>{source.digest}</code></p>
        <pre>{source.excerpt}</pre>
      </details>)}
    </details>
  </>;
}

export function BootstrapSetup(props: { api: SetupApi; principal: string; workspace: string }) {
  return <BootstrapWorkspace key={JSON.stringify([props.principal, props.workspace])} {...props} />;
}

function BootstrapWorkspace({ api, principal, workspace }: { api: SetupApi; principal: string; workspace: string }) {
  const scope = bootstrapScope(principal, workspace);
  const epoch = useMemo(() => crypto.randomUUID(), [api, scope]);
  const currentEpoch = useRef(epoch);
  currentEpoch.current = epoch;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const active = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { active.current = null; setBusy(false); setMessage(undefined); }, [epoch]);
  const setup = useAsync(async () => {
    const run = await api.current();
    const unresolved: PendingBootstrapAnswer[] = [];
    let superseded = 0;
    for (const pending of pendingBootstrapAnswers(scope)) {
      const exact = run?.id === pending.setupId ? run : await api.record?.(pending.setupId).catch(() => null) ?? null;
      if (bootstrapAnswerRecorded(exact, pending)) forgetBootstrapAnswer(scope, pending);
      else if (bootstrapAnswerSuperseded(run, exact, pending)) { forgetBootstrapAnswer(scope, pending); superseded++; }
      else unresolved.push(pending);
    }
    return { run, unresolved, superseded };
  }, epoch);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") setup.reload(); };
    addEventListener("focus", refresh);
    const interval = setInterval(refresh, 60_000);
    return () => { removeEventListener("focus", refresh); clearInterval(interval); };
  }, [setup.reload]);

  async function reassess() {
    if (!api.reassess || active.current) return;
    const ownEpoch = epoch;
    active.current = ownEpoch; setBusy(true); setMessage(undefined);
    try {
      await api.reassess(`bootstrap-check:${crypto.randomUUID()}`);
      if (mounted.current && currentEpoch.current === ownEpoch) { setup.reload(); setMessage("The saved connections were checked again."); }
    } catch (error) {
      if (mounted.current && currentEpoch.current === ownEpoch) {
        setMessage(error instanceof UnknownWriteOutcome ? "The check may have completed. Refresh the saved assessment to confirm it."
          : "The connections could not be rechecked. Refresh the saved assessment.");
      }
    } finally {
      if (active.current === ownEpoch) active.current = null;
      if (mounted.current && currentEpoch.current === ownEpoch) setBusy(false);
    }
  }
  return <section className="bootstrap-setup" aria-labelledby="bootstrap-heading">
    <div className="bootstrap-heading"><div><h2 id="bootstrap-heading">Getting to know your application</h2>
      <p>Ephyra checks what it can see and asks for missing context before an error arrives.</p>
    </div><Button size="sm" variant="ghost" disabled={busy} onClick={setup.reload}>Refresh assessment</Button></div>
    <Load state={setup.state} retry={setup.reload}>{({ run, unresolved, superseded }) => <>
      {superseded > 0 && <p role="status" className="account-hint">
        An earlier request belongs to a previous setup. Its saved record has no answer; nothing was resent.
      </p>}
      {unresolved.length > 0 && <div className="account-feedback" data-tone="warning" role="status">
        <p>An earlier setup answer is still unconfirmed. Ephyra has not resent it. Only a matching saved answer clears its pending reference.</p>
        <Button size="sm" disabled={busy} onClick={setup.reload}>Check recorded answers</Button>
      </div>}
      {run ? <BootstrapAssessmentView run={run}>
        {run.bootstrap && <div className="bootstrap-requests" aria-label="Setup requests">
          {run.bootstrap.requests.filter((request) => request.kind === "context").map((request) =>
            <BootstrapQuestion key={`${epoch}:${run.id}:${run.repository.head}:${request.id}`} api={api} scope={scope}
              run={run} request={request} onChange={setup.reload} />)}
          {run.bootstrap.requests.some((request) => request.kind === "configuration") && <details className="bootstrap-connections" open>
            <summary>Connections Ephyra needs ({run.bootstrap.requests.filter((request) =>
              request.kind === "configuration" && request.status === "open").length} open)</summary>
            {run.bootstrap.requests.filter((request) => request.kind === "configuration").map((request) => <article key={request.id}>
              <div className="account-saved"><Tag>{request.status === "resolved" ? "Request resolved" : "Needs a connection"}</Tag></div>
              <h3>{request.question}</h3><p>{request.action}</p>
              {request.status !== "resolved" && <a href="#/settings">Open connection settings</a>}
            </article>)}
          </details>}
          {!run.bootstrap.requests.some((request) => request.status === "open") && <p className="account-hint">
            No setup questions are waiting. Ephyra will reassess the recorded coverage.
          </p>}
        </div>}
      </BootstrapAssessmentView> : <div className="bootstrap-empty">
        <p>Connect a repository and start setup so Ephyra can inspect the application and prepare its first questions.</p>
        <a href="#/onboarding">Open repository setup</a>
      </div>}
      {run?.bootstrap && api.reassess && <div className="account-actions">
        <Button size="sm" disabled={busy} loading={busy} onClick={() => void reassess()}>Recheck connections</Button>
        <a href="#/onboarding">Inspect setup progress</a>
      </div>}
    </>}</Load>
    {message && <p role="status" className="account-hint">{message}</p>}
  </section>;
}

function BootstrapQuestion({ api, scope, run, request, onChange }: {
  api: SetupApi; scope: string; run: SetupRun; request: BootstrapRequest; onChange: () => void;
}) {
  const headingId = useId();
  const pending = () => pendingBootstrapAnswers(scope).find((value) => value.setupId === run.id
    && value.head === run.repository.head && value.requestId === request.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(() => Boolean(pending()));
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string>();
  const active = useRef(false);
  const live = useRef(true);
  const ownPending = useRef<PendingBootstrapAnswer | undefined>(pending());
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    setStale(false);
    if (ownPending.current && bootstrapAnswerRecorded(run, ownPending.current)) {
      forgetBootstrapAnswer(scope, ownPending.current); ownPending.current = undefined;
      setUncertain(false); setText(""); setMessage("Your answer is recorded as application context.");
    }
  }, [run, scope]);
  const canAnswer = request.status === "open" && !request.answer && Boolean(api.respond);
  async function submit() {
    if (!api.respond || active.current || uncertain || stale || !canAnswer || !text.trim()) return;
    active.current = true; setBusy(true); setMessage(undefined);
    const metadata = { setupId: run.id, head: run.repository.head, requestId: request.id, operationKey: `bootstrap-answer:${crypto.randomUUID()}` };
    ownPending.current = metadata; rememberBootstrapAnswer(scope, metadata);
    try {
      const saved = await api.respond({ setupId: run.id, head: run.repository.head, requestId: request.id, text: text.trim() }, metadata.operationKey);
      if (!bootstrapAnswerRecorded(saved, metadata)) throw new UnknownWriteOutcome(metadata.operationKey);
      forgetBootstrapAnswer(scope, metadata); ownPending.current = undefined;
      if (live.current) { setUncertain(false); setText(""); setMessage("Your answer is recorded as application context."); onChange(); }
    } catch (error) {
      if (error instanceof UnknownWriteOutcome) {
        if (live.current) {
          setUncertain(true);
          setMessage("Your answer may have been saved. Refresh the recorded assessment before continuing; it will not be resent.");
        }
      } else {
        forgetBootstrapAnswer(scope, metadata); ownPending.current = undefined;
        if (live.current) {
          setStale(error instanceof ApiError && error.status === 409);
          setMessage(error instanceof ApiError && error.detail ? error.detail : "The answer could not be saved. Refresh the request before answering.");
        }
      }
    } finally { active.current = false; if (live.current) setBusy(false); }
  }
  return <article className="bootstrap-question">
    <div className="account-saved"><Tag>{request.status === "answered" ? "Context recorded"
      : request.status === "resolved" ? "Resolved" : "A question for you"}</Tag></div>
    <h3 id={headingId}>{request.question}</h3>
    {request.answer && <blockquote><p>{request.answer.text}</p>
      <footer>{request.answer.kind === "agent" ? "Agent context" : "Owner context"} · {request.answer.by} · {
        <time dateTime={request.answer.at}>{timestamp(request.answer.at)}</time>
      }</footer>
    </blockquote>}
    {canAnswer && <form aria-labelledby={headingId} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {request.options.length > 0 && <fieldset className="bootstrap-suggestions" disabled={busy || uncertain || stale}>
        <legend>Use a starting point, or write your own answer</legend>
        {request.options.map((option) => <Button key={option} size="sm" variant="ghost" type="button"
          aria-pressed={text === option} onClick={() => setText(option)}>{option}</Button>)}
      </fieldset>}
      <Field label="Your answer" hint="Describe the expected behavior. Your answer is context, and does not approve code or grant permissions.">
        <textarea rows={3} maxLength={4000} required value={text} disabled={busy || uncertain || stale}
          onChange={(event) => setText(event.target.value)} />
      </Field>
      <Button type="submit" variant="primary" disabled={busy || uncertain || stale || !text.trim()} loading={busy}>Save application context</Button>
    </form>}
    {(uncertain || stale || message) && <div className="account-feedback" data-tone={uncertain || stale ? "warning" : "quiet"} role="status">
      <p>{message ?? "An earlier answer is unconfirmed. Read the saved assessment before continuing."}</p>
      {(uncertain || stale) && <Button size="sm" disabled={busy} onClick={onChange}>Refresh recorded assessment</Button>}
    </div>}
  </article>;
}
