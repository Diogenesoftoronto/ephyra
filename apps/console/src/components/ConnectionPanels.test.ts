import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationStatus, ConnectionPanels } from "./ConnectionPanels.tsx";
import { repositoryAddressError } from "./repository-address.ts";
import { ACCOUNT_FIXTURE, FakeAccountApi } from "../fake/account.ts";
import { CONNECTION_ACCOUNT_FIXTURE } from "../fake/connections.ts";

test("native repository addresses reach server identity resolution while credentials and executable URLs are rejected", () => {
  for (const address of [
    "rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5", "rad://z3gqcJUoA1n9HaHKufZs5FCSGazv5",
    "https://app.radicle.xyz/nodes/seed.example/rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5",
    "https://tangled.org/alice.example/app", "at://did:plc:alice/org.tangled.repo/declaration",
    "at://did:plc:alice/org.tangled.repo.declaration/app", "https://github.com/team/app", "https://git.example/team/app.git",
  ]) expect(repositoryAddressError(address)).toBeUndefined();
  for (const address of ["", "javascript:alert(1)", "file:///tmp/repo", "ssh://host/repo", "https://secret@host/repo",
    "https://host/repo?token=secret", "https://host/repo#script", "https://host/", "rad:invalid", "at://alice.example/org.tangled.repo/key"]) {
    expect(repositoryAddressError(address)).toBeDefined();
  }
});

test("optional source panels start collapsed, keep the owner reachable by default and do not imply verified execution", () => {
  const html = renderToStaticMarkup(createElement(ConnectionPanels, {
    api: new FakeAccountApi(), settings: ACCOUNT_FIXTURE, onChange: () => {},
  }));
  expect(html).toContain("Questions for the workspace owner arrive in Inbox without extra setup");
  expect(html).toContain("You · Inbox");
  expect(html).not.toMatch(/<details[^>]*open/);
  expect(html).not.toContain("Delivery webhook URL");
  const status = renderToStaticMarkup(createElement(AutomationStatus, { settings: ACCOUNT_FIXTURE }));
  expect(status).toContain("Not reported");
  expect(status).not.toContain("Configured");
});

test("saved fixtures expose connection status without returning keys or treating stored settings as a verified provider", async () => {
  const api = new FakeAccountApi({ initial: CONNECTION_ACCOUNT_FIXTURE });
  const input = { expectedVersion: 0, workspaceId: ACCOUNT_FIXTURE.workspaceId, enabled: true,
    origin: "https://posthog.example.com", projectId: "42", includeRecordings: true, apiKey: "private-fixture-key" };
  const first = await api.saveTelemetry(input, "telemetry-idempotent");
  expect(await api.saveTelemetry(input, "telemetry-idempotent")).toEqual(first);
  expect(first.telemetry?.status).toBe("saved");
  expect(first.telemetry?.checkedAt).toBeNull();
  expect(JSON.stringify(first)).not.toContain(input.apiKey);
  const changed = await api.saveTelemetry({ ...input, expectedVersion: 1, apiKey: undefined,
    origin: "https://different.example.com" }, "new-destination");
  expect(changed.telemetry?.keyConfigured).toBeFalse();
  const people = await api.savePeople({ expectedVersion: 2, workspaceId: ACCOUNT_FIXTURE.workspaceId, enabled: true,
    contacts: CONNECTION_ACCOUNT_FIXTURE.people!.contacts, webhookUrl: "https://delivery.example.com/questions",
    token: "private-delivery-key" }, "delivery");
  expect(people.people?.keyConfigured).toBeTrue();
  expect(JSON.stringify(people)).not.toContain("private-delivery-key");
  await expect(api.savePeople({ expectedVersion: 3, workspaceId: "different-workspace", enabled: false, contacts: [] }, "stale"))
    .rejects.toMatchObject({ status: 409, detail: "Your workspace changed." });
});
