import { expect, test } from "bun:test";
import type { ServiceProfile, Trail } from "@ephyra/core";
import { Unverified } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { RailwaySandboxRunner, UnsupportedRailwayNetwork, type RailwaySandboxClient } from "./railway.ts";

const profile: ServiceProfile = { name: "p", digest: "x", network: "egress", readOnlyProd: true, credentials: [],
  limits: { cpu: 1, memoryMb: 128, diskMb: 100, timeoutS: 30 } };
const trail = { id: "t" } as Trail;

test("Railway maps egress and private and refuses unenforceable policies", async () => {
  const networks: string[] = [];
  const client: RailwaySandboxClient = {
    async create(req) { networks.push(req.network); return "remote"; },
    async *exec() { yield { exit: 0, durationMs: 1, timedOut: false }; },
    async writeFile() {}, async readFile() { return null; },
    async checkpoint() { return "snapshot"; },
    async restore(_, req) { networks.push(req.network); return "restored"; },
    async destroy() {},
  };
  const cas = new ArtifactStore("/unused");
  expect(() => new RailwaySandboxRunner(cas)).toThrow(Unverified);
  const runner = new RailwaySandboxRunner(cas, client);
  const h = await runner.allocate({ trail, attempt: 1, repoUrl: "repo", commit: "sha", profile });
  expect(await runner.checkpoint(h)).toEqual({ snapshotId: "snapshot", kind: "disk" });
  const restored = await runner.restore("snapshot", { trail, attempt: 2, profile: { ...profile, network: "private" } });
  expect(networks).toEqual(["ISOLATED", "PRIVATE"]);
  await expect(runner.allocate({ trail, attempt: 3, repoUrl: "repo", commit: "sha",
    profile: { ...profile, network: "egress_allowlist" } })).rejects.toBeInstanceOf(UnsupportedRailwayNetwork);
  await expect(runner.allocate({ trail, attempt: 3, repoUrl: "repo", commit: "sha",
    profile: { ...profile, network: "none" } })).rejects.toBeInstanceOf(UnsupportedRailwayNetwork);
  await runner.destroy(h);
  await runner.destroy(restored);
});
