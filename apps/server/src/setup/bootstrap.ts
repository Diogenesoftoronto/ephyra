import { createHash } from "node:crypto";
import { BootstrapAssessment, BootstrapCoverage, type BootstrapRequest, type SetupRun } from "@ephyra/core";
import { redact } from "@ephyra/agent";
import type { Git } from "../wiring/landing.ts";
import type { SetupCapability } from "./automation.ts";

export const bootstrapDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceDigest = (value: string) => createHash("sha256").update(value).digest("hex");
type Source = BootstrapAssessment["sources"][number];

function sourceKind(path: string): Source["kind"] | null {
  if (/(^|\/)(readme|agents|contributing)\.md$/i.test(path)) return "documentation";
  if (/^(docs|design)\/[^/]+\.md$/i.test(path)) return "documentation";
  if (/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod)$/i.test(path)) return "manifest";
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path) || /(^|\/)(\.gitlab-ci\.yml|\.buildkite\/pipeline\.yml)$/.test(path)) return "ci";
  if (/(^|\/)[^/]*(posthog|opentelemetry|otel|instrumentation)[^/]*\.(ts|js|json|ya?ml|toml)$/i.test(path)) return "telemetry";
  if (/(^|\/)(railway\.(json|toml)|vercel\.json|fly\.toml|dockerfile)$/i.test(path)) return "deployment";
  return null;
}

/** Read data from the pinned commit only. No hooks, package scripts, filters or repository instructions execute. */
export async function inspectBootstrapSources(git: Git, head: string, files: string[], secrets: string[] = []): Promise<Source[]> {
  const ordered = files.filter((path) => path.length <= 500 && !/[\0\r\n]/.test(path) && sourceKind(path)
    && redact(path, secrets, 600) === path)
    .sort((a, b) => {
      const priority = (path: string) => /^(README\.md|AGENTS\.md|package\.json)$/i.test(path) ? 0 : path.split("/").length;
      return priority(a) - priority(b) || a.localeCompare(b);
    });
  // A documentation-heavy repository must not crowd CI, telemetry or deployment hints out of the bounded read set.
  const kinds: Source["kind"][] = ["documentation", "manifest", "ci", "telemetry", "deployment"];
  const candidates = kinds.flatMap((kind) => ordered.filter((path) => sourceKind(path) === kind).slice(0, 4));
  for (const path of ordered) {
    if (candidates.length >= 20) break;
    if (!candidates.includes(path)) candidates.push(path);
  }
  const sources: Source[] = [];
  for (const path of candidates) {
    try {
      const size = Number((await git(["cat-file", "-s", `${head}:${path}`])).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > 48_000) continue;
      const content = await git(["show", `${head}:${path}`]);
      if (Buffer.byteLength(content) > 48_000 || content.includes("\0")) continue;
      sources.push({ path, commit: head, digest: sourceDigest(content), kind: sourceKind(path)!,
        excerpt: redact(content, secrets, 6000).slice(0, 6000) });
    } catch { /* Unreadable, oversized and non-text sources cannot establish context. */ }
  }
  return sources;
}

function defaults(run: SetupRun, capabilities: SetupCapability[], at: string): BootstrapCoverage[] {
  const available = (id: string) => capabilities.some((item) => item.id === id && item.available);
  let baseline = false;
  try {
    const receipt = JSON.parse(run.artifacts.find((item) => item.path === "ephyra/provisioning.json")?.content ?? "null");
    baseline = receipt?.head === run.repository.head && receipt.verification === true
      && (receipt.cleanup?.status === "destroyed" || receipt.cleanup?.destroyed === true);
  } catch { /* Invalid receipts are not observed checks. */ }
  return [
    { id: "repository", status: "observed", summary: `Repository paths and bounded source context inspected at ${run.repository.head}.`,
      checkedAt: at, references: run.bootstrap?.sources.map((source) => `${source.commit}:${source.path}`) ?? [] },
    { id: "checks", status: baseline ? "observed" : available("verification") ? "configured" : "missing",
      summary: baseline ? "Pinned baseline checks and sandbox cleanup have recorded receipts. Repair proof is still required."
        : "Repository commands are candidates until pinned baseline checks and cleanup are observed.",
      checkedAt: at, references: baseline ? ["ephyra/provisioning.json"] : ["ephyra/verification.json"] },
    { id: "telemetry", status: available("telemetry") ? "configured" : "missing",
      summary: "A configured connection does not establish observed ingestion, environment attribution or application coverage.", references: [] },
    { id: "deployment", status: available("landing") && available("watch") ? "configured" : "unknown",
      summary: "The currently deployed repository, branch and full revision have not been observed by this assessment.", references: [] },
    { id: "knowledge", status: "unknown",
      summary: "External knowledge coverage has not been observed. Repository documentation remains untrusted context.", references: [] },
    { id: "contact", status: "unknown", summary: "An authorized owner contact route has not been observed by this assessment.", references: [] },
  ];
}

/** Deterministic gap requests retain answers without allowing text to grant authority or mark a connection verified. */
export function assessBootstrap(run: SetupRun, capabilities: SetupCapability[], extra: BootstrapCoverage[], at: string, nextAt: string): BootstrapAssessment {
  const previous = run.bootstrap?.setupId === run.id && run.bootstrap.head === run.repository.head ? run.bootstrap : undefined;
  const coverage = defaults(run, capabilities, at).map((fallback) => {
    const supplied = extra.filter((item) => item.id === fallback.id);
    return supplied.length === 1 ? BootstrapCoverage.parse(supplied[0]) : fallback;
  });
  const requests: BootstrapRequest[] = [];
  const add = (key: string, value: Pick<BootstrapRequest, "kind" | "question" | "options" | "gap" | "action">) => {
    const id = bootstrapDigest(["bootstrap-request-v1", run.id, run.repository.head, key]);
    const prior = previous?.requests.find((request) => request.id === id);
    requests.push({ id, ...value, status: prior?.status === "answered" ? "answered" : "open",
      createdAt: prior?.createdAt ?? at, updatedAt: prior?.status === "resolved" ? at : prior?.updatedAt ?? at,
      ...(prior?.answer ? { answer: prior.answer } : {}) });
  };
  for (const capability of capabilities.filter((item) => !item.available)) add(`capability:${capability.id}`, {
    kind: "configuration", gap: capability.id, question: capability.summary, action: capability.action, options: [],
  });
  const coverageActions: Record<BootstrapCoverage["id"], string> = {
    repository: "Reconnect the repository and run setup against its current commit.",
    checks: "Run the discovered checks in the isolated workspace and retain baseline and cleanup receipts.",
    telemetry: "Connect scoped telemetry, verify a queried window, and identify missing instrumentation.",
    deployment: "Connect a deployment endpoint that reports this repository, branch and full Git revision.",
    knowledge: "Select relevant knowledge sources, or record which product facts live only in the repository.",
    contact: "Enable an authorized owner inbox or an authenticated delivery bridge.",
  };
  for (const item of coverage.filter((entry) => entry.status !== "observed")) {
    const matching = item.id === "checks" ? "verification" : item.id === "deployment" ? "watch" : item.id;
    if (capabilities.some((capability) => capability.id === matching && !capability.available)) continue;
    add(`coverage:${item.id}`, { kind: "configuration", gap: item.id,
      question: `${item.id[0]!.toUpperCase()}${item.id.slice(1)} coverage needs verification. ${item.summary}`,
      action: coverageActions[item.id], options: [] });
  }
  add("critical-journey", { kind: "context", question: "Which user journey matters most, and what should happen when it succeeds or fails?",
    action: "Describe expected behavior and point to an example or requirement. This is context, not permission to change the product.",
    options: ["Sign-in and account access", "Creating or changing core data", "Billing and subscription changes"] });
  for (const old of previous?.requests ?? []) {
    if (!requests.some((request) => request.id === old.id)) requests.push({ ...old, status: "resolved",
      updatedAt: old.status === "resolved" ? old.updatedAt : at });
  }
  return BootstrapAssessment.parse({ schema: 1, setupId: run.id, head: run.repository.head, assessedAt: at, nextAssessmentAt: nextAt,
    sources: previous?.sources ?? [], coverage, requests: requests.slice(0, 40), contextReports: previous?.contextReports ?? [] });
}
