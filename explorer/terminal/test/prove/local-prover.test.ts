import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeCommand } from '@zk-bridge/shared/prover'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { ProverInputError, checkMachine, locateBundledProver, proveLocally, toProverPair } from '../../src/prove/local-prover'
import { proofPackageText } from '../support/proof-package'

const everything = () => true

describe('locateBundledProver', () => {
  test('finds the prover and both program files next to the executable', () => {
    const found = locateBundledProver({ executablePath: '/opt/zk/zk-bridge-terminal', exists: everything })
    expect(found).toEqual({ prover: '/opt/zk/zk-bridge-prover', lightClientElf: '/opt/zk/light-client.elf', observationElf: '/opt/zk/fork-observation.elf' })
  })

  test('names every missing file', () => {
    const present = new Set(['/opt/zk/zk-bridge-prover'])
    const found = locateBundledProver({ executablePath: '/opt/zk/zk-bridge-terminal', exists: (path) => present.has(path) })
    expect(found).toEqual({ missing: ['light-client.elf', 'fork-observation.elf'] })
  })
})

describe('checkMachine', () => {
  test('refuses under 16 GiB, warns under the size of a large server, and is quiet above it', () => {
    expect(checkMachine({ totalMemoryBytes: 15.9 * 1024 ** 3 }).blockers[0]).toContain('at least 16 GiB')
    expect(checkMachine({ totalMemoryBytes: 16 * 1024 ** 3 }).blockers).toEqual([])
    const warned = checkMachine({ totalMemoryBytes: 32 * 1024 ** 3 })
    expect(warned.blockers).toEqual([])
    expect(warned.warnings[0]).toContain('32 GiB')
    expect(checkMachine({ totalMemoryBytes: 64 * 1024 ** 3 })).toEqual({ blockers: [], warnings: [] })
  })
})

const endpoints = {
  rpcUrls: { 1: 'https://rpc.example/one', 369: 'https://rpc.example/pls' },
  beaconUrls: { 1: 'https://beacon.example/one', 369: 'https://beacon.example/pls' },
  startBlocks: { 1: 100, 369: 200 },
}

describe('toProverPair', () => {
  test('keeps the bridge and the light client of each chain and names the sides after the chains', () => {
    const pair = toProverPair(FIXTURE_PAIR, endpoints)
    expect(pair.sides.map((side) => side.name)).toEqual(['ethereum', 'pulsechain'])
    expect(pair.sides[1]!.contracts.lightClient).toBe(FIXTURE_PAIR.second.contracts.lightClient)
    expect(pair.sides[1]!.contracts.bridge).toBe(FIXTURE_PAIR.second.contracts.messageBridge)
    expect(pair.sides[1]!.startBlock).toBe(200)
  })

  test('says which endpoint is missing', () => {
    expect(() => toProverPair(FIXTURE_PAIR, { ...endpoints, beaconUrls: { 1: 'https://b' } })).toThrow(ProverInputError)
    expect(() => toProverPair(FIXTURE_PAIR, { ...endpoints, startBlocks: {} })).toThrow(/start block of Ethereum/)
  })
})

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workshop(scenario: { exitCode: number; stdout?: string; stderrLines?: string[] }) {
  const directory = mkdtempSync(join(tmpdir(), 'local-prover-test-'))
  directories.push(directory)
  const prover = join(directory, 'zk-bridge-prover')
  copyFileSync(join(import.meta.dir, '..', 'support', 'fake-local-prover.mjs'), prover)
  chmodSync(prover, 0o755)
  const logPath = join(directory, 'calls.log')
  writeFileSync(join(directory, 'scenario.json'), JSON.stringify({ logPath, ...scenario }))
  const bundle = { prover, lightClientElf: join(directory, 'light-client.elf'), observationElf: join(directory, 'fork-observation.elf') }
  return { bundle, logPath }
}

const base = { baseEnvironment: { PATH: process.env.PATH ?? '' }, timeoutMilliseconds: 30_000, executor: executeCommand }

describe('proveLocally', () => {
  test('a finished proof offers the update transaction and shows its stages', async () => {
    const { bundle, logPath } = workshop({
      exitCode: 0,
      stdout: proofPackageText(),
      stderrLines: ['ts=1000 level=info event=prove_started route=ethereum_to_pulsechain', 'ts=1300 level=info event=proof_started program=light-client'],
    })
    const result = await proveLocally({ ...base, bundle, pair: FIXTURE_PAIR, proverPair: toProverPair(FIXTURE_PAIR, endpoints), direction: 'first-to-second' })
    if (result.kind !== 'proof') throw new Error('expected a proof')
    expect(result.update.to).toBe(FIXTURE_PAIR.second.contracts.lightClient)
    expect(result.update.functionSignature).toBe('update(bytes,bytes)')
    expect(result.steps.map((step) => step.elapsedSeconds)).toEqual([0, 300])
    const call = JSON.parse(readFileSync(logPath, 'utf8').trim())
    expect(call.configText).toContain('backend = "sp1"')
    expect(call.configText).toContain(`sp1_elf_path = "${bundle.lightClientElf}"`)
    expect(call.configMode).toBe('600')
    expect(call.args).toContain('prove')
  })

  test('exit code 3 means the light client is up to date', async () => {
    const { bundle } = workshop({ exitCode: 3, stderrLines: ['ts=5 level=info event=up_to_date head_slot=9'] })
    const result = await proveLocally({ ...base, bundle, pair: FIXTURE_PAIR, proverPair: toProverPair(FIXTURE_PAIR, endpoints), direction: 'first-to-second' })
    expect(result.kind).toBe('up-to-date')
  })

  test('a failing prover raises an error that holds the end of its standard error', async () => {
    const { bundle } = workshop({ exitCode: 1, stderrLines: ['ts=5 level=error event=out_of_memory'] })
    await expect(
      proveLocally({ ...base, bundle, pair: FIXTURE_PAIR, proverPair: toProverPair(FIXTURE_PAIR, endpoints), direction: 'first-to-second' }),
    ).rejects.toThrow(/out_of_memory/)
  })
})
