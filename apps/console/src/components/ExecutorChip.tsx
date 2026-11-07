import type { AgentRun } from "@ephyra/core";

export const EXECUTOR_LABEL: Record<AgentRun["executor"]["kind"], string> = {
  orb: "Amp orb",
  runner: "Amp runner",
  local: "Local process",
  railway: "Railway sandbox",
  notorganic: "Not Organic sandbox",
};

/** Where a run executed: the kind, the orb, runner or sandbox id, and the project. */
export function ExecutorChip({ executor }: { executor: AgentRun["executor"] }) {
  const detail = [executor.id, executor.project].filter(Boolean).join(" · ");
  return (
    <span>
      {EXECUTOR_LABEL[executor.kind]}
      {detail ? (
        <>
          {" "}
          <span className="mono">{detail}</span>
        </>
      ) : null}
    </span>
  );
}
