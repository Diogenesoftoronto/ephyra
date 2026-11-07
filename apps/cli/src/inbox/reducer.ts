import type { InboxItem, Trail, TrailEvent } from "@ephyra/core";

export type Command = { action: string; item: InboxItem; note?: string };

/** A journal file the detail pane shows: loading, missing from the journal, unreadable, or its text. */
export type FileEntry =
	| { status: "loading" }
	| { status: "missing" }
	| { status: "error"; message: string }
	| { status: "ready"; text: string };

/** What the detail pane knows about one inbox item, keyed by detailKey(item). */
export type DetailEntry =
	| { status: "loading" }
	| { status: "error"; message: string }
	| {
			status: "ready";
			trail: Trail;
			events: TrailEvent[];
			/** The checkpoint's artefact (hypothesis.md, plan.md, proof/manifest.json). */
			artefact?: FileEntry;
			/** evidence/index.json, loaded the first time `e` is pressed. */
			evidence?: FileEntry;
	  };

/** What the right-hand pane shows: the item, its evidence (`e`), or the keys (`?`). */
export type Pane = "detail" | "evidence" | "help";

export type InboxState = {
	items: InboxItem[];
	selected: number;
	modal?: { action: string; value: string };
	error?: string;
	/** A message that isn't an error, such as "Opened the landing". */
	notice?: string;
	details?: Record<string, DetailEntry>;
	pane?: Pane;
	/** Lines the right-hand pane is scrolled down by. The view clamps it to the content. */
	scroll?: number;
};

/**
 * Details are cached per thing-to-judge: the same trail at a later checkpoint, a new head or a new proof is a
 * different thing, even within one revision.
 */
export const detailKey = (item: InboxItem) =>
	`${item.trailId}@${item.bound.rev}:${item.state}:${item.kind}:${item.checkpoint ?? "-"}:${item.bound.head ?? ""}:${item.bound.proofDigest ?? ""}`;

const SCROLL_STEP = 3;

export function inboxReducer(
	state: InboxState,
	key: string,
): { state: InboxState; command?: Command } {
	const item = state.items[state.selected];
	if (state.modal) {
		if (key === "escape") return { state: { ...state, modal: undefined } };
		if (key === "backspace")
			return {
				state: {
					...state,
					modal: { ...state.modal, value: state.modal.value.slice(0, -1) },
				},
			};
		if (key === "return") {
			if (!item || !state.modal.value.trim()) return { state };
			return {
				state: { ...state, modal: undefined },
				command: { action: state.modal.action, item, note: state.modal.value },
			};
		}
		return {
			state: {
				...state,
				modal: {
					...state.modal,
					value: state.modal.value + (key.length === 1 ? key : ""),
				},
			},
		};
	}
	if (key === "j" || key === "k" || key === "down" || key === "up") {
		const step = key === "j" || key === "down" ? 1 : -1;
		const selected = Math.max(
			0,
			Math.min(state.items.length - 1, state.selected + step),
		);
		const moved = selected !== state.selected;
		return {
			state: {
				...state,
				selected,
				...(moved
					? {
							pane: "detail" as const,
							scroll: 0,
							notice: undefined,
							error: undefined,
						}
					: {}),
			},
		};
	}
	if (key === "J" || key === " " || key === "space")
		return { state: { ...state, scroll: (state.scroll ?? 0) + SCROLL_STEP } };
	if (key === "K")
		return {
			state: {
				...state,
				scroll: Math.max(0, (state.scroll ?? 0) - SCROLL_STEP),
			},
		};
	if (key === "?")
		return {
			state: {
				...state,
				pane: state.pane === "help" ? "detail" : "help",
				scroll: 0,
			},
		};
	if (key === "escape")
		return {
			state: {
				...state,
				pane: "detail",
				scroll: 0,
				notice: undefined,
				error: undefined,
			},
		};
	if (!item) return { state };
	if ((key === "r" && item.kind === "checkpoint") || key === "c" || key === "x")
		return {
			state: {
				...state,
				modal: {
					action: key === "r" ? "revise" : key === "c" ? "comment" : "kill",
					value: "",
				},
			},
		};
	if (key === "e")
		return {
			state: {
				...state,
				pane: state.pane === "evidence" ? "detail" : "evidence",
				scroll: 0,
			},
			command: { action: "evidence", item },
		};
	const action =
		key === "a" && (item.kind === "checkpoint" || item.kind === "spend")
			? "approve"
			: key === "t"
				? "claim"
				: key === "p"
					? item.state === "parked"
						? "resume"
						: "park"
					: key === "l" && item.state === "ready" && item.kind !== "checkpoint"
						? "land"
						: key === "o"
							? "open"
							: undefined;
	return action ? { state, command: { action, item } } : { state };
}

/** Which keys do something for this item right now. The hint bar dims the rest. */
export function availableKeys(item: InboxItem | undefined): Set<string> {
	const keys = new Set(["j", "k", "?", "q"]);
	if (!item) return keys;
	for (const k of ["x", "c", "t", "p", "e"]) keys.add(k);
	if (item.kind === "checkpoint" || item.kind === "spend") keys.add("a");
	if (item.kind === "checkpoint") keys.add("r");
	// At checkpoint C, approving is what lands the trail; `l` is for a ready trail whose C is already approved.
	if (item.state === "ready" && item.kind !== "checkpoint") keys.add("l");
	if (item.landingUrl) keys.add("o");
	return keys;
}
