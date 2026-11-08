import type { SetupRequest, SetupRun } from "@ephyra/core";
import type { SetupApi } from "../setup-api.ts";
import { UnknownWriteOutcome } from "../api.ts";

/** Explicitly fictional Storybook/demo data. No setup or provider calls have run. */
export const SETUP_FIXTURE: SetupRun = {
  id: "fixture-setup",
  mode: "autonomous",
  status: "blocked",
  repository: { url: "https://git.example.org/team/observatory.git", branch: "main", head: "abc123456789abcdef0123456789abcdef0123456" },
  startedAt: "2026-11-08T12:00:00.000Z",
  updatedAt: "2026-11-08T12:00:00.000Z",
  steps: [
    { id: "inspect", name: "Inspect repository", status: "complete", detail: "Fixture: TypeScript application with a test script." },
    { id: "documents", name: "Prepare autonomy documents", status: "complete", detail: "Fixture: policy and proof plan prepared." },
    { id: "execution", name: "Check execution", status: "blocked", detail: "Fixture: an isolated coding runner is not connected." },
  ],
  artifacts: [{ path: "autonomy.md", content: "# Fictional autonomy policy\n\nNo policy was generated or activated.", digest: "fixture-digest" }],
  blockers: [{
    id: "runner", summary: "Fixture: connect an isolated runner", action: "Configure a workspace-scoped runner to execute agent work.", owner: "operator",
  }],
};

export class FakeSetupApi implements SetupApi {
  private run: SetupRun | null;
  private receipts = new Map<string, SetupRun>();
  constructor(private readonly options: { initial?: SetupRun | null; uncertain?: boolean; error?: Error } = {}) {
    this.run = structuredClone(options.initial ?? null);
  }
  async current(_signal?: AbortSignal, key?: string) { return structuredClone(key ? this.receipts.get(key) ?? null : this.run); }
  async start(input: SetupRequest, key: string) {
    if (this.options.error) throw this.options.error;
    const existing = this.receipts.get(key);
    if (existing) return structuredClone(existing);
    this.run = { ...structuredClone(SETUP_FIXTURE), mode: input.mode, operationKey: key, id: `fixture-${this.receipts.size + 1}` };
    this.receipts.set(key, this.run);
    if (this.options.uncertain) throw new UnknownWriteOutcome(key);
    return structuredClone(this.run);
  }
}
