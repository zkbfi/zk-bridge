import { afterEach, describe, expect, test } from 'bun:test'
import Eth from '@ledgerhq/hw-app-eth'
import { createFixtureChainAccess } from '../../src/chain/fixture-chain-access'
import { FIXTURE_PAIR } from '../../src/data/fixtures'
import { signerFromKeystoreFile } from '../../src/signing/key-sources'
import { createLedgerSource } from '../../src/signing/ledger'
import { SimulatedLedgerTransport } from '../signing/simulated-ledger'
import { TEST_KEY, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

// The public "abandon ... about" mnemonic and the first Anvil key. Both are published test values.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const KEYSTORE_PATH = new URL('../fixtures/cast-keystore.json', import.meta.url).pathname
const KEYSTORE_PASSWORD = 'correct horse battery staple'

/** Records every frame so a test can check that a secret never appeared in any of them. */
function recorder(target: App) {
  const frames: string[] = []
  return {
    frames,
    record: () => frames.push(target.frame()),
    neverContains: (secret: string) => frames.every((frame) => !frame.includes(secret)),
  }
}

async function openSignerChoice(target: App, downs: number) {
  await target.press('RETURN') // the first action is "Account and signer"
  for (let step = 0; step < downs; step += 1) await target.press('ARROW_DOWN')
  await target.press('RETURN')
}

describe('signer dialog', () => {
  test('a typed private key is masked, never drawn, and connects the account', async () => {
    app = await renderApp({ width: 120, height: 40 })
    const seen = recorder(app)
    await openSignerChoice(app, 0)
    seen.record()
    await app.type(TEST_KEY.slice(2))
    seen.record()
    const typing = app.frame()
    expect(typing).toContain('(64 characters)')
    expect(typing).toContain('****')
    await app.press('RETURN')
    await app.settle(60)
    seen.record()
    expect(app.frame()).toContain('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(app.frame()).toContain('private key')
    expect(seen.neverContains(TEST_KEY.slice(2, 20))).toBe(true)
    expect(seen.neverContains(TEST_KEY.slice(-16))).toBe(true)
  })

  test('a pasted mnemonic is masked, then the derived addresses are listed to choose from', async () => {
    app = await renderApp({ width: 120, height: 40 })
    const seen = recorder(app)
    await openSignerChoice(app, 3)
    await app.paste(MNEMONIC)
    seen.record()
    expect(app.frame()).toContain(`(${MNEMONIC.length} characters)`)
    expect(app.frame()).not.toContain('abandon')
    await app.press('TAB') // passphrase
    await app.press('RETURN')
    await app.settle(80)
    seen.record()
    const list = app.frame()
    expect(list).toContain('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    expect(list).toContain('0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0')
    expect(list).toContain("m/44'/60'/0'/0/{index}")
    // Each row shows the balance on both chains.
    expect(list).toMatch(/\d+ ETH \| \d+ PLS/)
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(80)
    seen.record()
    expect(app.frame()).toContain('0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0')
    expect(app.frame()).toContain("mnemonic m/44'/60'/0'/0/1")
    expect(seen.neverContains('abandon')).toBe(true)
  })

  test('the address list pages forward and back, and a custom path changes the addresses', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSignerChoice(app, 3)
    await app.paste(MNEMONIC)
    await app.press('RETURN')
    await app.settle(80)
    await app.press('n')
    await app.settle(80)
    expect(app.frame()).toContain('page 2')
    expect(app.frame()).not.toContain('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    await app.press('p')
    await app.settle(80)
    expect(app.frame()).toContain('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    await app.press('t')
    for (let count = 0; count < 30; count += 1) await app.press('BACKSPACE')
    await app.type("m/44'/60'/1'/0/{index}")
    await app.press('RETURN')
    await app.settle(80)
    expect(app.frame()).toContain('0x78839F6054d7ed13918bAe0473BA31b1Ca9D7265')
  })

  test('an invalid mnemonic is refused without echoing it', async () => {
    app = await renderApp({ width: 120, height: 40 })
    const seen = recorder(app)
    await openSignerChoice(app, 3)
    await app.paste('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')
    await app.press('RETURN')
    await app.settle(60)
    seen.record()
    expect(app.frame()).toContain('The mnemonic is not valid')
    expect(seen.neverContains('abandon')).toBe(true)
  })

  test('a keystore asks for the password without echo, refuses a wrong one, and opens with the right one', async () => {
    app = await renderApp({
      width: 120,
      height: 40,
      signing: {
        fileHints: { privateKeyFile: undefined, keystoreFile: KEYSTORE_PATH, mnemonicFile: undefined, handoffFile: undefined, evidenceFile: undefined },
        signerFromKeystoreFile,
      },
    })
    const seen = recorder(app)
    await openSignerChoice(app, 2)
    await app.press('TAB')
    await app.type('wrong-password-123')
    seen.record()
    await app.press('RETURN')
    await app.settle(300)
    seen.record()
    expect(app.frame()).toContain('Wrong password')
    for (let count = 0; count < 20; count += 1) await app.press('BACKSPACE')
    await app.type(KEYSTORE_PASSWORD)
    seen.record()
    await app.press('RETURN')
    await app.settle(300)
    seen.record()
    expect(app.frame()).toContain('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(seen.neverContains('wrong-password-123')).toBe(true)
    expect(seen.neverContains(KEYSTORE_PASSWORD)).toBe(true)
  })

  test('a secret from the startup environment is used when the field is left empty, and is not shown', async () => {
    app = await renderApp({
      width: 120,
      height: 40,
      signing: { startupSecrets: { privateKey: TEST_KEY, mnemonic: undefined, mnemonicPassphrase: undefined } },
    })
    await openSignerChoice(app, 0)
    expect(app.frame()).toContain('Empty uses EXPLORER_PRIVATE_KEY from startup.')
    expect(app.frame()).not.toContain(TEST_KEY.slice(2, 20))
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
  })

  test('Disconnect clears the signer and the balances', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await openSignerChoice(app, 0)
    await app.type(TEST_KEY.slice(2))
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('0xf39F')
    await app.press('RETURN')
    for (let step = 0; step < 6; step += 1) await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.settle(60)
    expect(app.frame()).toContain('no signer connected')
  })
})

describe('Ledger on the simulated device, end to end', () => {
  test('lists addresses, selects one, and signs a bridge transaction on the device after confirmation', async () => {
    const transport = new SimulatedLedgerTransport('approve')
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    app = await renderApp({
      width: 120,
      height: 40,
      chainAccess,
      signing: {
        ledgerSource: (input) => createLedgerSource({ ...input, connect: async () => ({ app: new Eth(transport), close: () => transport.close() }) }),
      },
    })
    await openSignerChoice(app, 4)
    await app.settle(120)
    expect(app.frame()).toContain('0x9858EfFD232B4033E47d90003D41EC34EcaEda94')
    await app.press('RETURN')
    await app.settle(120)
    expect(app.frame()).toContain("Ledger m/44'/60'/0'/0/0")
    // Bridge tokens: open the form, type an amount, review.
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.press('TAB')
    await app.type('1')
    await app.press('TAB') // receiver
    await app.press('TAB') // tip for delivery
    await app.press('ARROW_RIGHT') // no tip: a plain relay
    await app.press('RETURN')
    await app.settle(100)
    expect(app.frame()).toContain('Relay USDC to the other chain')
    expect(transport.signedPayloads).toHaveLength(0)
    expect(chainAccess.sentTransactions).toHaveLength(0)
    await app.press('y')
    await app.settle(200)
    expect(transport.signedPayloads).toHaveLength(1)
    expect(chainAccess.sentTransactions).toHaveLength(1)
    expect(app.frame()).toContain('All transactions are mined.')
  })

  test('a rejection on the device ends in an error and nothing is sent', async () => {
    const transport = new SimulatedLedgerTransport('approve')
    const chainAccess = createFixtureChainAccess(FIXTURE_PAIR, { allowance: 10n ** 30n })
    app = await renderApp({
      width: 120,
      height: 40,
      chainAccess,
      signing: {
        ledgerSource: (input) => createLedgerSource({ ...input, connect: async () => ({ app: new Eth(transport), close: () => transport.close() }) }),
      },
    })
    await openSignerChoice(app, 4)
    await app.settle(120)
    await app.press('RETURN')
    await app.settle(120)
    await app.press('ARROW_DOWN')
    await app.press('RETURN')
    await app.press('TAB')
    await app.type('1')
    await app.press('RETURN')
    await app.settle(100)
    transport.behavior = 'reject'
    await app.press('y')
    await app.settle(200)
    expect(app.frame()).toContain('You rejected the request on the device')
    expect(chainAccess.sentTransactions).toHaveLength(0)
  })
})
