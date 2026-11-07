import type { Runner, ServiceProfile } from "@ephyra/core";

export type RunnerRequirements = { shell?: boolean; browser?: boolean; checkpoint?: "disk" | "memory" };

export function runnerRejections(profile: ServiceProfile, runner: Runner, requirements: RunnerRequirements = {}): string[] {
  const c = runner.capabilities;
  const reasons: string[] = [];
  if (!c.network.includes(profile.network)) reasons.push(`network ${profile.network} unsupported`);
  if (requirements.shell && !c.shell) reasons.push("shell unsupported");
  if (requirements.browser && !c.browser) reasons.push("browser unsupported");
  if (requirements.checkpoint && c.checkpoint !== requirements.checkpoint &&
      !(requirements.checkpoint === "disk" && c.checkpoint === "memory")) {
    reasons.push(`checkpoint ${requirements.checkpoint} unsupported`);
  }
  return reasons;
}

export function selectRunner(profile: ServiceProfile, runners: readonly Runner[], requirements: RunnerRequirements = {}): Runner | null {
  return runners.find((runner) => runnerRejections(profile, runner, requirements).length === 0) ?? null;
}
