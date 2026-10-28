/**
 * The local proving dialog. It checks the machine and the files, asks for a direction, runs the prover on this
 * computer and, when a proof comes back, hands the update transaction to the normal review. The dialog holds no
 * secret: the endpoint URLs are read from the secret store at the moment of the run and go only into the private
 * configuration file of the prover.
 */
import { useEffect, useState } from 'react'
import { existsSync } from 'node:fs'
import { resolveSecretReference, type SecretReference } from '@zk-bridge/shared/config'
import { executeCommand, type CommandExecutor } from '@zk-bridge/shared/prover'
import { useServices } from '../app/services'
import type { FlowStep } from '../flow/transaction-flow'
import {
  LOCAL_PROOF_TIMEOUT_MILLISECONDS,
  checkMachine,
  locateBundledProver,
  proveLocally,
  toProverPair,
  type BundledProver,
  type MachineReport,
} from '../prove/local-prover'
import { formatElapsed, type ProgressStep } from '../prove/progress'
import { useKeyLayer } from './key-router'
import { ModalFrame } from './modals'
import { RichLine, colored, muted, plain, strong } from './rich-text'
import { theme } from './theme'

type Phase =
  | { readonly kind: 'ready' }
  | { readonly kind: 'running'; readonly startedAt: number }
  | { readonly kind: 'finished'; readonly message: string; readonly steps: readonly ProgressStep[]; readonly review: readonly FlowStep[] | null }
  | { readonly kind: 'failed'; readonly message: string }

/** The variable that names the first block of a chain, for the prover scan. It is not a secret. */
export function startBlockVariable(chainId: number): string {
  return `ZK_BRIDGE_START_BLOCK_${chainId}`
}

const LINE_WIDTH = 90

/** Breaks a text into lines that fit the dialog. The dialog cuts a longer line. */
export function wrapped(text: string): readonly string[] {
  const lines: string[] = []
  for (let start = 0; start < text.length; start += LINE_WIDTH) lines.push(text.slice(start, start + LINE_WIDTH))
  return lines
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What the dialog shows before a run. */
export function readinessLines(input: { readonly bundle: BundledProver | { readonly missing: readonly string[] }; readonly machine: MachineReport }) {
  const files =
    'missing' in input.bundle
      ? [colored(`Missing next to the terminal program: ${input.bundle.missing.join(', ')}. See docs/local-proving.md.`, theme.bad)]
      : [muted('The prover and both program files are next to the terminal program.')]
  return [
    ...files.map((line) => [line]),
    ...input.machine.blockers.map((text) => [colored(text, theme.bad)]),
    ...input.machine.warnings.map((text) => [colored(text, theme.warn)]),
  ]
}

/** What the modal asks of the machine. A test replaces each part. */
export interface ProveDependencies {
  readonly executablePath: string
  readonly exists: (path: string) => boolean
  readonly totalMemoryBytes: number | undefined
  readonly executor: CommandExecutor
}

const realDependencies: ProveDependencies = { executablePath: process.execPath, exists: existsSync, totalMemoryBytes: undefined, executor: executeCommand }

/** The modal that proves on this computer. */
export function ProveModal(props: {
  readonly onReview: (title: string, steps: readonly FlowStep[]) => void
  readonly onClose: () => void
  readonly dependencies?: ProveDependencies
}) {
  const { pair, proverSetup, now } = useServices()
  const dependencies = props.dependencies ?? realDependencies
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' })
  const [tick, setTick] = useState(0)
  const bundle = locateBundledProver({ executablePath: dependencies.executablePath, exists: dependencies.exists })
  const machine = checkMachine(dependencies.totalMemoryBytes === undefined ? {} : { totalMemoryBytes: dependencies.totalMemoryBytes })
  const canRun = !('missing' in bundle) && machine.blockers.length === 0

  useEffect(() => {
    if (phase.kind !== 'running') return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [phase.kind])

  const run = async (direction: 'first-to-second' | 'second-to-first', files: BundledProver) => {
    setPhase({ kind: 'running', startedAt: now() })
    try {
      const setup = await proverSetup.load()
      const store = await proverSetup.openSecretStore({ password: null })
      const resolve = (reference: SecretReference | null, what: string): Promise<string> =>
        reference === null ? Promise.reject(new Error(`${what} is not set. Open Prover setup (key 6).`)) : resolveSecretReference(reference, { store, environment: proverSetup.environment, run: proverSetup.run })
      const rpcUrls: Record<number, string> = {}
      const beaconUrls: Record<number, string> = {}
      const startBlocks: Record<number, number> = {}
      for (const chain of [pair.first, pair.second]) {
        const endpoints = setup.chains[String(chain.chainId)]
        rpcUrls[chain.chainId] = await resolve(endpoints?.rpc ?? null, `The RPC URL of ${chain.name}`)
        beaconUrls[chain.chainId] = await resolve(endpoints?.beacon ?? null, `The beacon URL of ${chain.name}`)
        const block = Number(proverSetup.environment[startBlockVariable(chain.chainId)])
        if (Number.isSafeInteger(block)) startBlocks[chain.chainId] = block
      }
      const result = await proveLocally({
        bundle: files,
        pair,
        proverPair: toProverPair(pair, { rpcUrls, beaconUrls, startBlocks }),
        direction,
        executor: dependencies.executor,
        baseEnvironment: { PATH: proverSetup.environment.PATH ?? '' },
        timeoutMilliseconds: LOCAL_PROOF_TIMEOUT_MILLISECONDS,
      })
      if (result.kind === 'up-to-date') {
        setPhase({ kind: 'finished', message: 'The light client already holds the newest final header. Nothing to post.', steps: result.steps, review: null })
        return
      }
      setPhase({ kind: 'finished', message: 'The proof is ready. Press Enter to review the update transaction.', steps: result.steps, review: [{ plan: result.update, skippable: false }] })
    } catch (error) {
      setPhase({ kind: 'failed', message: messageOf(error) })
    }
  }

  useKeyLayer('modal', (key) => {
    if (key.name === 'escape') {
      if (phase.kind !== 'running') props.onClose()
      return true
    }
    if (phase.kind === 'ready' && canRun && !('missing' in bundle)) {
      if (key.sequence === '1') void run('first-to-second', bundle)
      if (key.sequence === '2') void run('second-to-first', bundle)
      return true
    }
    if (phase.kind === 'finished' && key.name === 'return' && phase.review !== null) props.onReview('Post a light client update', phase.review)
    return true
  })

  const elapsed = phase.kind === 'running' ? formatElapsed(Math.max(0, now() - phase.startedAt)) : ''
  void tick
  return (
    <ModalFrame title="Prove on this computer" width={96} height={22}>
      {readinessLines({ bundle, machine }).map((line, index) => (
        <RichLine key={index} line={line} />
      ))}
      {phase.kind === 'ready' ? (
        <RichLine line={[strong('1 '), plain(`${pair.first.name} to ${pair.second.name}    `), strong('2 '), plain(`${pair.second.name} to ${pair.first.name}    `), muted('Esc closes')]} />
      ) : null}
      {phase.kind === 'running' ? <RichLine line={[plain(`Proving on this computer. ${elapsed} so far. A real proof takes minutes and much memory.`)]} /> : null}
      {phase.kind === 'finished' ? <RichLine line={[plain(phase.message)]} /> : null}
      {phase.kind === 'failed' ? wrapped(phase.message).map((text, index) => <RichLine key={index} line={[colored(text, theme.bad)]} />) : null}
      {phase.kind === 'finished'
        ? phase.steps.map((step, index) => <RichLine key={index} line={[muted(`${formatElapsed(step.elapsedSeconds).padStart(10)}  `), plain(step.label)]} />)
        : null}
    </ModalFrame>
  )
}
