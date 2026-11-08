import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Draft } from "@ephyra/core";
import type { PolicyActivationControls } from "../app/policyActivationSession.ts";
import { PublishBar } from "./PublishBar.tsx";

const draft: Draft = { id: "published-policy", path: "autonomy.md", kind: "autonomy", content: "# Policy", baseDigest: "b".repeat(64),
  warnings: [], status: "published", createdBy: "did:example:owner", createdAt: "2026-11-08T12:00:00Z", updatedAt: "2026-11-08T12:00:00Z",
  messages: [], published: { ref: "refs/ephyra/policy/published-policy", commit: "a".repeat(40), by: "did:example:owner", at: "2026-11-08T12:00:00Z" } };
const activation: PolicyActivationControls = { status: "ready", active: null, busy: false, current: false,
  activate: async () => {}, reload: async () => {} };
const render = (value: PolicyActivationControls, canPublish = true) => renderToStaticMarkup(createElement(PublishBar, {
  draft, activation: value, canPublish, onPublish: async () => {}, onDiscard: async () => {},
}));

test("published policy offers an explicit approver activation and never claims publication is already active", () => {
  const html = render(activation);
  expect(html).toContain("Activate policy…");
  expect(html).toContain("Publishing preserves this version");
  expect(html).not.toContain("In effect");
  const readonly = render(activation, false);
  expect(readonly).not.toContain("Activate policy…");
  expect(readonly).toContain("Only approvers can activate");
});

test("unconfirmed activation offers a read-only status check and no second mutation", () => {
  const html = render({ ...activation, pending: { path: "autonomy.md", key: "unconfirmed-op", expectedCommit: "a".repeat(40),
    expectedDigest: "b".repeat(64), expectedActive: null } });
  expect(html).toContain("Activation outcome is unconfirmed");
  expect(html).toContain("Check active policy");
  expect(html).not.toContain("Activate policy…");
});

test("only observed current policy is labelled active; loading and unavailable remain visible", () => {
  expect(render({ ...activation, current: true })).toContain("Policy active");
  expect(render({ ...activation, current: true })).toContain("In effect");
  expect(render({ ...activation, status: "loading" })).toContain("Checking the active policy");
  const unavailable = render({ ...activation, status: "unavailable" });
  expect(unavailable).toContain("Policy activation is not available");
  expect(unavailable).not.toContain("Activate policy…");
});
