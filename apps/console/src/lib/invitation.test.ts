import { expect, test } from "bun:test";
import fc from "fast-check";
import { forgetInvitation, invitationToken, pendingInvitation } from "./invitation.ts";

function memory() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key) } as Storage;
}
test("OAuth handoff is limited to this tab and expires after thirty minutes", () => {
  const storage = memory();
  const token = "invitation-example-token";
  expect(pendingInvitation(`#/join/${token}`, storage, 0)).toBe(token);
  expect(pendingInvitation("", storage, 100)).toBe(token);
  expect(pendingInvitation("", storage, 30 * 60_000)).toBeNull();
  expect(pendingInvitation(`#/join/${token}`, storage, 1000)).toBe(token);
  forgetInvitation(storage);
  expect(pendingInvitation("", storage, 1001)).toBeNull();
});
test("invalid, oversized and malformed invitation paths are not retained", () => {
  for (const hash of ["#/join/%E0%A4%A", "#/join/short", `#/join/${"x".repeat(2049)}`, "#/join/abcdefghi/abcdefghij"]) {
    expect(invitationToken(hash)).toBeNull();
  }
  const storage = memory();
  pendingInvitation("#/join/a-valid-invitation-token", storage, 0);
  expect(pendingInvitation("#/join/broken", storage, 1)).toBeNull();
  expect(pendingInvitation("", storage, 2)).toBeNull();
});

test("tab handoff preserves each exact URL-safe token and rejects every expired receipt", () => {
  fc.assert(fc.property(fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789_-"), {
    minLength: 16, maxLength: 2048,
  }).map((parts) => parts.join("")), fc.integer({ min: 0, max: 1_799_999 }), (token, age) => {
    const storage = memory();
    expect(pendingInvitation(`#/join/${token}`, storage, 0)).toBe(token);
    expect(pendingInvitation("", storage, age)).toBe(token);
    expect(pendingInvitation("", storage, age + 1_800_000)).toBeNull();
  }));
});
