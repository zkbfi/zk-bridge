import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Abi, Hex } from 'viem'

/** A compiled contract from the Foundry `out/` directory. */
export interface Artifact {
  readonly abi: Abi
  readonly bytecode: Hex
}

const outputDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../../out')

/** Absolute path of the Foundry artifact for a contract. */
export const artifactPath = (sourceFile: string, contractName: string) =>
  resolve(outputDirectory, `${sourceFile}.sol`, `${contractName}.json`)

/**
 * Loads a compiled contract from `out/<sourceFile>.sol/<contractName>.json`.
 * @throws When the artifact does not exist or holds no creation bytecode.
 */
export const loadArtifact = (sourceFile: string, contractName: string): Artifact => {
  const path = artifactPath(sourceFile, contractName)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`Artifact ${path} is not an object`)
  const { abi, bytecode } = parsed as { abi?: Abi; bytecode?: { object?: Hex } }
  if (!abi) throw new Error(`Artifact ${path} has no abi`)
  if (!bytecode?.object || bytecode.object === '0x') throw new Error(`Artifact ${path} has no creation bytecode`)
  return { abi, bytecode: bytecode.object }
}

/** The compiled contracts that the harness deploys. */
export const artifacts = {
  vault: () => loadArtifact('ZKBridgeVault', 'ZKBridgeVault'),
  lightClient: () => loadArtifact('LightClientSync', 'LightClientSync'),
  verifier: () => loadArtifact('MockSP1Verifier', 'MockSP1Verifier'),
  token: () => loadArtifact('MockERC20', 'MockERC20'),
  fakeEmitter: () => loadArtifact('FakeDepositEmitter', 'FakeDepositEmitter'),
  feeOnTransferToken: () => loadArtifact('FeeOnTransferToken', 'FeeOnTransferToken'),
} as const
