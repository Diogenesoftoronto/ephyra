import { RootCommand, type Command, type Complete } from "@bomb.sh/tab";
import { DOCS_TOPICS } from "../docs";
import {
	COMMANDS, COMPLETION_SHELLS, GLOBAL_OPTIONS,
	type CommandArgument, type CommandHelp, type CommandOption,
} from "./help";
import { bashReplies, lexPosix } from "./shell-words";

export class CompletionUsageError extends Error {
	constructor() {
		super("Usage: ephyra complete <bash|zsh|fish|powershell>\nRun `ephyra help complete` for details.");
	}
}

function addOption(command: Command, option: CommandOption): void {
	const names = option.flags.filter((flag) => flag.startsWith("--"));
	const alias = option.flags.find((flag) => /^-[^-]$/.test(flag))?.slice(1);
	// Passing a handler (even an empty one) tells tab to consume the value. Otherwise it is a boolean flag.
	const values = option.value === undefined ? undefined : (complete: Complete) => {
		for (const value of option.values ?? []) complete(value, "");
	};
	for (const [index, name] of names.entries()) {
		if (values) command.option(name.slice(2), option.description, values, index === 0 ? alias : undefined);
		else command.option(name.slice(2), option.description, index === 0 ? alias : undefined);
	}
}

function addArgument(command: Command, argument: CommandArgument): void {
	command.argument(argument.name, (complete) => {
		if (argument.catalog === "commands") {
			for (const entry of COMMANDS)
				for (const name of [entry.name, ...(entry.aliases ?? [])]) complete(name, entry.summary);
		} else if (argument.catalog === "docs") {
			complete("index", "Documentation overview");
			for (const [topic, description] of Object.entries(DOCS_TOPICS)) complete(topic, description);
		} else {
			for (const value of argument.values ?? []) complete(value, "");
		}
	});
}

/** The options a command accepts, or the root's without one. */
function optionsFor(entry: CommandHelp | undefined): CommandOption[] {
	if (!entry) return [...GLOBAL_OPTIONS];
	// `complete` prints a shell protocol, never JSON. --version applies only at the root.
	const global = GLOBAL_OPTIONS.filter((option) =>
		!option.rootOnly && !(entry.name === "complete" && option.flags.includes("--json")));
	return [...global, ...(entry.options ?? [])];
}

/** One fresh catalog per request: tab's default export is a mutable process-wide singleton. */
export function createCompletion(): RootCommand {
	const root = new RootCommand();
	for (const option of GLOBAL_OPTIONS) addOption(root, option);
	for (const entry of COMMANDS) {
		for (const name of [entry.name, ...(entry.aliases ?? [])]) {
			const command = root.command(name, entry.summary);
			for (const option of optionsFor(entry)) addOption(command, option);
			for (const argument of entry.arguments ?? []) addArgument(command, argument);
		}
	}
	return root;
}

// tab 0.0.22's generated Bash glue evaluates user-entered words as shell code. Keep tab's catalog and
// protocol, but own the small shell boundary: pass text as argv and accept only a known final directive.
// In particular, never join words for eval/Invoke-Expression or feed candidates to compgen -W.
// Bash hands over the raw line around the cursor and Readline's own word ($2). The CLI removes quoting lexically
// and returns exact Readline replacements, so quoted, inline-valued and mid-word completions all line up.
const BASH = `# bash completion for ephyra (Bash 4+)
__ephyra_complete() {
    local out directive line
    local -a replies
    COMPREPLY=()
    out=$(EPHYRA_COMPLETE_SHELL=bash ephyra complete -- "\${COMP_LINE:0:COMP_POINT}" "\${COMP_LINE:COMP_POINT}" "$2" 2>/dev/null) || return
    directive=\${out##*$'\\n'}
    if [[ "$out" == *$'\\n'* ]]; then out=\${out%$'\\n'*}; else out=''; fi
    case $directive in
        :bash) ;;
        :bash-nospace) compopt -o nospace 2>/dev/null ;;
        *) return ;;
    esac
    if [[ -n "$out" ]]; then
        while IFS= read -r line; do replies+=("$line"); done <<< "$out"
    fi
    COMPREPLY=("\${replies[@]}")
}
complete -F __ephyra_complete ephyra
`;

const ZSH = `#compdef ephyra
# zsh completion for ephyra; load after compinit
_ephyra() {
    emulate -L zsh
    local out line value description current prefix=''
    local -a args rows values descriptions
    (( CURRENT > 1 )) || return
    # (Q) removes one level of quoting lexically; it never runs substitutions or expands parameters.
    if (( CURRENT > 2 )); then args=("\${(@Q)words[2,CURRENT-1]}"); fi
    args+=("\${(Q)PREFIX}")
    out=$(ephyra complete -- "\${args[@]}" 2>/dev/null) || return
    rows=("\${(@f)out}")
    (( \${#rows} > 0 )) && [[ "\${rows[-1]}" == ':4' ]] || return
    (( \${#rows} > 1 )) || return 0
    current=\${(Q)PREFIX}
    [[ "$current" == --*=* ]] && prefix="\${current%%=*}="
    for line in "\${(@)rows[1,-2]}"; do
        [[ "$line" == *$'\t'* ]] || return
        value=\${line%%$'\t'*}
        description=\${line#*$'\t'}
        values+=("$prefix$value")
        descriptions+=("$value -- $description")
    done
    compadd -d descriptions -a values
}
compdef _ephyra ephyra
`;

const FISH = `# fish completion for ephyra
function __ephyra_complete
    # Command substitution splits on newlines, so read completed words with Fish's tokenizer instead of
    # \`commandline -opc\`: a quoted multiline argument stays one word. Nothing here is evaluated.
    set -l before (commandline -pc | string collect)
    set -l current (commandline -ct | string collect)
    set -l head (string sub -e (math (string length -- "$before") - (string length -- "$current")) -- "$before" | string collect)
    set -l args
    printf '%s' "$head" | read -z --tokenize -a args
    # The current token is raw text (\`'fa\`, \`--status='fa\`): decode its quoting lexically, as Fish itself does.
    # A trailing lone backslash cannot be decoded yet, so leave it out.
    set -l word (string unescape -- "$current" | string collect)
    or set word (string unescape -- (string sub -e -1 -- "$current") | string collect)
    set -l results (ephyra complete -- $args[2..-1] "$word" 2>/dev/null)
    test (count $results) -gt 0; or return
    test "$results[-1]" = ':4'; or return
    test (count $results) -gt 1; or return
    set -l prefix (string match -r -- '^--[^=]+=' "$word")
    for line in $results[1..-2]
        string match -q '*\t*' -- "$line"; or return
    end
    for line in $results[1..-2]
        printf '%s%s\\n' "$prefix" "$line"
    end
end
complete -c ephyra -e
complete -c ephyra -f -a '(__ephyra_complete)'
`;

const POWERSHELL = `# PowerShell 7.3+ completion for ephyra
if ($PSVersionTable.PSVersion -lt [version]'7.3') {
    Write-Error 'Ephyra completion needs PowerShell 7.3 or newer to preserve native arguments safely.'
    return
}
Register-ArgumentCompleter -Native -CommandName ephyra -ScriptBlock {
    param($WordToComplete, $CommandAst, $CursorPosition)
    # Local scope only. Standard passing preserves empty arguments and embedded quotes.
    $PSNativeCommandArgumentPassing = 'Standard'
    $completionArgs = [System.Collections.Generic.List[string]]::new()
    $lastEnd = $CommandAst.CommandElements[0].Extent.EndOffset
    foreach ($element in $CommandAst.CommandElements | Select-Object -Skip 1) {
        if ($element.Extent.StartOffset -ge $CursorPosition) { break }
        $text = $element.Extent.Text
        if ($element.Extent.EndOffset -gt $CursorPosition) {
            $text = $text.Substring(0, $CursorPosition - $element.Extent.StartOffset)
            if ($text.StartsWith("'") -or $text.StartsWith('"')) { $text = $text.Substring(1) }
        } elseif ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -or
                  $element -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) {
            # AST.Value is literal text here; never evaluate variable or subexpression nodes.
            $text = $element.Value
        }
        $completionArgs.Add([string]$text)
        $lastEnd = $element.Extent.EndOffset
    }
    if ($completionArgs.Count -eq 0 -or $CursorPosition -gt $lastEnd) { $completionArgs.Add('') }
    $invokeArgs = $completionArgs.ToArray()
    $output = @(& ephyra complete -- @invokeArgs 2>$null)
    if ($output.Count -lt 1 -or [string]$output[-1] -cne ':4') { return }
    $current = $completionArgs[$completionArgs.Count - 1]
    $prefix = ''
    if ($current.StartsWith('--') -and $current.Contains('=')) { $prefix = $current.Split('=', 2)[0] + '=' }
    $results = [System.Collections.Generic.List[object]]::new()
    for ($i = 0; $i -lt $output.Count - 1; $i++) {
        $parts = ([string]$output[$i]).Split("\`t", 2)
        if ($parts.Count -ne 2) { return }
        $value = $prefix + $parts[0]
        $description = $parts[1]
        if ([string]::IsNullOrEmpty($description)) { $description = $value }
        $insert = $value
        if ($insert -notmatch '^[A-Za-z0-9_./:=+-]+$') { $insert = "'" + $insert.Replace("'", "''") + "'" }
        $results.Add([System.Management.Automation.CompletionResult]::new($insert, $value, 'ParameterValue', $description))
    }
    $results
}
`;

/** Static shell adapters: no shell startup files are read or changed while generating them. */
export function completionScript(shell: string): string {
	switch (shell) {
		case "bash": return BASH;
		case "zsh": return ZSH;
		case "fish": return FISH;
		case "powershell": return POWERSHELL;
		default: throw new CompletionUsageError();
	}
}

// Stands in for a completed option value or empty word. Shell argv cannot contain NUL, so it never collides with
// real input, and it never starts with a dash, so tab cannot mistake a value for a flag.
const VALUE = "\0";

export type Candidate = { value: string; description: string };

/** What to complete: the word list tab should parse, or the value of a valued option (`-m |`, `--status=f|`). */
export type CompletionTarget =
	| { kind: "tab"; words: string[] }
	| { kind: "value"; option: CommandOption; partial: string; prefix: string };

/**
 * Read decoded shell words (everything after `ephyra`; the last is the partial current word) with the same option
 * metadata main() uses, so a value is never taken for a flag. tab 0.0.22 decides everything from completed words but
 * cannot tell `-m --oops` (a note) from two flags, reads a completed `--name=value` as a flag still waiting for its
 * value, and drops a completed empty word before the current one. Hand tab one canonical word per role instead:
 * the command, flags as their bare names, VALUE for every option value, empty word and unknown dashed word, and
 * other positionals as typed.
 */
export function completionTarget(words: readonly string[]): CompletionTarget {
	const current = words.at(-1) ?? "";
	let entry: CommandHelp | undefined;
	let pending: CommandOption | undefined;
	const canonical: string[] = [];
	const find = (flag: string) => optionsFor(entry).find((option) => option.flags.includes(flag));
	for (const word of words.slice(0, -1)) {
		if (pending) {
			canonical.push(VALUE);
			pending = undefined;
			continue;
		}
		const inline = /^(--[^=]+)=/s.exec(word);
		const option = inline ? find(inline[1]!) : word.startsWith("-") ? find(word) : undefined;
		if (option?.value !== undefined && inline) canonical.push(inline[1]!, VALUE);
		else if (option?.value !== undefined) { canonical.push(word); pending = option; }
		else if (option && !inline) canonical.push(word);
		// main() matches flags exactly, so anything else with a dash (`--json=1`, another command's flag) is a
		// positional argument there. Tell tab so, rather than letting it swallow the next word as a value.
		else if (word.startsWith("-")) canonical.push(VALUE);
		else {
			if (!entry && !canonical.some((w) => !w.startsWith("-") && w !== VALUE))
				entry = COMMANDS.find((help) => help.name === word || help.aliases?.includes(word));
			canonical.push(word === "" ? VALUE : word);
		}
	}
	if (pending) return { kind: "value", option: pending, partial: current, prefix: "" };
	const inline = /^(--[^=]+=)(.*)$/s.exec(current);
	const option = inline ? find(inline[1]!.slice(0, -1)) : undefined;
	if (inline && option?.value !== undefined) return { kind: "value", option, partial: inline[2]!, prefix: inline[1]! };
	return { kind: "tab", words: [...canonical, current] };
}

/** Candidates for the current word, without any inline `--name=` prefix (see completionTarget). */
export function completionCandidates(words: readonly string[]): Candidate[] {
	const target = completionTarget(words);
	let found: Candidate[];
	let partial: string;
	if (target.kind === "value") {
		found = (target.option.values ?? []).map((value) => ({ value, description: "" }));
		partial = target.partial;
	} else {
		const root = createCompletion();
		// Collect instead of printing: tab's own printer re-filters by the text after any `=`, which is wrong for a
		// positional such as a path. RootCommand.complete is private in tab's types, hence the cast.
		(root as unknown as { complete(current: string): void }).complete = () => {};
		partial = target.words.at(-1)!;
		// tab consumes the array it parses.
		root.parse([...target.words]);
		found = root.completions.map(({ value, description }) => ({ value, description: description ?? "" }));
	}
	const seen = new Set<string>();
	return found.filter(({ value }) => value.startsWith(partial) && !seen.has(value) && seen.add(value));
}

/** The inline `--name=` before a value candidate, which the shell must keep when it replaces the whole word. */
export function inlinePrefix(words: readonly string[]): string {
	const target = completionTarget(words);
	return target.kind === "value" ? target.prefix : "";
}

/** The protocol the Zsh, Fish and PowerShell adapters read: `value<TAB>description` lines, then `:4` (no files). */
function printCandidates(words: readonly string[]): void {
	for (const { value, description } of completionCandidates(words)) console.log(`${value}\t${description}`);
	console.log(":4");
}

/**
 * Bash sends the raw command line around the cursor and Readline's word, never pre-split words: quoting is removed
 * here, lexically. It receives ready Readline replacements, then `:bash` or `:bash-nospace`.
 */
function printBash(args: readonly string[]): void {
	const [before = "", after = "", word = ""] = args;
	const line = lexPosix(before, after);
	const words = [...line.words.slice(1), line.current];
	const prefix = inlinePrefix(words);
	const whole = line.words.length ? completionCandidates(words).map(({ value }) => prefix + value) : [];
	const { replies, nospace } = bashReplies(whole, before, after, word);
	// One reply per line: a reply that would need a raw newline is left out rather than split.
	for (const reply of replies) if (!reply.includes("\n")) console.log(reply);
	console.log(nospace ? ":bash-nospace" : ":bash");
}

/**
 * Print either a shell script or the tab completion protocol. No credentials, repository reads or API calls.
 * Pass arguments after `complete`. Dispatch `complete -- ...` before the CLI consumes global flags.
 * EPHYRA_COMPLETE_SHELL=bash, set only by the generated Bash function, selects the raw-line Bash protocol.
 */
export function complete(args: readonly string[], env: Record<string, string | undefined> = process.env): void {
	if (args[0] === "--") {
		if (env.EPHYRA_COMPLETE_SHELL === "bash") printBash(args.slice(1));
		else printCandidates(args.slice(1));
		return;
	}
	if (args.length !== 1 || !COMPLETION_SHELLS.some((shell) => shell === args[0])) throw new CompletionUsageError();
	console.log(completionScript(args[0]!));
}
