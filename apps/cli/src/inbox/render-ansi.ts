import type { InboxState } from "./reducer";
import { toAnsi } from "./paint";
import { inboxView, plain } from "./view";

/** The inbox as plain text (snapshots, logs, terminals that can't take colour). */
export function renderInbox(
	state: InboxState,
	width = 80,
	height = 24,
): string {
	return plain(inboxView(state, width, height));
}

/** The inbox with 24-bit colour, for the ANSI terminal fallback. */
export function renderInboxAnsi(
	state: InboxState,
	width = 80,
	height = 24,
): string {
	return toAnsi(inboxView(state, width, height));
}
