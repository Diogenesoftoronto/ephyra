import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { Runner, ServiceProfile } from "@ephyra/core";
import { profileDigest, selectRunner } from "./index.ts";

const profile: ServiceProfile = { name: "test", digest: "ignored", network: "none", readOnlyProd: true, credentials: [], limits: { cpu: 1, memoryMb: 256, diskMb: 100, timeoutS: 30 } };
describe("profiles", () => {
  test("digest ignores its own digest and is stable across object key order", () => {
    fc.assert(fc.property(fc.string(), (name) => {
      const a = { ...profile, name };
      const b = { limits: { timeoutS: 30, diskMb: 100, memoryMb: 256, cpu: 1 }, credentials: [], readOnlyProd: true, network: "none" as const, digest: "other", name };
      expect(profileDigest(a)).toBe(profileDigest(b));
    }));
  });
  test("digest binds network", () => expect(profileDigest(profile)).not.toBe(profileDigest({ ...profile, network: "private" })));
  test("selection enforces capabilities", () => {
    const runner = { name: "cpu", capabilities: { network: ["none"], checkpoint: "none", shell: false, browser: false } } as unknown as Runner;
    expect(selectRunner(profile, [runner])).toBe(runner);
    expect(selectRunner(profile, [runner], { shell: true })).toBeNull();
    expect(selectRunner({ ...profile, network: "private" }, [runner])).toBeNull();
    expect(selectRunner(profile, [runner], { checkpoint: "disk" })).toBeNull();
  });
});
