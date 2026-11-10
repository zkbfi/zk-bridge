/**
 * The deposit gate in the review modal: the modal asks the shared gate check on the chain's flow client with the
 * connection's beacon endpoints, shows the wait, and shows an inserted confirmation and its gas like any other step.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { createHash } from 'node:crypto'
import { act } from 'react'
import { numberToHex, padHex, type Hex } from 'viem'
import { ServicesProvider } from '../../src/app/services'
import { SessionProvider } from '../../src/app/session'
import type { ChainAccess } from '../../src/chain/chain-access'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import type { ConnectionRuntime } from '../../src/data/connection-runtime'
import { FIXTURE_PAIR, FIXTURE_TOKENS } from '../../src/data/fixtures'
import { signerFromPrivateKeyText } from '../../src/signing/key-sources'
import { planGateConfirm, withKnownGas } from '../../src/tx/gate-step'
import { planRelay } from '../../src/tx/plan'
import { prepareTransaction } from '../../src/tx/prepare'
import { KeyRouterProvider } from '../../src/ui/key-router'
import { gateWaitLines, ReviewModal } from '../../src/ui/modals'
import { reviewLines } from '../../src/ui/review-lines'
import { confirmAnswer } from '../support/gate-fixture'
import { TEST_KEY, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
const realFetch = globalThis.fetch
afterEach(() => {
  app?.destroy()
  app = null
  globalThis.fetch = realFetch
})

const chain = FIXTURE_PAIR.first
const relayPlan = planRelay({ chain, token: FIXTURE_TOKENS[0]!, receiver: '0x0000000000000000000000000000000000000abc', amount: 1_000_000n, mode: { kind: 'plain' } })
const textOf = (lines: readonly (readonly { readonly text: string }[])[]) => lines.map((line) => line.map((part) => part.text).join('')).join('\n')

/** The SSZ root of a beacon block header: five fields in eight leaves, merkleized with SHA-256. */
function headerRoot(header: { slot: bigint; proposerIndex: bigint; parentRoot: Hex; stateRoot: Hex; bodyRoot: Hex }): Hex {
  const uint = (value: bigint) => {
    const bytes = Buffer.alloc(32)
    bytes.writeBigUInt64LE(value)
    return bytes
  }
  const leaf = (hex: Hex) => Buffer.from(hex.slice(2), 'hex')
  let layer: Buffer[] = [uint(header.slot), uint(header.proposerIndex), leaf(header.parentRoot), leaf(header.stateRoot), leaf(header.bodyRoot), Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32)]
  while (layer.length > 1) {
    const next: Buffer[] = []
    for (let index = 0; index < layer.length; index += 2) next.push(createHash('sha256').update(Buffer.concat([layer[index]!, layer[index + 1]!])).digest())
    layer = next
  }
  return `0x${layer[0]!.toString('hex')}`
}

/**
 * A chain whose gate enforces and has not confirmed epoch 100, and whose newest beacon header on chain is of epoch 99:
 * the gate check answers `wait` for a slot.
 */
function enforcingGateChain(): { chainAccess: ChainAccess; header: Record<string, unknown>; root: Hex } {
  const header = { slot: 99n * 32n, proposerIndex: 7n, parentRoot: `0x${'11'.repeat(32)}` as Hex, stateRoot: `0x${'22'.repeat(32)}` as Hex, bodyRoot: `0x${'33'.repeat(32)}` as Hex }
  const root = headerRoot(header)
  const base = createFixtureChainAccess(FIXTURE_PAIR)
  const answers: Record<string, unknown> = {
    mode: 0,
    enforcing: true,
    isSealed: false,
    confirmedEpoch: [99n, true],
    genesisTime: 0n,
    secondsPerSlot: 12n,
    slotsPerEpoch: 32n,
    genesisValidatorsRoot: `0x${'d8'.repeat(32)}`,
    beaconRoots: '0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02',
  }
  const flowClient = {
    ...base.flowClient(chain.chainId),
    getBlock: async () => ({ number: 100n, timestamp: 384n * 100n, parentBeaconBlockRoot: root }),
    readContract: async ({ functionName }: { functionName: string }) => answers[functionName],
    call: async ({ data }: { data: Hex }) => {
      expect(data).toBe(padHex(numberToHex(384n * 100n), { size: 32 }))
      return { data: root }
    },
  }
  return {
    chainAccess: { ...base, flowClient: () => flowClient },
    header: { slot: header.slot.toString(), proposer_index: '7', parent_root: header.parentRoot, state_root: header.stateRoot, body_root: header.bodyRoot },
    root,
  }
}

describe('the review modal and the deposit gate', () => {
  test('asks the gate with the beacon endpoint in force, shows the wait, and Esc cancels it', async () => {
    app = await renderApp({ width: 120, height: 40 })
    const { chainAccess, header, root } = enforcingGateChain()
    const asked: string[] = []
    globalThis.fetch = (async (url: string) => {
      asked.push(url)
      return new Response(JSON.stringify({ data: { header: { message: header } } }), { status: 200 })
    }) as unknown as typeof fetch
    const connection = { resolved: () => ({ beaconUrls: { [chain.chainId]: { value: 'https://beacon.example', source: 'user' } } }) } as unknown as ConnectionRuntime
    const closed: string[] = []
    const setup = await testRender(
      <ServicesProvider services={{ ...app.services, chainAccess, connection }}>
        <KeyRouterProvider>
          <SessionProvider pairId={app.services.defaultPairId} initialSigner={signerFromPrivateKeyText(TEST_KEY)}>
            <ReviewModal title="Review" steps={[{ plan: relayPlan, skippable: false }]} onClose={() => closed.push('closed')} />
          </SessionProvider>
        </KeyRouterProvider>
      </ServicesProvider>,
      { width: 120, height: 40 },
    )
    try {
      let frame = ''
      for (let attempt = 0; attempt < 100 && !frame.includes('Waiting for the deposit gate'); attempt += 1) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          await setup.renderOnce()
        })
        frame = setup.captureCharFrame()
      }
      expect(frame).toContain('Waiting for the deposit gate')
      expect(frame).toContain('The beacon header of epoch 100 is not on Ethereum yet.')
      expect(frame).toContain('Esc cancel')
      // The fork cutover reads the schedule of the source chain from the same endpoint, then the gate asks for the header.
      expect(asked).toContain('https://beacon.example/eth/v1/config/fork_schedule')
      expect(asked.filter((url) => url.includes('/headers/'))).toEqual([`https://beacon.example/eth/v1/beacon/headers/${root}`])
      await act(async () => {
        setup.mockInput.pressEscape()
        await new Promise((resolve) => setTimeout(resolve, 400))
      })
      expect(closed).toEqual(['closed'])
    } finally {
      setup.renderer.destroy()
    }
  })
})

describe('the review of a confirmation step', () => {
  test('shows the step, its position, the gate and the simulated gas with its margin, like the approval step', async () => {
    const plan = planGateConfirm(chain, confirmAnswer())
    const client = createFixtureChainAccess(FIXTURE_PAIR).flowClient(chain.chainId)
    const prepared = await prepareTransaction(withKnownGas(client, 150_000n), signerFromPrivateKeyText(TEST_KEY).address, plan)
    const text = textOf(reviewLines(prepared, { position: 'Step 1 of 2', calldata: 'summary', wrapWidth: 96 }))
    expect(text).toContain('Step 1 of 2')
    expect(text).toContain('Confirm this epoch on the gate (epoch 360335)')
    expect(text).toContain('Ethereum deposit gate (BeaconForkGate)')
    expect(text).toContain('confirm(bytes)')
    expect(text).toContain('estimate 150000, limit 180000')
    expect(text).toContain('It must be mined before 08:00:00 UTC, the end of epoch 360335.')
  })

  test('the wait for the next epoch says how much of the epoch was left', () => {
    const text = textOf(gateWaitLines({ chainName: 'Sepolia', epoch: 5n, seconds: 32, epochSecondsLeft: 20 }))
    expect(text).toContain('Epoch 5 ends in 20 seconds: too soon for a confirmation to be mined in it. The Sepolia deposit gate is checked again in 32 seconds, in the next epoch.')
    expect(textOf(gateWaitLines({ chainName: 'Sepolia', epoch: 5n, seconds: 44, epochSecondsLeft: -3 }))).toContain('Epoch 5 ends in 0 seconds')
  })
})
