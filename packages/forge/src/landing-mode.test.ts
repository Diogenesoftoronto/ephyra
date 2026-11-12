import { expect, test } from "bun:test";
import fc from "fast-check";
import type { ForgeAdapter, LandingMode } from "@ephyra/core";
import { adapterForMode, PROPOSAL_FORGES } from "./landing";

const adapter = (name: string) => ({ name }) as unknown as ForgeAdapter;
const NAMES = ["plain-git", ...PROPOSAL_FORGES] as const;

test("pull_request takes the first proposal forge present, and never a plain push", () => {
  fc.assert(fc.property(fc.subarray([...NAMES]), (present) => {
    const adapters = fc.sample(fc.shuffledSubarray(present, { minLength: present.length }), 1)[0]!.map(adapter);
    const expected = PROPOSAL_FORGES.find((name) => present.includes(name));
    if (!expected) expect(() => adapterForMode("pull_request", adapters)).toThrow("no adapter for pull_request");
    else expect(adapterForMode("pull_request", adapters).name).toBe(expected);
  }));
});

test("forge-specific modes still name exactly one forge", () => {
  const all = NAMES.map(adapter);
  const cases: [LandingMode, string][] = [["radicle_patch", "radicle"], ["tangled_pull", "tangled"], ["auto_land", "plain-git"], ["trail_ref", "plain-git"]];
  for (const [mode, name] of cases) expect(adapterForMode(mode, all).name).toBe(name);
  expect(() => adapterForMode("radicle_patch", [adapter("github")])).toThrow();
  expect(() => adapterForMode("devenv_live", all)).toThrow("runner");
});
