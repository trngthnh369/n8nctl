import { Command } from 'commander';
import { withAction } from '../lib/runtime.js';
import { ValidationError } from '../lib/errors.js';
import type { Factory } from '../factory.js';

const SUPPORTED = ['bash', 'zsh', 'fish', 'powershell'] as const;
type Shell = (typeof SUPPORTED)[number];

interface CommandTree {
  /** Top-level command names + aliases (+ `help`). */
  nouns: string[];
  /** Every noun name/alias → its subcommand names + aliases. */
  verbsByNoun: Map<string, string[]>;
}

/**
 * Builds the root program. Injected rather than imported: `program.ts` imports
 * THIS module to register the command, so importing it back — even lazily —
 * closed a cycle. Under vitest's module runner that cycle intermittently
 * resolved to a half-initialised namespace, and `buildProgram` came back
 * undefined mid-suite (see tests/completion.test.ts).
 */
type ProgramBuilder = () => Command;

/**
 * Derive the command tree by WALKING the live Commander program instead of
 * hardcoding names. Any command/verb/alias added anywhere is reflected
 * automatically — the previous static lists silently drifted ~half a release
 * behind the real surface.
 */
function extractTree(buildProgram: ProgramBuilder): CommandTree {
  const program = buildProgram();
  const nouns: string[] = [];
  const verbsByNoun = new Map<string, string[]>();
  for (const cmd of program.commands) {
    const names = [cmd.name(), ...cmd.aliases()];
    nouns.push(...names);
    const verbs: string[] = [];
    for (const sub of cmd.commands) verbs.push(sub.name(), ...sub.aliases());
    for (const n of names) verbsByNoun.set(n, verbs);
  }
  nouns.push('help');
  return { nouns, verbsByNoun };
}

export async function completionHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
  buildProgram: ProgramBuilder,
): Promise<void> {
  const [shell] = args;
  if (!SUPPORTED.includes(shell as Shell)) {
    throw new ValidationError(
      `Unsupported shell "${shell}"`,
      `Pick one of: ${SUPPORTED.join(', ')}`,
    );
  }
  const tree = extractTree(buildProgram);
  factory.io.stdout.write(generate(shell as Shell, tree));
}

export function createCompletionCommand(buildProgram: ProgramBuilder): Command {
  return new Command('completion')
    .description('Generate a shell completion script (reflects the live command tree)')
    .argument('<shell>', `shell to generate for (${SUPPORTED.join('|')})`)
    .action(withAction((factory, opts, args) => completionHandler(factory, opts, args, buildProgram)));
}

function generate(shell: Shell, tree: CommandTree): string {
  const nounsWithVerbs = [...tree.verbsByNoun.entries()];
  switch (shell) {
    case 'bash':
      return genBash(tree, nounsWithVerbs);
    case 'zsh':
      return genZsh(tree, nounsWithVerbs);
    case 'fish':
      return genFish(tree, nounsWithVerbs);
    case 'powershell':
      return genPowershell(tree, nounsWithVerbs);
  }
}

function genBash(tree: CommandTree, nv: [string, string[]][]): string {
  const cases = nv
    .map(
      ([noun, verbs]) =>
        `    ${noun})\n      [ "\${COMP_CWORD}" -eq 2 ] && COMPREPLY=( $(compgen -W "${verbs.join(' ')}" -- "$cur") )\n      ;;`,
    )
    .join('\n');
  return `# n8nctl bash completion — eval "$(n8nctl completion bash)"
_n8nctl_complete() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "\${COMP_CWORD}" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${tree.nouns.join(' ')}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _n8nctl_complete n8nctl
`;
}

function genZsh(tree: CommandTree, nv: [string, string[]][]): string {
  const cases = nv
    .map(([noun, verbs]) => `    ${noun}) (( CURRENT == 3 )) && _values 'verb' ${verbs.join(' ')} ;;`)
    .join('\n');
  return `#compdef n8nctl
# n8nctl zsh completion — n8nctl completion zsh > ~/.zsh/completions/_n8nctl
_n8nctl() {
  if (( CURRENT == 2 )); then
    _values 'command' ${tree.nouns.join(' ')}
    return
  fi
  case "\${words[2]}" in
${cases}
  esac
}
_n8nctl "$@"
`;
}

function genFish(tree: CommandTree, nv: [string, string[]][]): string {
  const topNouns = tree.nouns.filter((n) => n !== 'help');
  const top = `complete -c n8nctl -n "__fish_use_subcommand" -a "${topNouns.join(' ')}"`;
  const perNoun = nv
    .filter(([, verbs]) => verbs.length > 0)
    .map(
      ([noun, verbs]) =>
        `complete -c n8nctl -n "__fish_seen_subcommand_from ${noun}" -a "${verbs.join(' ')}"`,
    )
    .join('\n');
  return `# n8nctl fish completion — save to ~/.config/fish/completions/n8nctl.fish
complete -c n8nctl -f
${top}
${perNoun}
`;
}

function genPowershell(tree: CommandTree, nv: [string, string[]][]): string {
  const arr = (xs: string[]): string => `@(${xs.map((x) => `'${x}'`).join(',')})`;
  const cases = nv
    .map(([noun, verbs]) => `      '${noun}' { return ${arr(verbs)} | Where-Object { $_ -like "$wordToComplete*" } }`)
    .join('\n');
  return `# n8nctl PowerShell completion — n8nctl completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName n8nctl -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tokens = $commandAst.CommandElements.Value
  $nouns = ${arr(tree.nouns)}
  if ($tokens.Length -le 2) {
    return $nouns | Where-Object { $_ -like "$wordToComplete*" }
  }
  if ($tokens.Length -eq 3) {
    switch ($tokens[1]) {
${cases}
    }
  }
}
`;
}
