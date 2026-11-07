import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApiError, UnknownWriteOutcome } from "../api.ts";
import { ErrorState, Load } from "./Load.tsx";

const meta = { title: "States/Load" } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { render: () => <Load state={{ status: "loading" }}>{() => null}</Load> };
export const Ready: Story = { render: () => <Load state={{ status: "ready", data: "Loaded data", refreshing: false }}>{(d) => <p>{d}</p>}</Load> };
export const Failed: Story = { render: () => <Load state={{ status: "error", error: new Error("API connection failed") }} retry={() => undefined}>{() => null}</Load> };
export const Forbidden: Story = { render: () => <ErrorState error={new ApiError(403, "this Not Organic account is not an approver on this deployment")} /> };
export const Stale: Story = { render: () => <ErrorState error={new ApiError(409, "approval is stale")} onRetry={() => undefined} /> };
export const Unavailable: Story = { render: () => <ErrorState error={new ApiError(503, "Unverified: no draft model is configured for Velum")} /> };
export const OutcomeUnknown: Story = { render: () => <ErrorState error={new UnknownWriteOutcome("op-1")} /> };
export const Dark: Story = { parameters: { theme: "dark" }, render: () => <ErrorState error={new ApiError(500)} onRetry={() => undefined} /> };
