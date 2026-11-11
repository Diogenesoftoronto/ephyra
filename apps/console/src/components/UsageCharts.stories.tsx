import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { UsageForecast, UsageSummary } from "@ephyra/core";
import { FakeApi } from "../fake/api.ts";
import { CostDrivers, OutcomesCoverage, SpendPace } from "./UsageCharts.tsx";

const meta: Meta = { title: "Usage/Charts" };
export default meta;
function useUsage() {
  const [u, setU] = useState<UsageSummary | null>(null);
  useEffect(() => { void new FakeApi().usage().then(setU); }, []);
  return u;
}
const today = (u: UsageSummary) => u.byDay.at(-1)!.key;
export const Pace: StoryObj = { render: () => { const u = useUsage(); return u ? <SpendPace days={u.byDay} today={today(u)} /> : <p>Loading fixture</p>; } };
export const PaceWithForecast: StoryObj = {
  render: () => {
    const u = useUsage();
    if (!u) return <p>Loading fixture</p>;
    const last = u.byDay.at(-2)!.key;
    const forecast: Extract<UsageForecast, { status: "ok" }> = {
      status: "ok",
      engine: "clairic-fixture (not a live model)",
      requestedModel: "extraction",
      operationKey: "story",
      pNull: 0.04,
      receipt: { tokens: 400, costMicrousd: 41 },
      basis: {
        from: u.byDay[0]!.key,
        to: last,
        completeDays: 28,
        daysWithPricedSpend: 6,
        pricedEntries: 60,
        unknownCostEntries: 20,
        failedEntries: 9,
        excludedPartialDay: today(u),
      },
      days: Array.from({ length: 7 }, (_, i) => ({
        day: new Date(Date.parse(`${last}T00:00:00Z`) + (i + 1) * 86_400_000).toISOString().slice(0, 10),
        median: 1_300_000,
        p10: 800_000,
        p90: 2_000_000,
      })),
    };
    return <SpendPace days={u.byDay} today={today(u)} forecast={forecast} />;
  },
};
export const Drivers: StoryObj = {
  render: () => {
    const u = useUsage();
    return u ? <CostDrivers title="Engine" groups={u.byEngine} onSelect={() => {}} /> : <p>Loading fixture</p>;
  },
};
export const Outcomes: StoryObj = {
  render: () => {
    const u = useUsage();
    return u ? <OutcomesCoverage days={u.byDay} totals={u.totals} today={today(u)} /> : <p>Loading fixture</p>;
  },
};
export const Empty: StoryObj = { render: () => <CostDrivers title="Persona" groups={[]} /> };
