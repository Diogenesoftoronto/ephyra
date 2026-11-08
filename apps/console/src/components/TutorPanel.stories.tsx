import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within, waitFor } from "storybook/test";
import type { TutorInput, TutorReply } from "@ephyra/core";
import { TutorPanel } from "./TutorPanel.tsx";
import { FakeApi } from "../fake/api.ts";
import { ApiProvider } from "../app/ApiContext.tsx";
import { VoiceProvider } from "../voice/Voice.tsx";
import { VoiceRequestError } from "../api.ts";
import { eventsFor, trailByShort } from "../storybook/data.ts";

const trail = trailByShort("c2d018"),
  events = eventsFor("c2d018");
class TutorFixture extends FakeApi {
  constructor(private readonly mode: string) {
    super();
  }
  override async tutorCapabilities() {
    if (this.mode === "loading") await new Promise(() => {});
    return this.mode === "unavailable"
      ? super.tutorCapabilities()
      : { provider: "notorganic" as const, model: "ampersand-tutor-v0.1", maxCostMicrousd: 100000 };
  }
  override async explainTrail(input: TutorInput, op: string, signal: AbortSignal): Promise<TutorReply> {
    signal.throwIfAborted();
    if (this.mode === "thinking") await new Promise(() => {});
    if (this.mode === "uncertain")
      throw new VoiceRequestError(
        "reconciliation_required",
        "The provider disconnected before its outcome was known. Check Usage before asking again.",
      );
    return {
      text: "The recorded tests passed for this revision. That establishes the tested behavior; it does not establish production behavior.\n\n" +
        "Approving checkpoint C lets Ephyra attempt the configured landing after its server checks. It does not mean a landing has already happened. " +
        "Which remaining uncertainty would you want to resolve before deciding?",
      bound: input.bound,
      stale: this.mode === "stale",
      sources: [
        { label: "Recorded proof · fixture", excerpt: "Tests: 42 passed, 0 failed. Production watch has not run." },
        { label: "Open checkpoint · fixture", excerpt: "C · blocking · current revision and head" },
      ],
      receipt: {
        operationKey: op,
        engine: "ampersand-tutor-v0.1",
        requestedModel: "ampersand-tutor-v0.1",
        tokens: 180,
        costMicrousd: null,
        billedTo: "notorganic",
      },
    };
  }
}
function Fixture({ mode = "ready", canSpend = true }: { mode?: string; canSpend?: boolean }) {
  const api = useMemo(() => new TutorFixture(mode), [mode]);
  return (
    <ApiProvider api={api}>
      <VoiceProvider
        api={api}
        context={{ kind: "trail", id: trail.id }}
        label={trail.short}
        scopeKey={mode}
        canSpend={canSpend}
      >
        <p className="muted">
          Storybook fixture. No provider calls, recordings or charges. Voice opens a text conversation when speech is
          unavailable.
        </p>
        <TutorPanel trail={trail} events={events} canSpend={canSpend} />
      </VoiceProvider>
    </ApiProvider>
  );
}
const meta: Meta = { title: "Components/TutorPanel" };
export default meta;
const explain: StoryObj["play"] = async ({ canvasElement }) => {
  const button = await within(canvasElement).findByRole("button", { name: "Explain this quest" });
  // Availability is asynchronous; wait for the real component to enable the control.
  await waitFor(() => {
    if ((button as HTMLButtonElement).disabled) throw new Error("Loading");
  });
  await userEvent.click(button);
};
export const Ready: StoryObj = { render: () => <Fixture /> };
export const Loading: StoryObj = { render: () => <Fixture mode="loading" /> };
export const Unavailable: StoryObj = { render: () => <Fixture mode="unavailable" /> };
export const ReadOnly: StoryObj = { render: () => <Fixture canSpend={false} /> };
export const Thinking: StoryObj = { render: () => <Fixture mode="thinking" />, play: explain };
export const Explained: StoryObj = { render: () => <Fixture />, play: explain };
export const Stale: StoryObj = { render: () => <Fixture mode="stale" />, play: explain };
export const Uncertain: StoryObj = { render: () => <Fixture mode="uncertain" />, play: explain };
export const Dark: StoryObj = { render: () => <Fixture />, play: explain, parameters: { theme: "dark" } };
