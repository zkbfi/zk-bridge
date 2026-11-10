/**
 * Proving on this computer. The standalone terminal ships next to three files: the prover program and the two compiled
 * guest programs. This module finds them, checks the machine, and drives the shared prover wrapper with the `sp1`
 * backend. It writes no second wrapper: the command line, the configuration file and the output check are the ones the
 * bots use.
 */
import { totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import type { Pair, PairSide } from '@zk-bridge/shared'
import { createProverBinary, type CommandExecutor, type CommandOutput } from '@zk-bridge/shared/prover'
import type { ChainConfig, PairConfig } from '../model/types'
import { planLightClientUpdate } from '../tx/operator'
import type { PlannedTransaction } from '../tx/plan'
import { progressSteps, type ProgressStep } from './progress'

/** The names of the three files, next to the terminal program. */
export const BUNDLED_FILE_NAMES = {
  prover: 'zk-bridge-prover',
  lightClientElf: 'light-client.elf',
  observationElf: 'fork-observation.elf',
} as const

/** The paths of the three files. */
export interface BundledProver {
  readonly prover: string
  readonly lightClientElf: string
  readonly observationElf: string
}

/** The files that are not next to the terminal program. */
export interface MissingBundle {
  readonly missing: readonly string[]
}

/**
 * Looks for the prover program and both guest programs in the folder of the terminal program.
 *
 * @param input.executablePath The path of the running terminal program.
 * @param input.exists Tells whether a file exists. A test passes a fake.
 * @returns The three paths, or the name of every missing file (all of them, not only the first).
 */
export function locateBundledProver(input: { readonly executablePath: string; readonly exists: (path: string) => boolean }): BundledProver | MissingBundle {
  const folder = dirname(input.executablePath)
  const wanted = Object.values(BUNDLED_FILE_NAMES)
  const missing = wanted.filter((name) => !input.exists(join(folder, name)))
  if (missing.length > 0) return { missing }
  return {
    prover: join(folder, BUNDLED_FILE_NAMES.prover),
    lightClientElf: join(folder, BUNDLED_FILE_NAMES.lightClientElf),
    observationElf: join(folder, BUNDLED_FILE_NAMES.observationElf),
  }
}

/**
 * The least memory below which the terminal refuses to start: 16 GiB. The vendor page names it as the floor, and the last
 * Groth16 step alone takes about 14 GiB. A run this small is not expected to finish.
 */
export const MINIMUM_MEMORY_BYTES = 16 * 1024 ** 3

/**
 * The memory that a real CPU proof needs: 56 GiB. Measured on a server with 32 threads: 48 to 56 GiB at the peak, 296
 * seconds for one update (`docs/end-to-end-real-proofs.md`, runs 1 and 2). Below this the terminal warns that the run is
 * likely to fail from running out of memory.
 */
export const EXPECTED_PEAK_MEMORY_BYTES = 56 * 1024 ** 3

/** What the machine check found. */
export interface MachineReport {
  /** Reasons that stop a run. Empty when the run may start. */
  readonly blockers: readonly string[]
  /** Reasons for care that do not stop a run. */
  readonly warnings: readonly string[]
}

const GIBIBYTE = 1024 ** 3

/**
 * Checks the memory of the machine against what a proof needs.
 *
 * @param input.totalMemoryBytes The memory of the machine. Defaults to the real value.
 */
export function checkMachine(input: { readonly totalMemoryBytes?: number } = {}): MachineReport {
  const total = input.totalMemoryBytes ?? totalmem()
  const gibibytes = Math.floor(total / GIBIBYTE)
  if (total < MINIMUM_MEMORY_BYTES) {
    return { blockers: [`This computer has ${gibibytes} GiB of memory. A local proof needs at least 16 GiB.`], warnings: [] }
  }
  if (total < EXPECTED_PEAK_MEMORY_BYTES) {
    return { blockers: [], warnings: [`${gibibytes} GiB of memory. A real proof peaks at 48 to 56 GiB. This run will likely fail.`] }
  }
  return { blockers: [], warnings: [] }
}

/** The endpoints and start blocks that the prover needs, by chain identifier. They come from the secret store. */
export interface ProverEndpoints {
  readonly rpcUrls: Readonly<Record<number, string>>
  readonly beaconUrls: Readonly<Record<number, string>>
}

/** An endpoint or a start block is missing for a chain. */
export class ProverInputError extends Error {
  override readonly name = 'ProverInputError'
}

const UNUSED_ADDRESS = '0x0000000000000000000000000000000000000000'

function sideOf(chain: ChainConfig, endpoints: ProverEndpoints): PairSide {
  const rpcUrl = endpoints.rpcUrls[chain.chainId]
  const beaconUrl = endpoints.beaconUrls[chain.chainId]
  const startBlock = chain.startBlock
  if (rpcUrl === undefined) throw new ProverInputError(`The RPC URL of ${chain.name} is not set.`)
  if (beaconUrl === undefined) throw new ProverInputError(`The beacon URL of ${chain.name} is not set.`)
  if (startBlock === undefined) throw new ProverInputError(`The deployment file names no start_block for ${chain.name}.`)
  // The prover reads only the bridge and the light client of a side. The other contract fields are not used by it, so
  // they hold the zero address and are never sent anywhere.
  return {
    name: chain.name.toLowerCase().replace(/[^a-z0-9]+/g, ''),
    chainId: chain.chainId,
    rpcUrl,
    beaconUrl,
    startBlock,
    ...(chain.lightClientStartBlock === undefined ? {} : { lightClientStartBlock: chain.lightClientStartBlock }),
    finalitySeconds: 0,
    contracts: {
      bridge: chain.contracts.messageBridge,
      mediator: chain.contracts.tokenMediator,
      tokenFactory: UNUSED_ADDRESS,
      wrappedNative: chain.contracts.wrappedNative ?? UNUSED_ADDRESS,
      gate: chain.contracts.gate ?? UNUSED_ADDRESS,
      lightClient: chain.contracts.lightClient,
      deliveryRouter: chain.contracts.deliveryRouter,
      forkRegistry: null,
    },
  }
}

/**
 * Builds the pair in the shape that the prover wrapper reads.
 *
 * @throws ProverInputError when an endpoint or a start block of either chain is missing.
 */
export function toProverPair(pair: PairConfig, endpoints: ProverEndpoints): Pair {
  return { name: pair.id, sides: [sideOf(pair.first, endpoints), sideOf(pair.second, endpoints)] }
}

/** What a local run gives back. */
export type LocalProofResult =
  | { readonly kind: 'proof'; readonly update: PlannedTransaction; readonly steps: readonly ProgressStep[] }
  | { readonly kind: 'up-to-date'; readonly steps: readonly ProgressStep[] }

/** Input of {@link proveLocally}. */
export interface ProveLocallyInput {
  readonly bundle: BundledProver
  readonly pair: PairConfig
  readonly proverPair: Pair
  readonly direction: 'first-to-second' | 'second-to-first'
  readonly executor: CommandExecutor
  /** The variables the prover needs to find its libraries, such as `PATH`. It holds no secret. */
  readonly baseEnvironment: Readonly<Record<string, string>>
  readonly timeoutMilliseconds: number
  readonly temporaryDirectory?: string
}

/** The longest time that one local proof may run: two hours. A laptop can take much longer than a server. */
export const LOCAL_PROOF_TIMEOUT_MILLISECONDS = 2 * 60 * 60 * 1000

const ignore = (): void => undefined
const quietLogger = { debug: ignore, info: ignore }

/**
 * Runs `zk-bridge-prover prove` with the `sp1` backend on this computer. Standard error is kept so that the result can
 * show the stages with their elapsed seconds. The proof package goes through the same check as everywhere (the shared
 * wrapper), and the update transaction goes through the same plan as a handoff file (`planLightClientUpdate`), so it
 * is refused when it points at a contract that is not in the configuration.
 *
 * @throws ProverCommandError when the prover fails; its text holds the end of the standard error.
 * @throws OperatorFileError when the finished proof disagrees with the pair configuration.
 */
export async function proveLocally(input: ProveLocallyInput): Promise<LocalProofResult> {
  const captured: string[] = []
  const capturing: CommandExecutor = async (spec) => {
    const output: CommandOutput = await input.executor(spec)
    captured.push(output.stderr)
    return output
  }
  const binary = createProverBinary({
    binaryPath: input.bundle.prover,
    pair: input.proverPair,
    executor: capturing,
    timeoutMilliseconds: input.timeoutMilliseconds,
    backend: { kind: 'sp1', lightClientElfPath: input.bundle.lightClientElf, observationElfPath: input.bundle.observationElf },
    proverSecret: null,
    baseEnvironment: input.baseEnvironment,
    ...(input.temporaryDirectory === undefined ? {} : { temporaryDirectory: input.temporaryDirectory }),
    logger: quietLogger,
  })
  const outcome = await binary.prove({ direction: input.direction })
  const steps = progressSteps(captured.join('\n'))
  if (outcome.kind === 'up-to-date') return { kind: 'up-to-date', steps }
  return { kind: 'proof', update: planLightClientUpdate(JSON.stringify(outcome.proofPackage), input.pair), steps }
}
