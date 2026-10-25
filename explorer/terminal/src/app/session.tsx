/**
 * The session: the connected signer, and the live account state of both chains that follows it.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChainSnapshotResult } from '../chain/live-reads'
import type { TokenInfo } from '../model/types'
import type { Signer } from '../signing/signer'
import { usePolling } from '../ui/use-polling'
import { useServices } from './services'

/** The session as the views read it. */
export interface Session {
  readonly signer: Signer | null
  /** Replaces the signer. The old one is disposed. Pass null to disconnect. */
  setSigner(signer: Signer | null): void
  /** The live snapshots of both chains for the signer, or null while none is loaded or no signer is connected. */
  readonly snapshots: readonly ChainSnapshotResult[] | null
  /** The tokens that the bridge knows on this pair. */
  readonly tokens: readonly TokenInfo[]
  /** Loads the snapshots again now. */
  refreshSnapshots(): void
}

const SessionContext = createContext<Session | null>(null)

/** How often the account state reloads, in milliseconds. */
const SNAPSHOT_INTERVAL_MILLISECONDS = 15_000

/** Input of {@link SessionProvider}. */
export interface SessionProviderProps {
  readonly pairId: string
  /** A signer that exists at startup, for example from a private key variable. */
  readonly initialSigner?: Signer | null
  readonly children: ReactNode
}

/** Owns the signer and polls the account state. */
export function SessionProvider({ pairId, initialSigner = null, children }: SessionProviderProps) {
  const { chainAccess, dataSource } = useServices()
  const [signer, setSignerState] = useState<Signer | null>(initialSigner)
  const previous = useRef<Signer | null>(initialSigner)

  const setSigner = useCallback((next: Signer | null) => {
    const old = previous.current
    previous.current = next
    setSignerState(next)
    if (old !== null && old !== next) void old.dispose()
  }, [])

  const tokensState = usePolling(() => dataSource.listTokens(pairId), `tokens|${pairId}`, 60_000)
  const tokens = useMemo(() => tokensState.data ?? [], [tokensState.data])
  const address = signer?.address

  const snapshotState = usePolling(
    async () => (address === undefined ? [] : chainAccess.readSnapshots({ account: address, tokens })),
    `snapshots|${address ?? 'none'}|${tokens.length}`,
    address === undefined ? 0 : SNAPSHOT_INTERVAL_MILLISECONDS,
  )
  const snapshots = address === undefined ? null : snapshotState.data

  useEffect(() => () => void previous.current?.dispose(), [])

  const value = useMemo<Session>(
    () => ({ signer, setSigner, snapshots, tokens, refreshSnapshots: snapshotState.refresh }),
    [signer, setSigner, snapshots, tokens, snapshotState.refresh],
  )
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

/** Reads the session. */
export function useSession(): Session {
  const session = useContext(SessionContext)
  if (session === null) throw new Error('useSession needs a SessionProvider above it.')
  return session
}
