/**
 * Command line arguments of the terminal program. They are read before the renderer starts, so a plain
 * `--version` or `--help` never takes over the screen.
 */

/** What the program does after it reads its arguments. */
export type CliAction =
  | { readonly kind: 'version' }
  | { readonly kind: 'help'; readonly exitCode: 0 | 2 }
  | { readonly kind: 'run' }

/** The text that `--help` prints. */
export const HELP_TEXT = `zk-bridge-terminal: dashboard for the zk-bridge between PulseChain and Ethereum.

Usage:
  zk-bridge-terminal            Start the dashboard.
  zk-bridge-terminal --version  Print the version and the commit, then exit.
  zk-bridge-terminal --help     Print this text, then exit.

Settings come from environment variables. The list is in explorer/terminal/README.md.
`

/**
 * Reads the arguments (without the program name). An empty list runs the dashboard. A lone known flag
 * gives its action. Any other argument gives help with exit code 2, so a typo never starts the dashboard.
 */
export function parseCliArguments(argv: readonly string[]): CliAction {
  if (argv.length === 0) return { kind: 'run' }
  if (argv.length > 1) return { kind: 'help', exitCode: 2 }
  if (argv[0] === '--version') return { kind: 'version' }
  if (argv[0] === '--help') return { kind: 'help', exitCode: 0 }
  return { kind: 'help', exitCode: 2 }
}

/** The one line that `--version` prints: program name, package version, commit. */
export function renderVersionLine(input: { readonly version: string; readonly commit: string }): string {
  return `zk-bridge-terminal ${input.version} ${input.commit}`
}
