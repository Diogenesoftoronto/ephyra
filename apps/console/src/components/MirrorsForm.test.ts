import { expect, test } from "bun:test";
import type { AccountSettings } from "@ephyra/core";
import { CONNECTED_ACCOUNT_FIXTURE } from "../fake/account.ts";
import { proposalTarget } from "./MirrorsForm.tsx";

const withForge = (kind: string, credentialConfigured = true): AccountSettings => ({ ...CONNECTED_ACCOUNT_FIXTURE,
  repository: { ...CONNECTED_ACCOUNT_FIXTURE.repository!, credentialConfigured, forge: { kind: kind as never, source: "x" } } });

test("the pull request target names the forge, and says plainly when it cannot open one yet", () => {
  expect(proposalTarget({ ...CONNECTED_ACCOUNT_FIXTURE, repository: null })).toEqual({ ready: false, text: "Connect a repository first." });
  expect(proposalTarget(withForge("github"))).toEqual({ ready: true, text: "GitHub pull requests." });
  expect(proposalTarget(withForge("gitlab"))).toEqual({ ready: true, text: "GitLab merge requests." });
  expect(proposalTarget(withForge("github", false)).ready).toBe(false);
  expect(proposalTarget(withForge("github", false)).text).toContain("connect with GitHub");
  expect(proposalTarget(withForge("git")).ready).toBe(false);
  expect(proposalTarget(withForge("radicle")).text).toContain("Radicle patches");
});
