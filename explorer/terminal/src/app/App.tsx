/**
 * The root of the dashboard: providers, the navigation state, the global keys, the open view and the open modal.
 */
import { useReducer, useState } from 'react'
import { useKeyLayer, KeyRouterProvider } from '../ui/key-router'
import { type ActionModalProps, BridgeModal, ExecuteModal, MessageModal, UpdateModal } from '../ui/action-modals'
import { AddressFilterModal, DetailModal, HelpOverlay, ReviewModal } from '../ui/modals'
import { ConnectionsView } from '../ui/connections-view'
import { SetupView } from '../ui/setup-view'
import { ProveModal, type ProveDependencies } from '../ui/prove-view'
import { SignerModal } from '../ui/signer-modal'
import { AuditView, GlobalView, PairView, ProverView } from '../ui/views'
import { theme } from '../ui/theme'
import type { Signer } from '../signing/signer'
import { VIEWS, createAppState, reduceAppState, type AppState } from './app-state'
import { ServicesProvider, useServices, type AppServices } from './services'
import { SessionProvider } from './session'

/** Props of {@link App}. */
export interface AppProps {
  readonly services: AppServices
  /** A signer that exists at startup, for example from a private key variable. */
  readonly initialSigner?: Signer | null
  /** What local proving asks of the machine. Only a test sets it. */
  readonly proveDependencies?: ProveDependencies
}

/** The dashboard. */
export function App({ services, initialSigner = null, proveDependencies }: AppProps) {
  return (
    <ServicesProvider services={services}>
      <KeyRouterProvider>
        <SessionProvider pairId={services.defaultPairId} initialSigner={initialSigner}>
          <Shell proveDependencies={proveDependencies} />
        </SessionProvider>
      </KeyRouterProvider>
    </ServicesProvider>
  )
}

function Shell(props: { readonly proveDependencies: ProveDependencies | undefined }) {
  const { defaultPairId, quit } = useServices()
  const [state, dispatch] = useReducer(reduceAppState, defaultPairId, createAppState)
  const [proveOpen, setProveOpen] = useState(false)
  const modalOpen = state.modal.kind !== 'none' || proveOpen ? 'yes' : 'no'

  useKeyLayer(
    'global',
    (key) => {
      if (key.name === 'q' && !key.ctrl) quit()
      else if (key.sequence === '?') dispatch({ type: 'toggle-help' })
      else if (key.name === 'p' && !key.ctrl) setProveOpen(true)
      else if (/^[1-9]$/.test(key.sequence) && VIEWS[Number(key.sequence) - 1] !== undefined) {
        dispatch({ type: 'show-view', view: VIEWS[Number(key.sequence) - 1]! })
      } else return false
      return true
    },
    { enabled: modalOpen === 'yes' || state.help === 'open' ? 'off' : 'on' },
  )

  return (
    <box width="100%" height="100%" backgroundColor={theme.background} flexDirection="column">
      <CurrentView state={state} dispatch={dispatch} modalOpen={modalOpen === 'yes' || state.help === 'open' ? 'yes' : 'no'} />
      {state.help === 'open' ? <HelpOverlay onClose={() => dispatch({ type: 'toggle-help' })} /> : null}
      <CurrentModal state={state} dispatch={dispatch} />
      {proveOpen ? (
        <ProveModal
          dependencies={props.proveDependencies}
          onReview={(title, steps) => {
            setProveOpen(false)
            dispatch({ type: 'open-modal', modal: { kind: 'review', title, steps } })
          }}
          onClose={() => setProveOpen(false)}
        />
      ) : null}
    </box>
  )
}

type DispatchOf = React.Dispatch<Parameters<typeof reduceAppState>[1]>

function CurrentView(props: { readonly state: AppState; readonly dispatch: DispatchOf; readonly modalOpen: 'yes' | 'no' }) {
  const { state, dispatch, modalOpen } = props
  if (state.view === 'global') return <GlobalView state={state} dispatch={dispatch} modalOpen={modalOpen} />
  if (state.view === 'audit') return <AuditView state={state} />
  if (state.view === 'prover') return <ProverView state={state} />
  if (state.view === 'connections') return <ConnectionsView />
  if (state.view === 'setup') return <SetupView />
  return <PairView state={state} dispatch={dispatch} modalOpen={modalOpen} />
}

function CurrentModal(props: { readonly state: AppState; readonly dispatch: DispatchOf }) {
  const { state, dispatch } = props
  const { modal } = state
  const close = () => dispatch({ type: 'close-modal' })
  const actionProps: ActionModalProps = {
    onClose: close,
    onReview: (title, steps) => dispatch({ type: 'open-modal', modal: { kind: 'review', title, steps } }),
  }
  if (modal.kind === 'signer') return <SignerModal onClose={close} />
  if (modal.kind === 'bridge') return <BridgeModal {...actionProps} />
  if (modal.kind === 'message') return <MessageModal {...actionProps} />
  if (modal.kind === 'update') return <UpdateModal {...actionProps} />
  if (modal.kind === 'execute') return <ExecuteModal {...actionProps} />
  if (modal.kind === 'address-filter') {
    return <AddressFilterModal current={state.filter.address} onApply={(address) => dispatch({ type: 'set-address-filter', address })} onClose={close} />
  }
  if (modal.kind === 'detail') return <DetailModal item={modal.item} onClose={close} />
  if (modal.kind === 'review') return <ReviewModal title={modal.title} steps={modal.steps} onClose={close} />
  return null
}
