import { expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrailDetailSchema } from "../api.ts";
import { FakeApi } from "../fake/api.ts";
import { ME } from "../fake/fixtures.ts";
import { LandingWalkthrough } from "../components/LandingWalkthrough.tsx";
import {
  WALKTHROUGH_STEPS, readWalkthroughSelection, walkthroughNavigationAllowed, walkthroughParentOrigin, walkthroughRequested,
} from "./landing-walkthrough.ts";

// Existing fictional landing/CLI snapshots, not a live account or provider response.
const fixture = JSON.parse(readFileSync(new URL("../../../../site/e/walkthrough.json", import.meta.url), "utf8"));
const parent = {};
const origin = "https://ephyra.quest";
function message(step = "hypothesis") {
  return { type: "ephyra.walkthrough.select", step, detail: {
    ...structuredClone(fixture.gui.moments[step]), artefacts: [
      { path: "hypothesis.md", content: fixture.gui.hypothesis }, { path: "plan.md", content: fixture.gui.plan },
      { path: "evidence/index.json", content: JSON.stringify(fixture.gui.evidence) },
    ],
  } };
}
const event = (data: unknown) => ({ origin, source: parent, data });

test("embedding requires both explicit demo flags and an exact HTTPS or loopback parent origin", () => {
  expect(walkthroughRequested("?demo=1&walkthrough=1")).toBe(true);
  for (const query of ["", "?walkthrough=1", "?demo=0&walkthrough=1", "?demo=1&walkthrough=0"]) {
    expect(walkthroughRequested(query)).toBe(false);
    expect(walkthroughParentOrigin(query)).toBeNull();
  }
  for (const value of [origin, "http://localhost:4319", "http://127.0.0.1:4319", "http://[::1]:4319"])
    expect(walkthroughParentOrigin(`?demo=1&walkthrough=1&parentOrigin=${encodeURIComponent(value)}`)).toBe(value);
  for (const value of ["http://public.example", `${origin}/`, `${origin}/path`, `${origin}?query=1`, "null", "https://user:secret@example.org"])
    expect(walkthroughParentOrigin(`?demo=1&walkthrough=1&parentOrigin=${encodeURIComponent(value)}`)).toBeNull();
});

test("all nine guide moments validate against the actual console codecs with stable duplicate identity", () => {
  expect(Object.keys(fixture.gui.moments)).toEqual([...WALKTHROUGH_STEPS]);
  for (const step of WALKTHROUGH_STEPS) {
    const first = readWalkthroughSelection(event(message(step)), origin, parent)!;
    expect(first.step).toBe(step);
    expect(TrailDetailSchema.safeParse(first.detail).success).toBe(true);
    expect(readWalkthroughSelection(event(structuredClone(message(step))), origin, parent)?.key).toBe(first.key);
  }
  expect(readWalkthroughSelection(event(message("hypothesis")), origin, parent)?.key)
    .not.toBe(readWalkthroughSelection(event(message("explain")), origin, parent)?.key);
});

test("other origins, windows, unknown steps, oversized and inconsistent messages cannot replace sample state", () => {
  expect(readWalkthroughSelection({ ...event(message()), origin: "https://attacker.example" }, origin, parent)).toBeNull();
  expect(readWalkthroughSelection({ ...event(message()), source: {} }, origin, parent)).toBeNull();
  for (const value of [null, { type: "other" }, { ...message(), step: "live-account" },
    { ...message(), detail: { ...message().detail, token: "never-use-this" } },
    { ...message(), extra: "unexpected" }, { ...message(), padding: "x".repeat(250_000) }])
    expect(readWalkthroughSelection(event(value), origin, parent)).toBeNull();
  const wrongTrail = message();
  wrongTrail.detail.events[0].trail = crypto.randomUUID();
  expect(readWalkthroughSelection(event(wrongTrail), origin, parent)).toBeNull();
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  expect(readWalkthroughSelection(event(cyclic), origin, parent)).toBeNull();
});

test("actual FakeApi review, claims and comments mutate only the installed sample snapshot", async () => {
  const selected = readWalkthroughSelection(event(message()), origin, parent)!;
  const pristine = JSON.stringify(selected.detail);
  const api = new FakeApi({ now: Date.parse(selected.detail.trail.updatedAt) });
  api.installWalkthrough(selected.detail);
  const id = selected.detail.trail.id;
  const item = (await api.inbox()).find(entry => entry.trailId === id)!;
  expect(item.checkpoint).toBe("A");
  expect((await api.trail(id)).artefacts?.[0]?.content).toBe(fixture.gui.hypothesis);
  await api.trailAction(id, "comment", { text: "A note in the sample console." }, "demo-comment-one");
  expect((await api.trail(id)).events.some(row => row.type === "human_comment" && row.data.text === "A note in the sample console.")).toBe(true);
  await api.trailAction(id, "claim", {}, "demo-claim-one");
  expect((await api.trail(id)).trail.owner).toEqual({ kind: "human", id: ME });
  await expect(api.decide(id, { checkpoint: "A", verdict: "approve", bound: item.bound }, "demo-held-approval")).rejects.toThrow();
  await api.trailAction(id, "release", {}, "demo-release-one");
  await api.decide(id, { checkpoint: "A", verdict: "approve", bound: item.bound }, "demo-approval-one");
  expect((await api.trail(id)).trail.state).toBe("reproducing");
  expect(JSON.stringify(selected.detail)).toBe(pristine);
  expect(await api.activity()).toBeArray();
  expect((await api.usage()).byTrail).toBeArray();
});

test("embedded navigation stays in demo hash routes and cannot enter authentication or an external destination", () => {
  const current = "https://console.ephyra.quest/app/?demo=1&walkthrough=1&parentOrigin=https%3A%2F%2Fephyra.quest#/inbox/sample";
  for (const href of ["#/usage", "#/workspace", "#/settings", "#/overview"])
    expect(walkthroughNavigationAllowed(href, current)).toBe(true);
  for (const href of ["/auth/login", "/app/", "?demo=1", "https://elsewhere.example", "javascript:alert(1)", "mailto:a@example.org"])
    expect(walkthroughNavigationAllowed(href, current)).toBe(false);
});

test("sample navigation never changes its origin, path or query across arbitrary hash destinations", () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), fc.stringMatching(/^[a-z][a-z0-9]{1,20}$/), (hash, label) => {
    const current = `https://${label}.example/app/?demo=1&walkthrough=1&parentOrigin=https%3A%2F%2Fephyra.quest`;
    expect(walkthroughNavigationAllowed(`#${encodeURIComponent(hash)}`, current)).toBe(true);
    expect(walkthroughNavigationAllowed(`https://${label}.example/auth/login#${encodeURIComponent(hash)}`, current)).toBe(false);
    expect(walkthroughNavigationAllowed(`https://${label}.example/app/?demo=0#${encodeURIComponent(hash)}`, current)).toBe(false);
    expect(walkthroughNavigationAllowed(`https://other.${label}.example/app/?demo=1&walkthrough=1`, current)).toBe(false);
  }), { numRuns: 50 });
});

test("missing parent gives a bounded recovery state without instantiating a live connection", () => {
  const markup = renderToStaticMarkup(createElement(LandingWalkthrough, { parentOrigin: null }));
  expect(markup).toContain("Open the walkthrough from the Ephyra landing page");
  expect(markup).not.toContain("Sign in with Not Organic");
});
