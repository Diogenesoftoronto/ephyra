import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { UsageForecast, UsageForecastInput } from "@ephyra/core";
import { ApiProvider } from "../app/ApiContext.tsx";
import { UnknownWriteOutcome } from "../api.ts";
import { FakeApi } from "../fake/api.ts";
import type { ForecastMode } from "../fake/assist.ts";
import { STORY_NOW } from "../fake/fixtures.ts";
import { ForecastPanel } from "./ForecastPanel.tsx";

const meta: Meta = {
  title: "Usage/Forecast",
  parameters: {
    docs: {
      description: {
        component: "Fixture forecasts only. No provider is contacted; select Forecast spend to see each outcome.",
      },
    },
  },
};
export default meta;
const story = (forecast: ForecastMode): StoryObj => ({
  render: () => <ApiProvider api={new FakeApi({ forecast })}><ForecastPanel now={STORY_NOW} scope={`story-${forecast}`} onForecast={() => {}} /></ApiProvider>,
});
export const NotConfigured = story("unavailable");
export const Ready = story("ok");
export const InsufficientHistory = story("insufficient");
export const Pending = story("hang");
export const UnknownOutcome = story("uncertain");
export const RateLimitedWithRetryAfter = story("rate-limited");
export const RateLimitedNoRetryAfter = story("rate-limited-unknown");
export const MalformedAnswer = story("error");

class LostAcknowledgementApi extends FakeApi {
  original: { input: UsageForecastInput; op: string } | null = null;
  override async forecast(input: UsageForecastInput, op: string, signal: AbortSignal): Promise<UsageForecast> {
    if (!this.original) {
      this.original = { input: structuredClone(input), op };
      await super.forecast(input, op, signal);
      throw new UnknownWriteOutcome(op);
    }
    if (op !== this.original.op || JSON.stringify(input) !== JSON.stringify(this.original.input)) {
      throw new Error("Fixture: recovery changed the original request.");
    }
    return super.forecast(input, op, signal);
  }
}
function RecoverAcrossMidnight() {
  const [api] = useState(() => new LostAcknowledgementApi({ forecast: "ok" }));
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(STORY_NOW);
  return <ApiProvider api={api}>
    <p>Fictional provider: the first result is saved but its acknowledgement is lost. Recovery must keep its exact dates, horizon and request key.</p>
    <button type="button" className="ui-button" onClick={() => {
      if (open) setOpen(false);
      else { setNow((n) => n + 86_400_000); setOpen(true); }
    }}>{open ? "Leave forecast page" : "Return the next UTC day"}</button>
    {open && <ForecastPanel now={now} scope="story-midnight-recovery" onForecast={() => {}} />}
  </ApiProvider>;
}
export const RecoverOriginalRequestNextDay: StoryObj = { render: () => <RecoverAcrossMidnight /> };
