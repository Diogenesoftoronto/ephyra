// Turning view lines into pixels on a terminal. One palette, from the brand tokens: amber (oklch 0.74 0.162 68),
// mint (0.86 0.13 178), cherry (0.70 0.17 24), warm ink and greys. Backgrounds are left to the terminal.
import type { Line, Tone } from "./view";

export const PALETTE: Record<Tone, string> = {
	fg: "#e9e4d8",
	strong: "#f7f3ea",
	muted: "#a49c8e",
	dim: "#5d646e",
	border: "#7c8591",
	amber: "#f0a43a",
	mint: "#5fdccb",
	cherry: "#f2705e",
	key: "#f7f3ea",
};

const rgb = (hex: string) =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");

/** 24-bit ANSI, for terminals without OpenTUI. Each segment resets, so nothing bleeds past the line. */
export function toAnsi(lines: Line[]): string {
	return lines
		.map((line) =>
			line
				.map((s) => {
					const tone = s.tone ?? "fg";
					return `\x1b[${s.bold ? "1;" : ""}38;2;${rgb(PALETTE[tone])}m${s.text}\x1b[0m`;
				})
				.join(""),
		)
		.join("\n");
}

/** The subset of @opentui/core this needs, so it's injected rather than imported (OpenTUI loads lazily). */
export type StyledKit = {
	StyledText: new (chunks: unknown[]) => unknown;
	fg: (color: string) => (input: string) => unknown;
	bold: (input: unknown) => unknown;
};

/** OpenTUI styled text: one chunk per segment, newlines between lines. */
export function toStyled(kit: StyledKit, lines: Line[]): unknown {
	const chunks: unknown[] = [];
	lines.forEach((line, i) => {
		for (const s of line) {
			const chunk = kit.fg(PALETTE[s.tone ?? "fg"])(s.text);
			chunks.push(s.bold ? kit.bold(chunk) : chunk);
		}
		if (i < lines.length - 1) chunks.push(kit.fg(PALETTE.fg)("\n"));
	});
	return new kit.StyledText(chunks);
}
