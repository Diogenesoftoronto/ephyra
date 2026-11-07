import { defineStories, story } from "textbook-sh";
import { TextRenderable } from "@opentui/core";
import { renderInbox, type InboxState } from "./index";
const base = {
	state: "ready" as const,
	bound: { rev: 1 },
	trailId: "story",
	short: "T-123",
	title: "Example",
	area: "cart",
	risk: "low" as const,
	severity: 2,
	kind: "checkpoint" as const,
	checkpoint: "A" as const,
	blocking: true,
	artefact: { path: "hypothesis.md", summary: "Awaiting review" },
	createdAt: "2026-01-01T00:00:00Z",
};
const make = (name: string, state: InboxState) =>
	story({
		name,
		render: (renderer) =>
			new TextRenderable(renderer, {
				content: renderInbox(state),
				width: "100%",
				height: "100%",
			}),
	});
export default defineStories({ title: "Inbox" });
export const Empty = make("Empty", { items: [], selected: 0 });
export const Waiting = make("Three waiting", {
	items: [base, { ...base, short: "T-124" }, { ...base, short: "T-125" }],
	selected: 0,
});
export const Shadow = make("Shadow", {
	items: [{ ...base, shadowVerdict: "approve" }],
	selected: 0,
});
export const Spend = make("Spend", {
	items: [{ ...base, kind: "spend", checkpoint: undefined }],
	selected: 0,
});
export const ErrorState = make("API error", {
	items: [base],
	selected: 0,
	error: "API unavailable",
});
export const SelectedItem = make("Second item selected", {
	items: [base, { ...base, short: "T-124", title: "Checkout fails" }],
	selected: 1,
});
export const Parked = make("Parked trail", {
	items: [{ ...base, state: "parked" }],
	selected: 0,
});
export const ReviseNote = make("Revision note", {
	items: [base], selected: 0, modal: { action: "revise", value: "Please add a regression test" },
});
export const CommentNote = make("Comment", {
	items: [base], selected: 0, modal: { action: "comment", value: "Check the checkout trace" },
});
export const KillNote = make("Stop trail note", {
	items: [base], selected: 0, modal: { action: "kill", value: "Duplicate investigation" },
});
export const StaleDecision = make("Stale decision", {
	items: [base], selected: 0, error: "Stale decision; refresh before retrying",
});
