import type { InboxState } from "./reducer";

export function renderInbox(
	state: InboxState,
	width = 80,
	height = 24,
): string {
	const clean = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
	const lines = [
		"EPHYRA  /  INBOX",
		"j/k move  a approve  r revise  x kill  c comment  t claim  p park  o open  l land  e evidence",
		"",
		...state.items.flatMap((i, n) => [
			`${n === state.selected ? ">" : " "} ${i.short}  sev ${i.severity}  ${i.area}  ${i.risk}  ` +
            `${i.checkpoint ?? i.kind}  ${i.blocking ? "blocking" : "advisory"}` +
            `${i.shadowVerdict === "approve" ? "  would auto-approve" : ""}`,
			`  ${i.title}: ${i.artefact.summary}`,
		]),
		...(state.error ? [`Error: ${state.error}`] : []),
		...(state.modal ? [`${state.modal.action}: ${state.modal.value}`] : []),
	];
	return lines
		.slice(0, height)
		.map((s) => clean(s).slice(0, width))
		.join("\n");
}
