import { expect, test } from "bun:test";
import { SetupController, type PendingSetupStore, type SetupPending } from "./setup-controller.ts";
import { FakeSetupApi, SETUP_FIXTURE } from "../fake/setup.ts";
import type { SetupApi } from "../setup-api.ts";
import { UnknownWriteOutcome } from "../api.ts";

function memory(): PendingSetupStore {
  let value: SetupPending | null = null;
  return { read: () => value, write: (next) => { value = next; } };
}

test("initial connection starts autonomously once even when mounted twice", async () => {
  const fake = new FakeSetupApi();
  let starts = 0;
  const api: SetupApi = { current: () => fake.current(), start: (input, key) => { starts++; return fake.start(input, key); } };
  const controller = new SetupController(api, memory());
  await Promise.all([controller.load("autonomous"), controller.load("autonomous")]);
  expect(starts).toBe(1);
  expect(controller.snapshot().run?.mode).toBe("autonomous");
  await controller.load("autonomous");
  expect(starts).toBe(1);
});

test("supervision selection is preserved for the first setup request", async () => {
  const controller = new SetupController(new FakeSetupApi(), memory());
  await controller.load("supervised");
  expect(controller.snapshot().run?.mode).toBe("supervised");
});

test("an interrupted start is reconciled by its exact receipt after remount without resending", async () => {
  const fake = new FakeSetupApi({ uncertain: true });
  let starts = 0;
  const keys: (string | undefined)[] = [];
  const api: SetupApi = {
    current: (signal, key) => { keys.push(key); return fake.current(signal, key); },
    start: (input, key) => { starts++; return fake.start(input, key); },
  };
  const pending = memory();
  const controller = new SetupController(api, pending);
  await controller.load("autonomous");
  expect(controller.snapshot().uncertain).toBeTrue();
  const key = pending.read()!.key;
  const remounted = new SetupController(api, pending);
  await remounted.load("autonomous");
  expect(starts).toBe(1);
  expect(keys.at(-1)).toBe(key);
  expect(remounted.snapshot().uncertain).toBeFalse();
  expect(remounted.snapshot().run?.operationKey).toBe(key);
  expect(pending.read()).toBeNull();
});

test("an absent receipt or another tab's run never authorizes repeating an uncertain start", async () => {
  let starts = 0;
  let unrelated = false;
  const api: SetupApi = {
    current: async () => unrelated ? { ...SETUP_FIXTURE, operationKey: "another-tab" } : null,
    start: async (_input, key) => { starts++; throw new UnknownWriteOutcome(key); },
  };
  const pending = memory();
  const controller = new SetupController(api, pending);
  await controller.load("autonomous");
  await controller.refresh();
  expect(controller.snapshot().uncertain).toBeTrue();
  unrelated = true;
  await controller.refresh();
  await controller.start("supervised");
  expect(starts).toBe(1);
  expect(controller.snapshot().run).toBeNull();
  expect(pending.read()).not.toBeNull();
});
