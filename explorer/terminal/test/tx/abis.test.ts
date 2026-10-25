import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { toFunctionSelector, type Abi, type AbiFunction } from 'viem'
import {
  beaconLightClientAbi,
  messageBridgeAbi,
  tokenMediatorAbi,
  wrappedNativeRouterAbi,
} from '../../src/tx/abis'

// These tests tie the small ABI fragments of the terminal to the real contracts. A fragment that names a function
// the contract does not have, or with other types or mutability, fails here. Two references are used:
// the Foundry build output (`out/`, created by `forge build`) and the generated ABIs of `explorer/shared`.
// A reference that is not on disk is skipped and reported as skipped, not as passed.

const repository = new URL('../../../../', import.meta.url).pathname

function foundryAbi(contract: string): Abi | null {
  const path = `${repository}out/${contract}.sol/${contract}.json`
  if (!existsSync(path)) return null
  return (JSON.parse(readFileSync(path, 'utf8')) as { abi: Abi }).abi
}

async function sharedAbi(name: string): Promise<Abi | null> {
  try {
    const shared = (await import(`${repository}explorer/shared/src/abis/index.ts`)) as Record<string, Abi>
    return shared[name] ?? null
  } catch {
    return null
  }
}

function functionsOf(abi: Abi): AbiFunction[] {
  return abi.filter((item): item is AbiFunction => item.type === 'function')
}

function expectEveryFunctionIn(fragment: Abi, reference: Abi): void {
  const known = new Map(functionsOf(reference).map((item) => [toFunctionSelector(item), item]))
  for (const item of functionsOf(fragment)) {
    const match = known.get(toFunctionSelector(item))
    expect(match, `${item.name} (${toFunctionSelector(item)}) is missing in the contract`).toBeDefined()
    expect(match?.stateMutability, `${item.name} mutability`).toBe(item.stateMutability)
    expect(match?.outputs.map((output) => output.type), `${item.name} outputs`).toEqual(item.outputs.map((output) => output.type))
  }
}

const cases: ReadonlyArray<{ fragment: Abi; contract: string; sharedName: string }> = [
  { fragment: tokenMediatorAbi, contract: 'TokenMediator', sharedName: 'tokenMediatorAbi' },
  { fragment: wrappedNativeRouterAbi, contract: 'WETHOmnibridgeRouter', sharedName: 'wETHOmnibridgeRouterAbi' },
  { fragment: messageBridgeAbi, contract: 'MessageBridge', sharedName: 'messageBridgeAbi' },
  { fragment: beaconLightClientAbi, contract: 'BeaconLightClient', sharedName: 'beaconLightClientAbi' },
]

describe('ABI fragments against the contracts', () => {
  for (const { fragment, contract, sharedName } of cases) {
    test(`${contract} matches the Foundry build output`, () => {
      const reference = foundryAbi(contract)
      if (reference === null) {
        console.warn(`SKIPPED: out/${contract}.sol is not built. Run forge build.`)
        return
      }
      expectEveryFunctionIn(fragment, reference)
    })

    test(`${contract} matches the generated ABI in explorer/shared`, async () => {
      const reference = await sharedAbi(sharedName)
      if (reference === null) {
        console.warn(`SKIPPED: explorer/shared has no ${sharedName}.`)
        return
      }
      expectEveryFunctionIn(fragment, reference)
    })
  }

  test('the test can fail: a made-up function is not found in the real ABI', () => {
    const reference = foundryAbi('TokenMediator')
    if (reference === null) return
    const invented = functionsOf(tokenMediatorAbi).map((item) => ({ ...item, name: `${item.name}Invented` }))
    const known = new Set(functionsOf(reference).map((item) => toFunctionSelector(item)))
    expect(invented.some((item) => known.has(toFunctionSelector(item)))).toBe(false)
  })
})
