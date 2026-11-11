import { useEffect, useRef, useState, type ReactNode } from "react";
import type { InvestigationQuestion } from "@ephyra/core";
import { ApiError, UnknownWriteOutcome, type ConsoleApi } from "../api.ts";
import { useAsync } from "../app/useAsync.ts";
import { Button, Field, Tag } from "../kit.ts";
import { Load } from "./Load.tsx";
import { forgetQuestionAnswer, pendingQuestionAnswers, questionScope, rememberQuestionAnswer } from "./question-pending.ts";
import "./InvestigationQuestions.css";

export const questionStatus = (question: InvestigationQuestion): string => {
  if (question.status === "awaiting_answer" && question.answer) return "Checking the saved answer";
  if (question.status === "answered") return question.answer?.accepted ? "Answer accepted for investigation" : "Answer acceptance unconfirmed";
  return { checking: "Checking the question", awaiting_answer: "Waiting for an answer",
    rejected: "Check did not pass", ambiguous: "Outcome needs reconciliation", superseded: "Quest moved on" }[question.status];
};

export function InvestigationQuestions({ api, principal, workspace, trailId, compact }: {
  api: ConsoleApi; principal: string; workspace: string; trailId?: string;
  /** Inside a quest: render nothing when this quest has no questions, instead of an empty global panel. */
  compact?: boolean;
}) {
  const scope = questionScope(principal, workspace);
  const questions = useAsync(async () => {
    const current = await api.questions();
    const unresolved: string[] = [];
    for (const pending of pendingQuestionAnswers(scope)) {
      const exact = await api.question(pending.trailId, pending.id).catch(() => null);
      if (!exact) { unresolved.push(pending.id); continue; }
      if (exact.answer || exact.status === "superseded") forgetQuestionAnswer(scope, pending.id);
      const existing = current.findIndex((item) => item.id === exact.id);
      if (existing === -1) current.push(exact); else current[existing] = exact;
    }
    return { current, unresolved };
  }, `${scope}:${trailId ?? "all"}`);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== "hidden") questions.reload(); };
    addEventListener("focus", refresh);
    return () => removeEventListener("focus", refresh);
  }, [questions.reload]);
  const relevant = questions.state.status === "ready"
    ? questions.state.data.current.some((q) => !trailId || q.trailId === trailId) || questions.state.data.unresolved.length > 0
    : true;
  if (compact && questions.state.status !== "error" && !relevant) return null;
  return <section className="investigation-questions" aria-label="Investigation questions">
    <div className="question-heading"><div><h2>Questions from Ephyra</h2>
      <p className="account-hint">Factual questions that can unblock an investigation. Each question and answer is checked.</p>
    </div><Button size="sm" variant="ghost" onClick={questions.reload}>Refresh questions</Button></div>
    <Load state={questions.state} retry={questions.reload}>{({ current, unresolved }) => <>
      {unresolved.length > 0 && <p role="status" className="account-feedback" data-tone="warning">
        An earlier answer is still unconfirmed. Its exact record is unavailable; no answer was resent. Refresh to check again.
      </p>}
      {current.filter((question) => !trailId || question.trailId === trailId).map((question) => (
        <QuestionEntry key={`${scope}:${question.id}`} api={api} principal={principal} scope={scope} initial={question} />
      ))}
      {!current.some((question) => !trailId || question.trailId === trailId) && <p className="account-hint">No investigation questions are waiting here.</p>}
    </>}</Load>
  </section>;
}

export function QuestionRecord({ question, children }: { question: InvestigationQuestion; children?: ReactNode }) {
  const checked = [...question.checks].reverse().find((check) => check.phase === "question");
  const answerCheck = [...question.checks].reverse().find((check) => check.phase === "answer");
  return <article className="question-record">
    <div className="account-saved"><Tag>{questionStatus(question)}</Tag>
      <span>{question.recipient?.alias ?? "No recipient selected"}</span></div>
    <h3>{question.question || "Ephyra is preparing a question."}</h3>
    <p className="account-hint">{checked ? `Question check: ${checked.accepted ? "accepted" : "not accepted"}.`
      : "No completed question check is recorded."}</p>
    <p className="account-hint">{question.delivery.kind === "inbox" ? "Inbox" : "Delivery bridge"} · {
      { not_sent: "not sent", sent: "sent", uncertain: "delivery unconfirmed" }[question.delivery.status]
    }</p>
    {question.answer && <section className="question-answer" aria-label="Recorded answer">
      <strong>Recorded answer</strong><p>{question.answer.text}</p>
      <small>{question.answer.by} · {question.answer.at}</small>
      <p className="account-hint">{question.answer.accepted ? "Accepted as evidence for further investigation."
        : answerCheck && !answerCheck.accepted ? "The answer check did not accept this evidence." : "Acceptance has not been confirmed."}</p>
    </section>}
    {children}
    <details className="question-debug"><summary>Why this question and what was checked</summary>
      <dl><div><dt>Why Ephyra needs this</dt><dd>{question.reason}</dd></div>
        <div><dt>A useful answer supplies</dt><dd>{question.acceptance}</dd></div>
        <div><dt>Bound revision</dt><dd>{question.bound.rev} · <code>{question.bound.head}</code></dd></div>
        <div><dt>Delivery receipt</dt><dd>{question.delivery.receipt ?? "No external receipt recorded"}</dd></div></dl>
      {question.checks.map((check, index) => <details key={index}>
        <summary>{check.phase === "question" ? "Question" : "Answer"} check · {check.accepted ? "accepted" : "not accepted"}</summary>
        <p>Model: <code>{check.model}</code></p>
        <pre>{JSON.stringify({ request: check.request, response: check.response }, null, 2)}</pre>
      </details>)}
    </details>
    <a href={`#/inbox/${encodeURIComponent(question.trailId)}`}>Inspect this quest →</a>
  </article>;
}

function QuestionEntry({ api, principal, scope, initial }: {
  api: ConsoleApi; principal: string; scope: string; initial: InvestigationQuestion;
}) {
  const [question, setQuestion] = useState(initial);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(() => pendingQuestionAnswers(scope).some((pending) => pending.id === initial.id));
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState<string>();
  const active = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    setQuestion(initial);
    if (initial.answer || initial.status === "superseded") {
      forgetQuestionAnswer(scope, initial.id); setUncertain(false); setText("");
    }
  }, [initial, scope]);
  const canAnswer = question.recipient?.did === principal && question.status === "awaiting_answer" && !question.answer;
  const apply = (value: InvestigationQuestion) => {
    setQuestion(value);
    if (value.answer || value.status === "superseded") {
      forgetQuestionAnswer(scope, value.id); setUncertain(false); setText("");
    } else setUncertain(pendingQuestionAnswers(scope).some((pending) => pending.id === value.id));
  };
  async function refresh() {
    if (active.current) return;
    active.current = true; setBusy(true);
    try {
      const value = await api.question(question.trailId, question.id);
      if (!live.current) return;
      if (!value) { setMessage("The exact question record is unavailable. Nothing was resent."); return; }
      apply(value); setStale(false);
      setMessage(value.answer ? "The recorded answer is shown below." : uncertain
        ? "No completed answer is recorded yet. Nothing was resent; check again after the service recovers."
        : "Latest question loaded. Review it before answering.");
    } catch { if (live.current) setMessage("The recorded question could not be reached. Nothing was resent."); }
    finally { active.current = false; if (live.current) setBusy(false); }
  }
  async function submit() {
    if (active.current || uncertain || stale || !canAnswer || !text.trim()) return;
    active.current = true; setBusy(true); setMessage(undefined);
    const operationKey = `question-${crypto.randomUUID()}`;
    rememberQuestionAnswer(scope, { id: question.id, trailId: question.trailId, operationKey });
    try {
      const value = await api.answerQuestion(question.trailId, question.id, { text: text.trim() }, operationKey);
      if (!live.current) return;
      apply(value);
      if (!value.answer && value.status !== "superseded") setUncertain(true);
      setMessage(value.answer ? value.answer.accepted ? "Answer saved and accepted for further investigation."
        : "Answer saved. Review the recorded check below." : "The service has not returned a recorded answer. Nothing will be resent.");
    } catch (error) {
      if (!live.current) return;
      if (error instanceof UnknownWriteOutcome) {
        setUncertain(true);
        setMessage("The answer may have been saved. Refresh its exact record before doing anything else; it will not be resent automatically.");
      } else {
        forgetQuestionAnswer(scope, question.id);
        setStale(error instanceof ApiError && error.status === 409);
        setMessage(error instanceof ApiError && error.detail ? error.detail : "The answer could not be saved. Refresh the question and review it.");
      }
    } finally { active.current = false; if (live.current) setBusy(false); }
  }
  return <QuestionRecord question={question}>
    {canAnswer ? <form className="account-form" aria-label="Answer investigation question" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field label="Your answer" hint="Share the missing fact. Answers add evidence; they do not grant permissions or approve code.">
        <textarea rows={3} maxLength={4000} required value={text} disabled={busy || uncertain || stale}
          onChange={(event) => setText(event.target.value)} />
      </Field>
      <div className="account-actions"><Button type="submit" variant="primary" loading={busy} disabled={busy || uncertain || stale || !text.trim()}>
        Send answer
      </Button></div>
    </form> : question.recipient?.did !== principal && <p className="account-hint">This question is addressed to another recipient.</p>}
    {(uncertain || stale || message) && <div className="account-feedback" data-tone={uncertain || stale ? "warning" : "quiet"} role="status">
      <p>{message ?? "An earlier answer is unconfirmed. Read its exact record; no answer will be resent."}</p>
      <Button size="sm" disabled={busy} onClick={() => void refresh()}>Refresh recorded question</Button>
    </div>}
  </QuestionRecord>;
}
