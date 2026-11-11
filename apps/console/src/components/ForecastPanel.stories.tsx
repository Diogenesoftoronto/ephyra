import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiProvider } from "../app/ApiContext.tsx";
import { FakeApi } from "../fake/api.ts";
import type { ForecastMode } from "../fake/assist.ts";
import { STORY_NOW } from "../fake/fixtures.ts";
import { ForecastPanel } from "./ForecastPanel.tsx";

const meta: Meta = { title: "Usage/Forecast", parameters: { docs: { description: { component: "Fixture forecasts only. No provider is contacted; select Forecast spend to see each outcome." } } } };
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
