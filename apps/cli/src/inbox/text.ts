// Terminal text: everything the inbox prints is agent- or human-written, so it is cleaned of control and bidi
// characters before it reaches the screen, and measured in terminal columns rather than UTF-16 units.

const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Untrusted text made safe to print: tabs become spaces, control and bidi characters become spaces. */
export const clean = (s: string) =>
	s.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, " ");
/** One line of untrusted text: newlines become spaces too. */
export const oneLine = (s: string) => clean(s).replace(/\n/g, " ");

/** Columns a code point takes: 2 for East Asian wide and most emoji, 0 for combining marks, else 1. */
export function cols(ch: string): number {
	const c = ch.codePointAt(0) ?? 0;
	if (c === 0) return 0;
	if (
		(c >= 0x300 && c <= 0x36f) ||
		(c >= 0xfe00 && c <= 0xfe0f) ||
		c === 0x200d
	)
		return 0;
	if (
		(c >= 0x1100 && c <= 0x115f) ||
		(c >= 0x2e80 && c <= 0xa4cf) ||
		(c >= 0xac00 && c <= 0xd7a3) ||
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe4f) ||
		(c >= 0xff00 && c <= 0xff60) ||
		(c >= 0xffe0 && c <= 0xffe6) ||
		(c >= 0x1f300 && c <= 0x1faff) ||
		(c >= 0x20000 && c <= 0x3fffd)
	)
		return 2;
	return 1;
}
export const width = (s: string) => {
	let n = 0;
	for (const ch of s) n += cols(ch);
	return n;
};

/** At most `w` columns; an ellipsis marks a cut. */
export function trunc(s: string, w: number): string {
	if (w <= 0) return "";
	if (width(s) <= w) return s;
	let out = "";
	let n = 0;
	for (const ch of s) {
		const c = cols(ch);
		if (n + c > w - 1) break;
		out += ch;
		n += c;
	}
	return `${out}…`;
}
/** Exactly `w` columns: cut with an ellipsis or padded with spaces. */
export const fit = (s: string, w: number) => {
	const t = trunc(s, w);
	return t + " ".repeat(Math.max(0, w - width(t)));
};

/** Word-wrap to `w` columns. Words longer than a line are broken. Blank lines are kept. */
export function wrap(text: string, w: number): string[] {
	if (w <= 0) return [];
	const out: string[] = [];
	for (const para of clean(text).split("\n")) {
		if (!para.trim()) {
			out.push("");
			continue;
		}
		const indent = (para.match(/^ */)?.[0] ?? "").slice(
			0,
			Math.max(0, Math.min(8, w - 1)),
		);
		const room = w - indent.length;
		let line = "";
		for (let word of para.trim().split(/ +/)) {
			while (width(word) > room) {
				if (line) {
					out.push(indent + line);
					line = "";
				}
				let head = "";
				for (const ch of word) {
					if (width(head) + cols(ch) > room) break;
					head += ch;
				}
				if (!head) head = Array.from(word)[0] ?? ""; // one glyph wider than the room: let it overflow
				out.push(indent + head);
				word = word.slice(head.length);
			}
			if (!word) continue;
			const next = line ? `${line} ${word}` : word;
			if (width(next) > room) {
				out.push(indent + line);
				line = word;
			} else line = next;
		}
		if (line) out.push(indent + line);
	}
	return out;
}

/** The last `w` columns of a string: the end of what's being typed. */
export function tail(s: string, w: number): string {
	if (w <= 0) return "";
	const chars = Array.from(s);
	let out = "";
	let n = 0;
	for (let i = chars.length - 1; i >= 0; i--) {
		const c = cols(chars[i]!);
		if (n + c > w) break;
		out = chars[i] + out;
		n += c;
	}
	return out;
}
