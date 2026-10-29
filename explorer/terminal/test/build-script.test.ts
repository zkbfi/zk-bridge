import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const script = readFileSync(new URL('../../../script/build-terminal.sh', import.meta.url), 'utf8')
const tsconfig = JSON.parse(readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8')) as {
  compilerOptions: { paths: Record<string, string[]> }
}

/** The `paths` block of the tsconfig override that script/build-terminal.sh writes. */
function overridePaths(): Record<string, string> {
  const block = /"paths": \{([^}]*)\}/.exec(script)?.[1]
  if (block === undefined) throw new Error('script/build-terminal.sh writes no paths block')
  const entries = [...block.matchAll(/"([^"]+)": \["([^"]+)"\]/g)].map((match) => [match[1]!, match[2]!] as const)
  return Object.fromEntries(entries)
}

describe('script/build-terminal.sh', () => {
  // A tsconfig override replaces `paths` as a whole, so every alias of the project must be repeated there, or the
  // standalone build cannot resolve an import that `bun test` and `tsc` resolve.
  test('the override repeats every path alias of the terminal tsconfig, pointing at the same file', () => {
    const override = overridePaths()
    for (const [alias, [target]] of Object.entries(tsconfig.compilerOptions.paths)) {
      const relative = target!.replace(/^\.\.\//, 'explorer/')
      expect(override[alias]).toBe(`$repository_root/${relative}`)
    }
  })
})
