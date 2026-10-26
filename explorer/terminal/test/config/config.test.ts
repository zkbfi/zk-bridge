import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testDryProofRequest, testEndpointPing, testMsgboardStatus, testRpcChainId, type HttpClient } from '../../src/config/connection-tests'
import {
  chooseSecretStore,
  type CommandRunner,
  createEncryptedFileStore,
  createKeychainStore,
  createSecretServiceStore,
  decryptSecrets,
  emptyProverSetup,
  encryptSecrets,
  loadProverSetup,
  maskSecret,
  parseProverSetup,
  parseReferenceText,
  ProverSetupError,
  REDACTED,
  redactError,
  redactSecrets,
  referenceText,
  resolveSecretReference,
  saveProverSetup,
  SecretResolutionError,
  WrongPasswordError,
} from '@zk-bridge/shared/config'

// Made-up values with the real shapes. None is a live key.
const RUNPOD_KEY = 'rpa_TESTONLY1234567890abcdefghijkl'
const VALVE_KEY = 'vk_TESTONLY0987654321zyxwvu'

const scratch: string[] = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'explorer-config-test-'))
  scratch.push(directory)
  return directory
}

describe('maskSecret', () => {
  test('shows only the last four characters of a long secret', () => {
    const masked = maskSecret(RUNPOD_KEY)
    expect(masked).toBe(`********${RUNPOD_KEY.slice(-4)}`)
    expect(masked).not.toContain(RUNPOD_KEY.slice(0, RUNPOD_KEY.length - 4))
  })

  test('shows nothing of a short secret, and nothing of an empty one', () => {
    expect(maskSecret('short')).toBe('********')
    expect(maskSecret('abcdefghijk')).toBe('********')
    expect(maskSecret('')).toBe('')
  })

  test('the mask does not reveal the length', () => {
    expect(maskSecret('a'.repeat(20)).length).toBe(maskSecret('a'.repeat(200)).length)
  })
})

describe('redactSecrets', () => {
  test('removes vk_ tokens and RunPod keys wherever they appear', () => {
    const text = `GET https://one.valve.city/rpc/${VALVE_KEY}/evm/1 failed; key ${RUNPOD_KEY}; also ${VALVE_KEY}`
    const clean = redactSecrets(text)
    expect(clean).not.toContain(VALVE_KEY)
    expect(clean).not.toContain(RUNPOD_KEY)
    expect(clean).toContain(REDACTED)
    expect(clean).toContain('/evm/1')
  })

  test('removes bearer credentials, query keys, JSON fields and URL credentials', () => {
    const clean = redactSecrets(
      'Authorization: Bearer abcdef1234567890XYZ https://x.example/y?api_key=SECRETVALUE99&b=1 {"apiKey":"SECRETVALUE99"} https://user:SECRETVALUE99@host/p',
    )
    expect(clean).not.toContain('abcdef1234567890XYZ')
    expect(clean).not.toContain('SECRETVALUE99')
    expect(clean).toContain('b=1')
    expect(clean).toContain('https://[redacted]@host/p')
  })

  test('removes a key of the keyed path form even without a known prefix', () => {
    expect(redactSecrets('https://one.valve.city/rpc/Zk9Qx3Lm8PabCdEf/evm/369')).toBe(`https://one.valve.city/rpc/${REDACTED}/evm/369`)
  })

  test('removes every occurrence of a known secret, whatever its shape', () => {
    const odd = 'plain-looking-secret'
    expect(redactSecrets(`a ${odd} b ${odd}`, [odd])).toBe(`a ${REDACTED} b ${REDACTED}`)
  })

  test('leaves public values alone: hashes, addresses and ordinary words', () => {
    const text = `tx 0x${'ab'.repeat(32)} to 0x${'12'.repeat(20)} chain 369 failed`
    expect(redactSecrets(text)).toBe(text)
  })

  test('redactError uses the message only', () => {
    const error = Object.assign(new Error(`bad key ${VALVE_KEY}`), { headers: { Authorization: `Bearer ${RUNPOD_KEY}` } })
    expect(redactError(error)).toBe(`bad key ${REDACTED}`)
  })
})

describe('encrypted file', () => {
  test('round trips secrets with the right password', async () => {
    const secrets = { 'a.key': RUNPOD_KEY, 'b.url': `https://one.valve.city/rpc/${VALVE_KEY}/evm/1` }
    const text = await encryptSecrets(secrets, 'correct horse')
    expect(await decryptSecrets(text, 'correct horse')).toEqual(secrets)
  })

  test('holds no secret in clear, and uses a new salt and nonce each time', async () => {
    const first = await encryptSecrets({ k: RUNPOD_KEY }, 'pw')
    const second = await encryptSecrets({ k: RUNPOD_KEY }, 'pw')
    expect(first).not.toContain(RUNPOD_KEY)
    expect(first).not.toContain('rpa_')
    expect(JSON.parse(first).salt).not.toBe(JSON.parse(second).salt)
    expect(JSON.parse(first).nonce).not.toBe(JSON.parse(second).nonce)
    expect(JSON.parse(first).ciphertext).not.toBe(JSON.parse(second).ciphertext)
  })

  test('a wrong password and a changed byte both fail the authentication tag', async () => {
    const text = await encryptSecrets({ k: RUNPOD_KEY }, 'right')
    await expect(decryptSecrets(text, 'wrong')).rejects.toBeInstanceOf(WrongPasswordError)
    const file = JSON.parse(text)
    file.ciphertext = `${file.ciphertext.slice(0, -2)}${file.ciphertext.endsWith('00') ? '01' : '00'}`
    await expect(decryptSecrets(JSON.stringify(file), 'right')).rejects.toBeInstanceOf(WrongPasswordError)
  })

  test('the store keeps values across instances, with mode 0600, and deletes them', async () => {
    const path = join(await scratchDirectory(), 'nested', 'secrets.enc.json')
    const store = createEncryptedFileStore({ path, password: 'pw' })
    await store.set('one', RUNPOD_KEY)
    await store.set('two', VALVE_KEY)
    expect(await createEncryptedFileStore({ path, password: 'pw' }).get('one')).toBe(RUNPOD_KEY)
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    expect(await readFile(path, 'utf8')).not.toContain(RUNPOD_KEY)
    await store.delete('one')
    expect(await store.get('one')).toBeNull()
    expect(await store.get('two')).toBe(VALVE_KEY)
    expect(await store.get('never-set')).toBeNull()
  })

  test('a store with the wrong password cannot read or overwrite the file', async () => {
    const path = join(await scratchDirectory(), 'secrets.enc.json')
    await createEncryptedFileStore({ path, password: 'right' }).set('k', RUNPOD_KEY)
    const wrong = createEncryptedFileStore({ path, password: 'wrong' })
    await expect(wrong.get('k')).rejects.toBeInstanceOf(WrongPasswordError)
    await expect(wrong.set('other', 'x')).rejects.toBeInstanceOf(WrongPasswordError)
    expect(await createEncryptedFileStore({ path, password: 'right' }).get('k')).toBe(RUNPOD_KEY)
  })
})

describe('operating system stores', () => {
  function recordingRunner(answer: { code: number; stdout?: string; stderr?: string } = { code: 0 }) {
    const calls: Array<{ command: string; args: readonly string[]; standardInput: string | undefined }> = []
    const run: CommandRunner = async (command, args, standardInput) => {
      calls.push({ command, args, standardInput })
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    }
    return { run, calls }
  }

  test('the Keychain store sends the secret on the standard input and never in an argument', async () => {
    const { run, calls } = recordingRunner()
    await createKeychainStore(run).set('explorer.prover.runpod-api-key', RUNPOD_KEY)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe('security')
    expect(calls[0]?.args.join(' ')).not.toContain(RUNPOD_KEY)
    expect(calls[0]?.standardInput).toContain(RUNPOD_KEY)
    expect(calls[0]?.args).toEqual(['-i'])
  })

  test('the Keychain store refuses a value that would break the command, and reads one back', async () => {
    const { run } = recordingRunner({ code: 0, stdout: `${RUNPOD_KEY}\n` })
    const store = createKeychainStore(run)
    await expect(store.set('n', 'has"quote')).rejects.toThrow(/quote/)
    expect(await store.get('n')).toBe(RUNPOD_KEY)
    expect(await createKeychainStore(recordingRunner({ code: 44 }).run).get('n')).toBeNull()
  })

  test('a failed Keychain write reports the failure without the secret', async () => {
    const { run } = recordingRunner({ code: 1, stderr: `could not store ${RUNPOD_KEY}` })
    const error = await createKeychainStore(run).set('n', RUNPOD_KEY).catch((caught: Error) => caught)
    expect((error as Error).message).not.toContain(RUNPOD_KEY)
  })

  test('the Secret Service store sends the secret on the standard input', async () => {
    const { run, calls } = recordingRunner()
    await createSecretServiceStore(run).set('n', VALVE_KEY)
    expect(calls[0]?.command).toBe('secret-tool')
    expect(calls[0]?.args.join(' ')).not.toContain(VALVE_KEY)
    expect(calls[0]?.standardInput).toBe(VALVE_KEY)
  })

  test('chooseSecretStore picks the platform store, and falls back to the encrypted file', async () => {
    const fallbackStore = createEncryptedFileStore({ path: join(await scratchDirectory(), 's.json'), password: 'pw' })
    const fallback = async () => fallbackStore
    const working = recordingRunner({ code: 0, stdout: 'ok' }).run
    const missing: CommandRunner = async () => {
      throw new Error('not found')
    }
    expect((await chooseSecretStore({ platform: 'darwin', run: working, fallback })).kind).toBe('macos-keychain')
    expect((await chooseSecretStore({ platform: 'linux', run: working, fallback })).kind).toBe('secret-service')
    expect((await chooseSecretStore({ platform: 'linux', run: missing, fallback })).kind).toBe('encrypted-file')
    expect((await chooseSecretStore({ platform: 'win32', run: working, fallback })).kind).toBe('encrypted-file')
  })
})

describe('secret references', () => {
  test('parses env and op references and refuses anything else', () => {
    expect(parseReferenceText('env:RUNPOD_API_KEY')).toEqual({ source: 'environment', variable: 'RUNPOD_API_KEY' })
    expect(parseReferenceText('op://vault/item/field')).toEqual({ source: 'onepassword', reference: 'op://vault/item/field' })
    for (const text of ['rpa_literalkey12345', 'env:bad name', 'op://vault/item', 'https://x']) {
      expect(() => parseReferenceText(text)).toThrow(ProverSetupError)
    }
  })

  test('resolves from the environment, 1Password and the store', async () => {
    const calls: string[][] = []
    const run: CommandRunner = async (_command, args) => {
      calls.push([...args])
      return { code: 0, stdout: RUNPOD_KEY, stderr: '' }
    }
    const path = join(await scratchDirectory(), 's.json')
    const store = createEncryptedFileStore({ path, password: 'pw' })
    await store.set('n', VALVE_KEY)
    const dependencies = { store, environment: { FROM_ENV: 'value-from-env' }, run }
    expect(await resolveSecretReference({ source: 'environment', variable: 'FROM_ENV' }, dependencies)).toBe('value-from-env')
    expect(await resolveSecretReference({ source: 'onepassword', reference: 'op://v/i/f' }, dependencies)).toBe(RUNPOD_KEY)
    expect(calls[0]).toEqual(['read', '--no-newline', 'op://v/i/f'])
    expect(await resolveSecretReference({ source: 'store', name: 'n' }, dependencies)).toBe(VALVE_KEY)
    await expect(resolveSecretReference({ source: 'environment', variable: 'MISSING' }, dependencies)).rejects.toBeInstanceOf(SecretResolutionError)
    await expect(resolveSecretReference({ source: 'store', name: 'absent' }, dependencies)).rejects.toBeInstanceOf(SecretResolutionError)
  })
})

describe('setup file', () => {
  test('saves and loads references, and the file holds no secret value', async () => {
    const path = join(await scratchDirectory(), 'prover-setup.json')
    const setup = {
      ...emptyProverSetup(),
      endpointUrl: 'https://abc123.api.runpod.ai',
      runpodApiKey: { source: 'store' as const, name: 'explorer.prover.runpod-api-key' },
      msgboardUrl: { source: 'environment' as const, variable: 'MSGBOARD_URL' },
      chains: { '369': { rpc: { source: 'onepassword' as const, reference: 'op://v/i/f' }, beacon: null } },
    }
    await saveProverSetup(path, setup)
    expect(await loadProverSetup(path)).toEqual(setup)
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    expect(referenceText(setup.runpodApiKey)).toContain('stored')
  })

  test('refuses a file that holds a secret value where a reference belongs', async () => {
    const path = join(await scratchDirectory(), 'prover-setup.json')
    await writeFile(path, JSON.stringify({ ...emptyProverSetup(), runpodApiKey: RUNPOD_KEY }))
    await expect(loadProverSetup(path)).rejects.toBeInstanceOf(ProverSetupError)
    const withCredentialsInUrl = { ...emptyProverSetup(), endpointUrl: `https://user:pw@x.api.runpod.ai/?api_key=${RUNPOD_KEY}` }
    expect(() => parseProverSetup(JSON.parse(JSON.stringify(withCredentialsInUrl)))).toThrow(ProverSetupError)
    expect(() => parseProverSetup({ ...emptyProverSetup(), endpointUrl: 'http://remote.example.com' })).toThrow(/https/)
  })

  test('a missing file gives the empty setup', async () => {
    expect(await loadProverSetup(join(await scratchDirectory(), 'absent.json'))).toEqual(emptyProverSetup())
  })
})

describe('connection tests', () => {
  const endpointUrl = 'https://abc123.api.runpod.ai'

  test('ping passes on 200 and 204, sends the key as a bearer header, and fails on 401 without the key', async () => {
    const seen: Array<{ url: string; auth: string | undefined }> = []
    const answers = [200, 204, 401]
    const http: HttpClient = async (request) => {
      seen.push({ url: request.url, auth: request.headers?.Authorization })
      return { status: answers.shift() ?? 500, text: `denied for Bearer ${RUNPOD_KEY}` }
    }
    expect((await testEndpointPing(http, { endpointUrl, apiKey: RUNPOD_KEY })).ok).toBe('pass')
    expect((await testEndpointPing(http, { endpointUrl, apiKey: RUNPOD_KEY })).message).toContain('starting')
    const refused = await testEndpointPing(http, { endpointUrl: `${endpointUrl}/`, apiKey: RUNPOD_KEY })
    expect(refused.ok).toBe('fail')
    expect(refused.message).toContain('check the API key')
    expect(refused.message).not.toContain(RUNPOD_KEY)
    expect(seen[0]).toEqual({ url: `${endpointUrl}/ping`, auth: `Bearer ${RUNPOD_KEY}` })
    expect(seen[2]?.url).toBe(`${endpointUrl}/ping`)
  })

  test('the dry proof request passes only when the worker refuses it with 400', async () => {
    const bodies: string[] = []
    const make = (status: number): HttpClient => async (request) => {
      bodies.push(request.body ?? '')
      return { status, text: '{"error":"x"}' }
    }
    expect((await testDryProofRequest(make(400), { endpointUrl, apiKey: RUNPOD_KEY })).ok).toBe('pass')
    expect((await testDryProofRequest(make(200), { endpointUrl, apiKey: RUNPOD_KEY })).ok).toBe('fail')
    expect((await testDryProofRequest(make(503), { endpointUrl, apiKey: RUNPOD_KEY })).message).toContain('No worker')
    expect(JSON.parse(bodies[0] ?? '{}').programKey).toBe(`0x${'00'.repeat(32)}`)
  })

  test('the RPC test compares the chain identifier and redacts a keyed URL in every error', async () => {
    const rpcUrl = `https://one.valve.city/rpc/${VALVE_KEY}/evm/369`
    const good: HttpClient = async () => ({ status: 200, text: '{"result":"0x171"}' })
    expect((await testRpcChainId(good, { rpcUrl, expectedChainId: 369 })).ok).toBe('pass')
    const wrongChain = await testRpcChainId(good, { rpcUrl, expectedChainId: 1 })
    expect(wrongChain.ok).toBe('fail')
    expect(wrongChain.message).toContain('chain 369')
    const broken: HttpClient = async (request) => {
      throw new Error(`connect ECONNREFUSED ${request.url}`)
    }
    const failed = await testRpcChainId(broken, { rpcUrl, expectedChainId: 369 })
    expect(failed.ok).toBe('fail')
    expect(failed.message).not.toContain(VALVE_KEY)
  })

  test('the msgboard test sends msgboard_status, turns a WebSocket URL into HTTP, and reports an error answer', async () => {
    const requests: Array<{ url: string; body: string | undefined }> = []
    const answer = (text: string): HttpClient => async (request) => {
      requests.push({ url: request.url, body: request.body })
      return { status: 200, text }
    }
    expect((await testMsgboardStatus(answer('{"result":{"ok":true}}'), { url: `wss://one.valve.city/rpc/${VALVE_KEY}/evm/369` })).ok).toBe('pass')
    expect(requests[0]?.url).toBe(`https://one.valve.city/rpc/${VALVE_KEY}/evm/369`)
    expect(JSON.parse(requests[0]?.body ?? '{}').method).toBe('msgboard_status')
    const refused = await testMsgboardStatus(answer(`{"error":{"message":"no module ${VALVE_KEY}"}}`), { url: 'https://one.valve.city/rpc/x' })
    expect(refused.ok).toBe('fail')
    expect(refused.message).not.toContain(VALVE_KEY)
  })
})
