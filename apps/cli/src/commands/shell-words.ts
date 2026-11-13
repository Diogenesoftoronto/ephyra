/**
 * A lexical reader for the POSIX-family command line Bash hands its completion function. It removes quoting the
 * way the shell's tokenizer would and never evaluates anything: `$HOME`, `$(...)`, `${...}` and backquotes stay as
 * literal text, inside or outside double quotes, and no history, glob, tilde or brace expansion happens.
 */

/** The quote still open at the cursor. `$'` is Bash ANSI-C quoting. */
export type Quote = "" | "'" | "\"" | "$'";

export type ShellLine = {
	/** Decoded words before the word holding the cursor. The command name is words[0]. */
	words: string[];
	/** The decoded part of the cursor's word that lies before the cursor. */
	current: string;
	/** The quote open at the cursor. */
	quote: Quote;
	/** The decoded rest of the cursor's word after the cursor; later words are ignored. */
	suffix: string;
};

type Mode = "plain" | "single" | "double" | "ansi";
const QUOTE: Record<Mode, Quote> = { plain: "", single: "'", double: "\"", ansi: "$'" };
const BLANK = new Set([" ", "\t", "\n"]);
const SIMPLE_ANSI: Record<string, string> = {
	a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v",
	"\\": "\\", "'": "'", "\"": "\"", "?": "?",
};

/** One ANSI-C escape starting at text[i] === "\\": its decoded text and length. Unknown escapes stay literal. */
function ansiEscape(text: string, i: number): [string, number] {
	const c = text[i + 1];
	if (c === undefined) return ["", 1];
	if (c in SIMPLE_ANSI) return [SIMPLE_ANSI[c]!, 2];
	const digits = (pattern: RegExp, max: number, from: number) => {
		let end = from;
		while (end < text.length && end - from < max && pattern.test(text[end]!)) end++;
		return text.slice(from, end);
	};
	if (/[0-7]/.test(c)) {
		const octal = digits(/[0-7]/, 3, i + 1);
		return [String.fromCodePoint(Number.parseInt(octal, 8) & 0xff), 1 + octal.length];
	}
	const hex = { x: 2, u: 4, U: 8 }[c as "x" | "u" | "U"];
	if (hex) {
		const value = digits(/[0-9A-Fa-f]/, hex, i + 2);
		const point = value ? Number.parseInt(value, 16) : Number.NaN;
		if (value && point <= 0x10ffff) return [String.fromCodePoint(point), 2 + value.length];
	}
	if (c === "c" && i + 2 < text.length) return [String.fromCharCode(text.charCodeAt(i + 2) & 0x1f), 3];
	return [`\\${c}`, 2];
}

/**
 * The end of a `$(...)`, `${...}` or backquoted substitution opened at text[i]: just past its closer, or the end of
 * the text when it is still open. Quotes, escapes and nested substitutions inside it are skipped, never run.
 */
function substitutionEnd(text: string, i: number): number {
	const backquote = text[i] === "`";
	const closer = backquote ? "`" : text[i + 1] === "{" ? "}" : ")";
	let depth = 0;
	let j = i + (backquote ? 1 : 2);
	while (j < text.length) {
		const c = text[j]!;
		if (c === "\\") j += 2;
		else if (c === closer && depth === 0) return j + 1;
		else if (backquote) j++;
		else if (c === "'") { const end = text.indexOf("'", j + 1); j = end < 0 ? text.length : end + 1; }
		else if (c === "\"") {
			j++;
			while (j < text.length && text[j] !== "\"") {
				if (text[j] === "\\") j += 2;
				else if (text[j] === "`" || (text[j] === "$" && (text[j + 1] === "(" || text[j + 1] === "{"))) j = substitutionEnd(text, j);
				else j++;
			}
			j++;
		} else if (c === "`" || (c === "$" && (text[j + 1] === "(" || text[j + 1] === "{"))) j = substitutionEnd(text, j);
		else {
			if (c === (closer === ")" ? "(" : "{")) depth++;
			else if (c === closer) depth--;
			j++;
		}
	}
	return text.length;
}

/**
 * Split `before + after` into words, with the cursor between them. `before` is the command line up to the cursor
 * (Bash's `${COMP_LINE:0:COMP_POINT}`), `after` the rest. Only the cursor's word is read past the cursor.
 */
export function lexPosix(before: string, after = ""): ShellLine {
	const text = before + after;
	const cursor = before.length;
	const words: string[] = [];
	let word: string | null = null;
	let mode: Mode = "plain";
	let at: { value: string; quote: Quote } | null = null;
	let i = 0;
	const mark = () => { at ??= { value: word ?? "", quote: QUOTE[mode] }; };
	// Consume `length` source characters as `decoded`. A cursor strictly inside a multi-character unit (an escape
	// pair, for example) sees the word as it was before that unit.
	const take = (length: number, decoded: string) => {
		if (i < cursor && cursor < i + length) mark();
		word = (word ?? "") + decoded;
		i += length;
	};
	// Substitutions are copied into the word verbatim, unexpanded.
	const substitution = () => { const end = Math.min(substitutionEnd(text, i), text.length); take(end - i, text.slice(i, end)); };
	while (i < text.length) {
		if (i >= cursor) mark();
		const c = text[i]!;
		const next = text[i + 1];
		if (mode === "plain") {
			if (BLANK.has(c)) {
				if (at) break;
				if (word !== null) words.push(word);
				word = null;
				i++;
			} else if (c === "\\") {
				if (next === "\n") { i += 2; continue; }
				take(next === undefined ? 1 : 2, next ?? "");
			} else if (c === "'") { mode = "single"; take(1, ""); }
			else if (c === "\"") { mode = "double"; take(1, ""); }
			else if (c === "$" && next === "'") { mode = "ansi"; take(2, ""); }
			else if (c === "$" && next === "\"") { mode = "double"; take(2, ""); }
			else if (c === "$" && (next === "(" || next === "{")) substitution();
			else if (c === "`") substitution();
			else take(1, c);
		} else if (mode === "single") {
			if (c === "'") mode = "plain";
			take(1, c === "'" ? "" : c);
		} else if (mode === "double") {
			if (c === "\"") { mode = "plain"; take(1, ""); }
			else if (c === "\\" && next === "\n") i += 2;
			else if (c === "\\" && next !== undefined && "$`\"\\".includes(next)) take(2, next);
			else if (c === "$" && (next === "(" || next === "{")) substitution();
			else if (c === "`") substitution();
			else take(1, c);
		} else {
			if (c === "'") { mode = "plain"; take(1, ""); }
			else if (c === "\\") { const [decoded, length] = ansiEscape(text, i); take(length, decoded); }
			else take(1, c);
		}
	}
	mark();
	const value = word ?? "";
	const current = at!.value;
	return { words, current, quote: at!.quote, suffix: value.slice(current.length) };
}

const PLAIN_SAFE = /^[A-Za-z0-9_\-./:=+@%,^]$/;

/** Text that, typed after an open `quote`, reads back as `value`. */
export function quoteFor(value: string, quote: Quote): string {
	switch (quote) {
		case "'": return value.replaceAll("'", "'\\''");
		case "\"": return value.replace(/[\\"$`]/g, "\\$&");
		case "$'": return value.replace(/[\\']/g, "\\$&").replaceAll("\n", "\\n");
		default: return [...value].map((c) => c === "\n" ? "$'\\n'" : PLAIN_SAFE.test(c) ? c : `\\${c}`).join("");
	}
}

export type BashReplies = { replies: string[]; nospace: boolean };

/**
 * Turn whole candidate words into Readline replacements. Readline replaces only `word` (Bash's `$2`: the text after
 * the last COMP_WORDBREAKS character or open quote, up to the cursor) and keeps everything after the cursor, so a
 * reply is the candidate minus the decoded text before `word`, re-quoted for the quote open there, minus the
 * untouched suffix when the candidate already ends with it.
 */
export function bashReplies(candidates: readonly string[], before: string, after: string, word: string): BashReplies {
	if (!before.endsWith(word)) return { replies: [], nospace: false };
	const line = lexPosix(before, after);
	const head = lexPosix(before.slice(0, before.length - word.length));
	const typed = line.current;
	const kept = head.current;
	if (!typed.startsWith(kept)) return { replies: [], nospace: false };
	const replies = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate.startsWith(typed)) continue;
		const end = line.suffix && candidate.endsWith(line.suffix) && candidate.length - line.suffix.length >= typed.length
			? candidate.length - line.suffix.length : candidate.length;
		const reply = quoteFor(candidate.slice(kept.length, end), head.quote);
		if (reply) replies.add(reply);
	}
	// Inside a word, a space would split it from its suffix.
	return { replies: [...replies], nospace: line.suffix !== "" };
}
