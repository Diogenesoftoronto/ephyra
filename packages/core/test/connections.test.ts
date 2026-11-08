import { expect, test } from "bun:test";
import fc from "fast-check";
import { InvestigationContact, PeopleUpdate, TelemetryUpdate, ForgeRepositorySource } from "../src/index.ts";

test("contact IDs are distinct and never accept a second identity under the same routing key", () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z][a-z0-9]{0,20}$/), (id) => {
    const contact = { id, alias: "Support", roles: ["user"], areas: [] };
    expect(InvestigationContact.safeParse(contact).success).toBe(true);
    expect(PeopleUpdate.safeParse({ expectedVersion: 0, workspaceId: "ws", enabled: true,
      contacts: [contact, { ...contact, alias: "Another person" }] }).success).toBe(false);
  }));
});
test("secret-bearing updates reject unexpected fields and control characters", () => {
  const input = { expectedVersion: 0, workspaceId: "ws", enabled: true, origin: "https://us.posthog.com", projectId: "42" };
  for (const apiKey of ["secret\r\nInjected: value", "secret\0suffix"]) expect(TelemetryUpdate.safeParse({ ...input, apiKey }).success).toBe(false);
  expect(TelemetryUpdate.safeParse({ ...input, owner: "did:other" }).success).toBe(false);
  for (const kind of ["git", "github", "gitlab", "forgejo", "radicle", "tangled"]) {
    expect(ForgeRepositorySource.safeParse({ kind, source: "bound-input" }).success).toBe(true);
  }
});
