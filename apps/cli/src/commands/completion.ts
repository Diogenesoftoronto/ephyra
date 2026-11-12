import { RootCommand, type Command, type Complete } from "@bomb.sh/tab";
import { DOCS_TOPICS } from "../docs";
import {
	COMMANDS, COMPLETION_SHELLS, GLOBAL_OPTIONS,
	type CommandArgument, type CommandOption,
} from "./help";

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

/** One fresh catalog per request: tab's default export is a mutable process-wide singleton. */
export function createCompletion(): RootCommand {
	const root = new RootCommand();
	for (const option of GLOBAL_OPTIONS) addOption(root, option);
	for (const entry of COMMANDS) {
		for (const name of [entry.name, ...(entry.aliases ?? [])]) {
			const command = root.command(name, entry.summary);
			for (const option of GLOBAL_OPTIONS) {
				// `complete` prints a shell protocol, never JSON. --version applies only at the root.
				if (!option.rootOnly && !(entry.name === "complete" && option.flags.includes("--json")))
					addOption(command, option);
			}
			for (const option of entry.options ?? []) addOption(command, option);
			for (const argument of entry.arguments ?? []) addArgument(command, argument);
		}
	}
	return root;
}

// tab 0.0.22's generated Bash glue evaluates user-entered words as shell code. Keep tab's catalog and
// protocol, but own the small shell boundary: pass words as argv and accept only its current :4 directive.
// In particular, never join words for eval/Invoke-Expression or feed candidates to compgen -W.
const BASH = `# bash completion for ephyra (Bash 4+ and bash-completion)
__ephyra_complete() {
    local cur prev cword out line value prefix='' match
    local -a words args replies
    COMPREPLY=()
    _get_comp_words_by_ref -n '=:' cur prev words cword || return
    (( cword > 0 )) || return
    args=("\${words[@]:1:cword}")
    args[cword-1]="$cur"
    out=$(ephyra complete -- "\${args[@]}" 2>/dev/null) || return
    [[ "$out" == ':4' ]] && return
    [[ "$out" == *$'\n:4' ]] || return
    out=\${out%$'\n:4'}
    match=$cur
    if [[ "$cur" == --*=* ]]; then
        prefix="\${cur%%=*}="
        match=\${cur#*=}
    fi
    while IFS= read -r line; do
        [[ "$line" == *$'\t'* ]] || return
        value=\${line%%$'\t'*}
        [[ "$value" == "$match"* ]] && replies+=("$prefix$value")
    done <<< "$out"
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
    if (( CURRENT > 2 )); then args=("\${(@)words[2,CURRENT-1]}"); fi
    args+=("$PREFIX")
    out=$(ephyra complete -- "\${args[@]}" 2>/dev/null) || return
    rows=("\${(@f)out}")
    (( \${#rows} > 0 )) && [[ "\${rows[-1]}" == ':4' ]] || return
    (( \${#rows} > 1 )) || return 0
    current=$PREFIX
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
    set -l args (commandline -opc)
    set -l current (commandline -ct)
    set -l results (ephyra complete -- $args[2..-1] "$current" 2>/dev/null)
    test (count $results) -gt 0; or return
    test "$results[-1]" = ':4'; or return
    test (count $results) -gt 1; or return
    set -l prefix (string match -r -- '^--[^=]+=' "$current")
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

/**
 * Print either a shell script or the tab completion protocol. No credentials, repository reads or API calls.
 * Pass arguments after `complete`. Dispatch `complete -- ...` before the CLI consumes global flags.
 */
export function complete(args: readonly string[]): void {
	if (args[0] === "--") {
		// tab consumes its argument array; preserve the caller's copy, including the final empty word.
		createCompletion().parse(args.slice(1));
		return;
	}
	if (args.length !== 1 || !COMPLETION_SHELLS.some((shell) => shell === args[0])) throw new CompletionUsageError();
	console.log(completionScript(args[0]!));
}
