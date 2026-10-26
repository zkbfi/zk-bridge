/**
 * Routes keyboard events to one handler at a time.
 *
 * OpenTUI's `useKeyboard` calls every subscriber for every key. A modal and the view below it would then both react
 * to the same key. This router subscribes once and picks the handler: the newest modal layer takes every key, and
 * with no modal open the view layer goes first, then the global layer. A handler returns true when it used the key.
 */
import { useKeyboard } from '@opentui/react'
import type { KeyEvent } from '@opentui/core'
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

/** The layers, from the most specific to the least. */
export type KeyLayer = 'modal' | 'view' | 'global'

/** A handler returns true when it used the key. */
export type KeyHandler = (key: KeyEvent) => boolean

interface Registration {
  readonly layer: KeyLayer
  readonly run: KeyHandler
}

interface Router {
  register(registration: Registration): () => void
}

const RouterContext = createContext<Router | null>(null)

/** Provides the router. Mount it once, above every component that handles keys. */
export function KeyRouterProvider({ children }: { readonly children: ReactNode }) {
  const registrations = useRef<Registration[]>([])
  const router = useRef<Router>({
    register(registration) {
      registrations.current.push(registration)
      return () => {
        registrations.current = registrations.current.filter((candidate) => candidate !== registration)
      }
    },
  })

  useKeyboard((key) => {
    if (key.eventType === 'release') return
    const all = registrations.current
    const modals = all.filter((entry) => entry.layer === 'modal')
    const newestModal = modals[modals.length - 1]
    if (newestModal !== undefined) {
      newestModal.run(key)
      return
    }
    for (const layer of ['view', 'global'] as const) {
      const handled = all.filter((entry) => entry.layer === layer).some((entry) => entry.run(key))
      if (handled) return
    }
  })

  return <RouterContext.Provider value={router.current}>{children}</RouterContext.Provider>
}

/** Options of {@link useKeyLayer}. */
export interface KeyLayerOptions {
  /** `off` removes the handler without unmounting the component. */
  readonly enabled: 'on' | 'off'
}

/**
 * Registers a key handler on a layer while it is enabled. The handler may change on every render: the router always
 * calls the latest one.
 */
export function useKeyLayer(layer: KeyLayer, handler: KeyHandler, options: KeyLayerOptions = { enabled: 'on' }): void {
  const router = useContext(RouterContext)
  if (router === null) throw new Error('useKeyLayer needs a KeyRouterProvider above it.')
  const latest = useRef(handler)
  latest.current = handler
  const { enabled } = options
  useEffect(() => {
    if (enabled === 'off') return undefined
    return router.register({ layer, run: (key) => latest.current(key) })
  }, [router, layer, enabled])
}
