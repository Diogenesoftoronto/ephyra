// Textbook stories for the inbox. They render the real view (inbox/view.ts) at the story runner's size, from the
// example trail in inbox/demo.ts: sample data, labelled as such, never evidence.
import { defineStories, story } from "textbook-sh";
import * as tui from "@opentui/core";
import type { CliRenderer } from "@opentui/core";
import {
	DEMO_FILES,
	DEMO_ITEMS,
	DEMO_OTHERS,
	DEMO_ROLLBACK,
	demoTrail,
	detailKey,
	inboxView,
	toStyled,
	trailView,
	type DemoMoment,
	type FileEntry,
	type InboxState,
	type Line,
	type StyledKit,
} from "./index";

const kit = tui as unknown as StyledKit;
const draw =
	(lines: (w: number, h: number) => Line[]) => (renderer: CliRenderer) =>
		new tui.TextRenderable(renderer, {
			content: toStyled(
				kit,
				lines(renderer.width || 100, renderer.height || 30),
			) as tui.StyledText,
			width: "100%",
			height: "100%",
		});
const file = (path: string): FileEntry =>
	DEMO_FILES[path]
		? { status: "ready", text: DEMO_FILES[path]! }
		: { status: "missing" };
const at = (
	cp: "A" | "B" | "C",
	moment: DemoMoment,
	extra: Partial<InboxState> = {},
): InboxState => {
	const item = DEMO_ITEMS[cp];
	return {
		items: [item, ...DEMO_OTHERS],
		selected: 0,
		details: {
			[detailKey(item)]: {
				status: "ready",
				...demoTrail(moment),
				artefact: file(item.artefact.path),
			},
		},
		...extra,
	};
};
const inbox = (name: string, state: InboxState, description?: string) =>
	story({
		name,
		...(description ? { description } : {}),
		render: draw((w, h) => inboxView(state, w, h)),
	});

export default defineStories({
	title: "Inbox",
	description: "The keyboard inbox, from an example quest.",
});

export const Empty = inbox("Empty", { items: [], selected: 0 });
export const CheckpointA = inbox(
	"Checkpoint A: hypothesis",
	at("A", "hypothesis"),
	"The first thing a person judges: is this the right cause?",
);
export const CheckpointB = inbox(
	"Checkpoint B: plan",
	at("B", "plan"),
	"Reproduced; the plan for the fix.",
);
export const CheckpointC = inbox(
	"Checkpoint C: proof",
	at("C", "proof"),
	"Proof passed; approving lands it.",
);
export const Loading = inbox("Loading the quest", {
	items: [DEMO_ITEMS.A, ...DEMO_OTHERS],
	selected: 0,
});
const evidenceState = (() => {
	const s = at("A", "hypothesis", { pane: "evidence" });
	const e = s.details![detailKey(DEMO_ITEMS.A)]!;
	if (e.status === "ready")
		s.details![detailKey(DEMO_ITEMS.A)] = {
			...e,
			evidence: file("evidence/index.json"),
		};
	return s;
})();
export const Explain = inbox(
	"Explain (e)",
	evidenceState,
	"The evidence index behind the quest.",
);
export const Keys = inbox("Keys (?)", at("A", "hypothesis", { pane: "help" }));
export const Revise = inbox(
	"Revise with a note (r)",
	at("A", "hypothesis", {
		modal: { action: "revise", value: "check the coupon path too" },
	}),
);
export const Spend = inbox("Spend", {
	items: [DEMO_OTHERS[1]!, DEMO_ITEMS.A],
	selected: 0,
});
export const Parked = inbox("Parked", {
	items: [DEMO_OTHERS[0]!, DEMO_ITEMS.A],
	selected: 0,
});
export const Shadow = inbox("Shadow verdict", {
	items: [DEMO_OTHERS[2]!, DEMO_ITEMS.A],
	selected: 0,
});
export const Approved = inbox("After approving", {
	items: DEMO_OTHERS,
	selected: 0,
	notice: "Approved · T-4c1e0f",
});
export const ErrorState = inbox("API error", {
	items: [DEMO_ITEMS.A],
	selected: 0,
	error: "API unavailable",
});
export const Watching = story({
	name: "Quest: landed and watching",
	render: draw((w) => {
		const d = demoTrail("watching");
		return trailView(
			d.trail,
			d.events,
			{ hypothesis: file("hypothesis.md"), plan: file("plan.md") },
			w,
		);
	}),
});
export const RolledBack = story({
	name: "Quest: rolled back",
	render: draw((w) =>
		trailView(DEMO_ROLLBACK.trail, DEMO_ROLLBACK.events, {}, w),
	),
});
// States added on main (565720f), on the example trail.
export const SelectedItem = inbox("Second item selected", {
	items: [DEMO_ITEMS.A, ...DEMO_OTHERS],
	selected: 1,
});
export const CommentNote = inbox(
	"Comment (c)",
	at("A", "hypothesis", {
		modal: { action: "comment", value: "Check the checkout trace" },
	}),
);
export const KillNote = inbox(
	"Kill with a reason (x)",
	at("A", "hypothesis", {
		modal: { action: "kill", value: "Duplicate investigation" },
	}),
);
export const StaleDecision = inbox("Stale decision", {
	items: [DEMO_ITEMS.A, ...DEMO_OTHERS],
	selected: 0,
	error: "Stale decision; refresh before retrying",
});
