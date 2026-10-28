import { describe, expect, test } from 'bun:test'
import { HELP_TEXT, parseCliArguments, renderVersionLine } from '../src/cli-arguments'

describe('parseCliArguments', () => {
  test('--version gives version', () => {
    expect(parseCliArguments(['--version'])).toEqual({ kind: 'version' })
  })

  test('--help gives help with exit code 0', () => {
    expect(parseCliArguments(['--help'])).toEqual({ kind: 'help', exitCode: 0 })
  })

  test('no argument runs the dashboard', () => {
    expect(parseCliArguments([])).toEqual({ kind: 'run' })
  })

  test('an unknown flag gives help with exit code 2', () => {
    expect(parseCliArguments(['--bogus'])).toEqual({ kind: 'help', exitCode: 2 })
  })

  test('a known flag next to an unknown flag is still refused', () => {
    expect(parseCliArguments(['--version', '--bogus'])).toEqual({ kind: 'help', exitCode: 2 })
  })
})

describe('renderVersionLine', () => {
  test('names the program, the version and the commit', () => {
    expect(renderVersionLine({ version: '0.1.0', commit: 'abc1234' })).toBe('zk-bridge-terminal 0.1.0 abc1234')
  })
})

describe('HELP_TEXT', () => {
  test('lists both flags', () => {
    expect(HELP_TEXT).toContain('--version')
    expect(HELP_TEXT).toContain('--help')
  })
})
