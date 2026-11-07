import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  type DataMessagePartProps,
} from "@assistant-ui/react";
import { createContext, useContext, type ReactNode } from "react";
import type { AreaSketch, DraftMessage } from "@ephyra/core";
import { Button, Card, Field, Notice } from "../kit.ts";
import { PersonaAvatar } from "../components/PersonaAvatar.tsx";
import { ProposalCard } from "../components/ProposalCard.tsx";
import { SpecView } from "../genui/SpecView.tsx";
import type { FormHost } from "../genui/registry.tsx";
import { describeError } from "../lib/errors.ts";
import { MarkdownText } from "./MarkdownText.tsx";
import type { FormPartData, ProposalPartData } from "./messages.ts";
import { useVelumRuntime } from "./useVelumRuntime.ts";
import { WorkingIndicator } from "./WorkingIndicator.tsx";
import "./assistant.css";
import { DictateButton, ReadAloudButton, VoiceLauncher } from "../voice/Voice.tsx";

type Ctx = {
  currentContent: string;
  currentSketches?: readonly AreaSketch[];
  disabled?: boolean;
  formHost: (messageId: string) => FormHost;
  applyProposal: (messageId: string) => Promise<void>;
};
const VelumContext = createContext<Ctx | null>(null);
const useCtx = () => {
  const c = useContext(VelumContext);
  if (!c) throw new Error("VelumThread parts need a VelumThread");
  return c;
};

/** json-render form, as a message part: validated by the catalog before it renders. */
function FormPart({ data }: DataMessagePartProps<FormPartData>) {
  const ctx = useCtx();
  return <SpecView spec={data.spec} host={ctx.formHost(data.messageId)} disabled={ctx.disabled} />;
}

function ProposalPart({ data }: DataMessagePartProps<ProposalPartData>) {
  const ctx = useCtx();
  return (
    <ProposalCard
      proposal={data}
      currentContent={ctx.currentContent}
      currentSketches={ctx.currentSketches}
      disabled={ctx.disabled}
      onApply={() => ctx.applyProposal(data.messageId)}
    />
  );
}

function VelumMessage() {
  return (
    <MessagePrimitive.Root className="thread-msg">
      <PersonaAvatar persona="velum" size={32} />
      <div className="thread-bubble">
        <MessagePrimitive.Parts
          components={{ Text: MarkdownText, data: { by_name: { form: FormPart, proposal: ProposalPart } } }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function HumanMessage() {
  return (
    <MessagePrimitive.Root className="thread-msg thread-msg-user">
      <Card tone="inset" className="thread-bubble">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </Card>
    </MessagePrimitive.Root>
  );
}

/** A system message from the server, such as "Velum is unavailable". It is shown as a notice, never as something Velum said. */
function SystemNote() {
  return (
    <MessagePrimitive.Root>
      <Notice
        tone="warn"
        title="Notice from the server"
        body={<MessagePrimitive.Parts components={{ Text: ({ text }) => <>{text}</> }} />}
      />
    </MessagePrimitive.Root>
  );
}

function PutBack({ text }: { text: string }) {
  const aui = useAui();
  return (
    <Button size="sm" onClick={() => aui.composer().setText(text)}>
      Put my message back in the box
    </Button>
  );
}

function Suggestions({ ideas }: { ideas: string[] }) {
  const aui = useAui();
  return (
    <div className="thread-suggestions">
      {ideas.map((i) => (
        <Button key={i} size="sm" onClick={() => aui.composer().setText(i)}>
          {i}
        </Button>
      ))}
    </div>
  );
}

export const DEFAULT_IDEAS = [
  "Payments should never land without me; the marketing site can fix itself.",
  "Add an area for billing.",
];

function VoiceComposer({ disabled }: { disabled?: boolean }) {
  const aui = useAui();
  return <div className="thread-voice-actions">
    <DictateButton disabled={disabled} onText={text => {
      const previous = aui.composer().getState().text;
      aui.composer().setText(previous ? `${previous.trimEnd()} ${text}` : text);
    }} />
    <VoiceLauncher compact disabled={disabled} />
  </div>;
}

type Props = {
  messages: readonly DraftMessage[];
  /** The human message being sent right now. */
  pending?: string;
  busy: boolean;
  /** Set when the last send failed; `unavailable` says the model itself is not available. */
  failure?: { error: unknown; text: string } | null;
  disabled?: boolean;
  disabledReason?: string;
  currentContent: string;
  currentSketches?: readonly AreaSketch[];
  onSend: (text: string) => Promise<void>;
  onApplyProposal: (messageId: string) => Promise<void>;
  formHost: (messageId: string) => FormHost;
  ideas?: string[];
  header?: ReactNode;
};

/**
 * The Velum chat as an assistant-ui Thread. Messages come from the draft, replies arrive from the Ephyra API, and a form
 * or proposal from Velum renders as a message part. If Velum cannot answer, the thread says so and nothing is invented.
 */
export function VelumThread(props: Props) {
  const runtime = useVelumRuntime({
    messages: props.messages,
    pending: props.pending,
    busy: props.busy,
    disabled: props.disabled,
    onSend: props.onSend,
  });
  const failure = props.failure ? describeError(props.failure.error) : null;
  const lastReply = [...props.messages].reverse().find(m => m.role === "persona");
  return (
    <VelumContext.Provider
      value={{
        currentContent: props.currentContent,
        currentSketches: props.currentSketches,
        disabled: props.disabled || props.busy,
        formHost: props.formHost,
        applyProposal: props.onApplyProposal,
      }}
    >
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.Root className="thread">
          <ThreadPrimitive.Viewport
            className="thread-viewport"
            aria-label="Conversation with Velum"
            tabIndex={0}
          >
            <ThreadPrimitive.Empty>
              <div className="thread-msg">
                <PersonaAvatar persona="velum" size={32} />
                <div className="thread-bubble">
                  <p>
                    I draft your autonomy policy with you. Tell me in plain words how much the agents may do
                    in each part of your application.
                  </p>
                  <Suggestions ideas={props.ideas ?? DEFAULT_IDEAS} />
                </div>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages
              components={{
                UserMessage: HumanMessage,
                AssistantMessage: VelumMessage,
                SystemMessage: SystemNote,
              }}
            />
            <AuiIf condition={(s) => s.thread.isRunning}>
              <WorkingIndicator />
            </AuiIf>
            {failure && (
              <Card
                tone="alert"
                title={failure.kind === "unavailable" ? "Velum is unavailable" : failure.title}
              >
                <p role="alert">
                  {failure.body}{" "}
                  {failure.kind === "unknown-outcome"
                    ? "Check the saved conversation before sending again."
                    : "No reply was received."}
                </p>
                {props.failure && failure.kind !== "unknown-outcome" && (
                  <>
                    <Card tone="inset">
                      <p className="mono">{props.failure.text}</p>
                    </Card>
                    <PutBack text={props.failure.text} />
                  </>
                )}
              </Card>
            )}
          </ThreadPrimitive.Viewport>
          {lastReply && <ReadAloudButton text={lastReply.text} label="Velum's latest reply" />}
          <ComposerPrimitive.Root className="thread-composer">
            <Field label="Message Velum" hint="Enter sends. Shift+Enter adds a line.">
              <ComposerPrimitive.Input
                rows={2}
                placeholder="e.g. Checkout should never land without me."
                disabled={props.disabled}
              />
            </Field>
            <div className="thread-composer-row">
              <VoiceComposer disabled={props.disabled || props.busy} />
              {props.disabled && (
                <span className="muted">
                  {props.disabledReason ?? "Only approvers can change the draft."}
                </span>
              )}
              <ComposerPrimitive.Send asChild>
                <Button variant="primary" disabled={props.disabled}>
                  Send
                </Button>
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </VelumContext.Provider>
  );
}
