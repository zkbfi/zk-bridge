import { spawn, type ChildProcess } from 'node:child_process'
import { bothChains, rpcRequest, type ChainHandle } from './chains.js'

/** A running Anvil process. */
export interface RunningAnvil {
  readonly handle: ChainHandle
  readonly process: ChildProcess
}

/** Command line flags for one chain, as the build contract fixes them. */
export const anvilArguments = (handle: ChainHandle): readonly string[] => [
  '--port',
  String(handle.port),
  '--chain-id',
  String(handle.chainId),
  '--hardfork',
  'prague',
  '--silent',
]

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const isAnswering = async (handle: ChainHandle): Promise<boolean> => {
  try {
    await rpcRequest(handle.rpcUrl, 'eth_chainId')
    return true
  } catch {
    return false
  }
}

/**
 * Starts Anvil for one chain and waits until it answers.
 * @throws When the process exits early or does not answer within ten seconds.
 */
export const startAnvil = async (handle: ChainHandle): Promise<RunningAnvil> => {
  if (await isAnswering(handle)) throw new Error(`Port ${handle.port} is already in use by a running node`)
  const child = spawn('anvil', [...anvilArguments(handle)], { stdio: 'ignore' })
  const exited = new Promise<never>((_, reject) => {
    child.once('exit', (code) => reject(new Error(`Anvil for ${handle.name} exited early with code ${code}`)))
    child.once('error', reject)
  })
  const ready = (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await isAnswering(handle)) return
      await delay(100)
    }
    throw new Error(`Anvil for ${handle.name} did not answer within ten seconds`)
  })()
  try {
    await Promise.race([ready, exited])
  } catch (error) {
    child.kill('SIGKILL')
    throw error
  }
  child.removeAllListeners('exit')
  return { handle, process: child }
}

/** Stops an Anvil process and waits for it to exit. */
export const stopAnvil = async (running: RunningAnvil): Promise<void> => {
  const { process: child } = running
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
}

/** Starts both chains of the build contract. */
export const startBothChains = (): Promise<readonly RunningAnvil[]> => Promise.all(bothChains.map(startAnvil))

/** Stops every running chain. */
export const stopChains = async (running: readonly RunningAnvil[]): Promise<void> => {
  await Promise.all(running.map(stopAnvil))
}

/**
 * Resets one chain to its genesis state and turns automine back on.
 * Every test starts from this clean state, so the deployer nonce is zero again.
 */
export const resetChain = async (handle: ChainHandle): Promise<void> => {
  await rpcRequest(handle.rpcUrl, 'anvil_reset', [])
  await rpcRequest(handle.rpcUrl, 'evm_setAutomine', [true])
}

/** Resets both chains to genesis. */
export const resetBothChains = async (): Promise<void> => {
  await Promise.all(bothChains.map(resetChain))
}
