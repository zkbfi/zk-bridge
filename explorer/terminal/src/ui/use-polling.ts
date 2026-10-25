/**
 * A hook that loads data now and again on an interval, and keeps the last good data when a load fails.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** The result of {@link usePolling}. */
export interface PollingState<Data> {
  /** The last data that loaded, or null before the first load. */
  readonly data: Data | null
  /** The message of the last failed load, or null when the last load worked. */
  readonly error: string | null
  readonly loading: 'yes' | 'no'
  /** Loads again now. */
  refresh(): void
}

interface InternalState<Data> {
  readonly data: Data | null
  readonly error: string | null
  readonly loading: 'yes' | 'no'
  readonly key: string
}

/**
 * Calls `load` at once and every `intervalMilliseconds`. A new `key` starts over with no data. The hook ignores the
 * result of a load that a newer load has replaced, so a slow answer cannot overwrite a newer one.
 *
 * @param load The loader. It may change on every render: the hook calls the latest one.
 * @param key Changes when the query changes, for example the pair or the filter.
 * @param intervalMilliseconds The time between loads. Zero loads once.
 */
export function usePolling<Data>(load: () => Promise<Data>, key: string, intervalMilliseconds: number): PollingState<Data> {
  const [state, setState] = useState<InternalState<Data>>({ data: null, error: null, loading: 'yes', key })
  const latestLoad = useRef(load)
  latestLoad.current = load
  const generation = useRef(0)

  const run = useCallback(() => {
    generation.current += 1
    const mine = generation.current
    latestLoad
      .current()
      .then((data) => {
        if (mine === generation.current) setState({ data, error: null, loading: 'no', key })
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return
        setState((previous) => ({
          data: previous.key === key ? previous.data : null,
          error: error instanceof Error ? error.message : String(error),
          loading: 'no',
          key,
        }))
      })
  }, [key])

  useEffect(() => {
    run()
    if (intervalMilliseconds <= 0) return undefined
    const timer = setInterval(run, intervalMilliseconds)
    return () => {
      clearInterval(timer)
      generation.current += 1
    }
  }, [run, intervalMilliseconds])

  const current: InternalState<Data> = state.key === key ? state : { data: null, error: null, loading: 'yes', key }
  return { data: current.data, error: current.error, loading: current.loading, refresh: run }
}
