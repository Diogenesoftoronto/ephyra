import type { InboxItem } from "@ephyra/core";

export type Command = { action: string; item: InboxItem; note?: string };
export type InboxState = {
	items: InboxItem[];
	selected: number;
	modal?: { action: string; value: string };
	error?: string;
};
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
	if (key === "j" || key === "k")
		return {
			state: {
				...state,
				selected: Math.max(
					0,
					Math.min(
						state.items.length - 1,
						state.selected + (key === "j" ? 1 : -1),
					),
				),
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
	const action =
		key === "a" && (item.kind === "checkpoint" || item.kind === "spend")
			? "approve"
			: key === "t"
				? "claim"
				: key === "p"
					? item.state === "parked"
						? "resume"
						: "park"
					: key === "l" && item.state === "ready"
						? "land"
						: key === "o"
							? "open"
							: key === "e"
								? "evidence"
								: undefined;
	return action ? { state, command: { action, item } } : { state };
}
