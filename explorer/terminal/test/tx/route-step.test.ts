import { describe, expect, test } from 'bun:test'
import { beaconLightClientAbi, messageBridgeAbi, type StepProof } from '@zk-bridge/shared'
import { decodeFunctionData, encodeFunctionData, getAddress, type Hex } from 'viem'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { PlanInputError } from '../../src/tx/plan'
import { planOpenDeposits, planRegistryUpdate } from '../../src/tx/route-step'

const chain = FIXTURE_PAIR.second
const hash = (digit: string): Hex => `0x${digit.repeat(64)}`
const registryLightClient = '0x00000000000000000000000000000000000000d9' as const

const registryProof = (over: Partial<Extract<StepProof, { kind: 'registry-light-client-update' }>> = {}): Extract<StepProof, { kind: 'registry-light-client-update' }> => ({
  kind: 'registry-light-client-update',
  subject: String(chain.chainId),
  chainId: chain.chainId,
  lightClient: registryLightClient,
  programKey: hash('a'),
  startSlot: 1000,
  startRoot: hash('1'),
  newSlot: 1320,
  newRoot: hash('2'),
  publicValues: '0x1234',
  proof: '0xabcdef',
  provedAt: 1,
  ...over,
})

const openingArguments = {
  remoteSlot: 99n,
  remoteHeaderRlp: '0xf8' as Hex,
  accountProof: ['0x01'] as Hex[],
  storedSlot: 90n,
  storageProof: ['0x02', '0x03'] as Hex[],
}
const openingCalldata = encodeFunctionData({ abi: messageBridgeAbi, functionName: 'openDeposits', args: [openingArguments] })

const openProof = (over: Partial<Extract<StepProof, { kind: 'open-deposits' }>> = {}): Extract<StepProof, { kind: 'open-deposits' }> => ({
  kind: 'open-deposits',
  subject: 'first-to-second',
  chainId: chain.chainId,
  bridge: chain.contracts.messageBridge,
  calldata: openingCalldata,
  remoteSlot: 99,
  storedSlot: 90,
  remoteBlockNumber: 1234,
  provedAt: 1,
  ...over,
})

describe('planRegistryUpdate', () => {
  test('is update(bytes,bytes) on the registry light client, with the slots and the program key in the notes', () => {
    const plan = planRegistryUpdate(chain, registryProof())
    expect(plan).toMatchObject({
      title: 'Update the PulseChain fork registry light client',
      to: getAddress(registryLightClient),
      contractLabel: 'PulseChain fork registry light client (BeaconLightClient)',
      functionSignature: 'update(bytes,bytes)',
      functionName: 'update',
      value: 0n,
    })
    expect(decodeFunctionData({ abi: beaconLightClientAbi, data: plan.data }).args).toEqual(['0xabcdef', '0x1234'])
    expect(plan.arguments.map((entry) => entry.name)).toEqual(['proof', 'publicValues'])
    expect(plan.notes[0]).toContain('slot 1000 to slot 1320')
    expect(plan.notes.join(' ')).toContain(`program key ${hash('a')}`)
    expect(plan.notes.at(-1)).toContain('sends no PLS')
  })
})

describe('planOpenDeposits', () => {
  test('is openDeposits on the bridge with its arguments decoded', () => {
    const plan = planOpenDeposits(chain, openProof())
    expect(plan).toMatchObject({ to: getAddress(chain.contracts.messageBridge), contractLabel: 'PulseChain message bridge (MessageBridge)', functionName: 'openDeposits', value: 0n, data: openingCalldata })
    expect(plan.functionSignature).toStartWith('openDeposits(')
    expect(plan.arguments.map((entry) => entry.name)).toEqual(['proof.remoteSlot', 'proof.remoteHeaderRlp', 'proof.accountProof', 'proof.storedSlot', 'proof.storageProof'])
    expect(plan.arguments[0]!.value).toBe('99')
    expect(plan.notes[0]).toContain('slot 99')
    expect(plan.notes[0]).toContain('block 1,234')
  })

  test('refuses calldata that is not openDeposits', () => {
    const other = encodeFunctionData({ abi: messageBridgeAbi, functionName: 'remoteBridge' })
    expect(() => planOpenDeposits(chain, openProof({ calldata: other }))).toThrow(PlanInputError)
    expect(() => planOpenDeposits(chain, openProof({ calldata: '0x12345678' }))).toThrow('not a call to openDeposits')
    expect(() => planOpenDeposits(chain, openProof({ calldata: '0x' }))).toThrow(PlanInputError)
  })

  test('refuses a bridge that is not the bridge of the chain, and a proof for another chain', () => {
    expect(() => planOpenDeposits(chain, openProof({ bridge: '0x00000000000000000000000000000000000000ee' }))).toThrow('not the PulseChain message bridge')
    expect(() => planOpenDeposits(chain, openProof({ chainId: 1 }))).toThrow('another chain')
  })
})
