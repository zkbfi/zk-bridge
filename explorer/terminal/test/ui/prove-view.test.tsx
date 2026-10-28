import { afterEach, describe, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { act } from 'react'
import type { CommandExecutor } from '@zk-bridge/shared/prover'
import { emptyProverSetup, type ProverSetup } from '@zk-bridge/shared/config'
import { ServicesProvider } from '../../src/app/services'
import type { FlowStep } from '../../src/flow/transaction-flow'
import { KeyRouterProvider } from '../../src/ui/key-router'
import { ProveModal, readinessLines, startBlockVariable, type ProveDependencies } from '../../src/ui/prove-view'
import { proofPackageText } from '../support/proof-package'
import { memoryStore, renderApp } from './harness'

type App = Awaited<ReturnType<typeof renderApp>>
let app: App | null = null
afterEach(() => {
  app?.destroy()
  app = null
})

const GIBIBYTE = 1024 ** 3
const savedSetup: ProverSetup = {
  ...emptyProverSetup(),
  chains: {
    '1': { rpc: { source: 'store', name: 'rpc1' }, beacon: { source: 'store', name: 'beacon1' } },
    '369': { rpc: { source: 'store', name: 'rpc369' }, beacon: { source: 'store', name: 'beacon369' } },
  },
}

async function filledStore() {
  const store = memoryStore()
  for (const [name, value] of [['rpc1', 'https://rpc.example/one'], ['beacon1', 'https://beacon.example/one'], ['rpc369', 'https://rpc.example/pls'], ['beacon369', 'https://beacon.example/pls']] as const) {
    await store.set(name, value)
  }
  return store
}

const environment = { PATH: '/usr/bin', [startBlockVariable(1)]: '100', [startBlockVariable(369)]: '200' }

function dependencies(changes: Partial<ProveDependencies> & { executor: CommandExecutor }): ProveDependencies {
  return { executablePath: '/opt/zk/zk-bridge-terminal', exists: () => true, totalMemoryBytes: 64 * GIBIBYTE, ...changes }
}

/** Renders the modal alone, with the services of a fixture app. */
async function renderModal(options: { readonly deps: ProveDependencies; readonly savedSetup?: ProverSetup; readonly environment?: Record<string, string> }) {
  app = await renderApp({ width: 120, height: 40, store: await filledStore(), savedSetup: options.savedSetup ?? savedSetup, environment: options.environment ?? environment })
  const reviews: Array<readonly FlowStep[]> = []
  const closed: string[] = []
  const setup = await testRender(
    <ServicesProvider services={app.services}>
      <KeyRouterProvider>
        <ProveModal dependencies={options.deps} onReview={(_title, steps) => reviews.push(steps)} onClose={() => closed.push('closed')} />
      </KeyRouterProvider>
    </ServicesProvider>,
    { width: 120, height: 40 },
  )
  const settle = async (milliseconds = 30) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds))
      await setup.renderOnce()
    })
  }
  const press = async (text: string) => {
    await act(async () => {
      setup.mockInput.pressKey(text === 'return' ? 'RETURN' : text === 'escape' ? 'ESCAPE' : text)
    })
    await settle(text === 'escape' ? 120 : 60)
  }
  await settle()
  const until = async (text: string) => {
    for (let attempt = 0; attempt < 100 && !setup.captureCharFrame().includes(text); attempt += 1) await settle(50)
  }
  return { setup, reviews, closed, press, settle, until, frame: () => setup.captureCharFrame() }
}

const success: CommandExecutor = async () => ({
  code: 0,
  stdout: `${proofPackageText()}\n`,
  stderr: 'ts=1000 level=info event=prove_started route=x\nts=1292 level=info event=proof_started program=light-client\n',
})

describe('the local proving dialog', () => {
  test('lists the missing files and starts nothing', async () => {
    const view = await renderModal({ deps: dependencies({ executor: success, exists: () => false }) })
    try {
      expect(view.frame()).toContain('Missing next to the terminal program: zk-bridge-prover, light-client.elf, fork-observation.elf')
      await view.press('1')
      expect(view.frame()).not.toContain('Proving on this computer')
      await view.press('escape')
      expect(view.closed).toEqual(['closed'])
    } finally {
      view.setup.renderer.destroy()
    }
  })

  test('refuses a machine with under 16 GiB of memory', async () => {
    const view = await renderModal({ deps: dependencies({ executor: success, totalMemoryBytes: 8 * GIBIBYTE }) })
    try {
      expect(view.frame()).toContain('A local proof needs at least 16 GiB')
      await view.press('2')
      expect(view.frame()).not.toContain('Proving on this computer')
    } finally {
      view.setup.renderer.destroy()
    }
  })

  test('a finished proof shows its stages and hands the update to the review', async () => {
    const view = await renderModal({ deps: dependencies({ executor: success, totalMemoryBytes: 32 * GIBIBYTE }) })
    try {
      expect(view.frame()).toContain('can be slow')
      await view.press('1')
      await view.until('The proof is ready')
      const frame = view.frame()
      expect(frame).toContain('The proof is ready')
      expect(frame).toContain('4 min 52 s')
      await view.press('return')
      expect(view.reviews).toHaveLength(1)
      expect(view.reviews[0]![0]!.plan.functionSignature).toBe('update(bytes,bytes)')
    } finally {
      view.setup.renderer.destroy()
    }
  })

  test('says so when the light client is already up to date, and offers no transaction', async () => {
    const upToDate: CommandExecutor = async () => ({ code: 3, stdout: '', stderr: 'ts=5 level=info event=up_to_date head_slot=9\n' })
    const view = await renderModal({ deps: dependencies({ executor: upToDate }) })
    try {
      await view.press('2')
      await view.until('Nothing to post')
      expect(view.frame()).toContain('Nothing to post')
      await view.press('return')
      expect(view.reviews).toEqual([])
    } finally {
      view.setup.renderer.destroy()
    }
  })

  test('shows a failure of the prover', async () => {
    const failing: CommandExecutor = async () => ({ code: 1, stdout: '', stderr: 'ts=5 level=error event=out_of_memory\n' })
    const view = await renderModal({ deps: dependencies({ executor: failing }) })
    try {
      await view.press('1')
      await view.until('out_of_memory')
      expect(view.frame()).toContain('out_of_memory')
    } finally {
      view.setup.renderer.destroy()
    }
  })

  test('says which setting is missing and runs nothing', async () => {
    let ran = 0
    const counting: CommandExecutor = async (spec) => {
      ran += 1
      return success(spec)
    }
    const noBeacon = { ...emptyProverSetup(), chains: { '1': { rpc: { source: 'store' as const, name: 'rpc1' }, beacon: null } } }
    const view = await renderModal({ deps: dependencies({ executor: counting }), savedSetup: noBeacon })
    try {
      await view.press('1')
      await view.until('is not set')
      expect(view.frame()).toContain('The beacon URL of Ethereum is not set')
      expect(ran).toBe(0)
    } finally {
      view.setup.renderer.destroy()
    }
  })

  test('says that a start block is missing', async () => {
    const view = await renderModal({ deps: dependencies({ executor: success }), environment: { PATH: '/usr/bin' } })
    try {
      await view.press('1')
      await view.until('is not set')
      expect(view.frame()).toContain('start block of Ethereum is not set')
    } finally {
      view.setup.renderer.destroy()
    }
  })
})

describe('the running clock', () => {
  test('redraws every second while the prover works', async () => {
    const slow: CommandExecutor = async (spec) => {
      await new Promise((resolve) => setTimeout(resolve, 1300))
      return success(spec)
    }
    const view = await renderModal({ deps: dependencies({ executor: slow }) })
    try {
      await view.press('1')
      await view.until('Proving on this computer')
      expect(view.frame()).toContain('Proving on this computer')
      await view.until('The proof is ready')
      expect(view.frame()).toContain('The proof is ready')
    } finally {
      view.setup.renderer.destroy()
    }
  })
})

describe('readinessLines', () => {
  test('is quiet when the files are present and the memory is enough', () => {
    expect(readinessLines({ bundle: { prover: 'a', lightClientElf: 'b', observationElf: 'c' }, machine: { blockers: [], warnings: [] } })).toHaveLength(1)
  })
})

describe('the app', () => {
  test('the p key opens the dialog and Esc closes it', async () => {
    app = await renderApp({ width: 120, height: 40 })
    await app.press('p')
    expect(app.frame()).toContain('Prove on this computer')
    await app.press('ESCAPE')
    expect(app.frame()).not.toContain('Prove on this computer')
  })

  test('a finished proof leaves the dialog and opens the review of the update', async () => {
    app = await renderApp({ width: 120, height: 40, store: await filledStore(), savedSetup, environment, proveDependencies: dependencies({ executor: success }) })
    await app.press('p')
    await app.press('1')
    for (let attempt = 0; attempt < 100 && !app.frame().includes('The proof is ready'); attempt += 1) await app.settle(50)
    await app.press('RETURN')
    expect(app.frame()).not.toContain('Prove on this computer')
    expect(app.frame()).toContain('Post a light client update')
  })
})
