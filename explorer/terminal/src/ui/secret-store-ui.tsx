/**
 * The parts of a view that open the secret store: the state of the opening, the line that tells it, and the password
 * prompt that the encrypted file needs. The Prover setup view and the Connections view both use them.
 */
import { useCallback, useEffect, useState } from 'react'
import { PasswordRequiredError, type ProverSetupServices } from '../app/services'
import { redactError, type SecretStore } from '@zk-bridge/shared/config'
import { FormView, useForm } from './form-view'
import { ModalFrame } from './modals'
import { RichLine, muted } from './rich-text'

/** How far the opening of the secret store has come. */
export type StoreState =
  | { readonly phase: 'opening' }
  | { readonly phase: 'password' }
  | { readonly phase: 'ready'; readonly store: SecretStore }
  | { readonly phase: 'failed'; readonly message: string }

/** What {@link useSecretStore} returns. */
export interface SecretStoreHandle {
  readonly state: StoreState
  /** The open store, or null while it is opening, locked or failed. */
  readonly store: SecretStore | null
  /** Opens the store again. The password is null for the first try. */
  open(password: string | null): void
  /** Gives up on the password. The store stays closed. */
  skip(): void
}

/**
 * Opens the secret store when the view opens, with no password. When the platform needs a password, the state becomes
 * `password` and the view shows {@link PasswordPrompt}.
 *
 * @param openSecretStore The opener of the services.
 */
export function useSecretStore(openSecretStore: ProverSetupServices['openSecretStore']): SecretStoreHandle {
  const [state, setState] = useState<StoreState>({ phase: 'opening' })
  const open = useCallback(
    (password: string | null) => {
      setState({ phase: 'opening' })
      openSecretStore({ password })
        .then((opened) => setState({ phase: 'ready', store: opened }))
        .catch((error: unknown) =>
          setState(error instanceof PasswordRequiredError ? { phase: 'password' } : { phase: 'failed', message: redactError(error, password === null ? [] : [password]) }),
        )
    },
    [openSecretStore],
  )
  useEffect(() => open(null), [open])
  const skip = useCallback(() => setState({ phase: 'failed', message: 'No secret store is open. Secrets cannot be saved.' }), [])
  return { state, store: state.phase === 'ready' ? state.store : null, open, skip }
}

/**
 * The line that tells which secret store is open.
 *
 * @param state The state of the opening.
 * @param readyText Builds the text for an open store from the name of its kind.
 */
export function storeLine(state: StoreState, readyText: (storeName: string) => string): string {
  if (state.phase === 'opening') return 'Opening the secret store…'
  if (state.phase === 'password') return 'The secret file needs a password.'
  if (state.phase === 'failed') return state.message
  const names = { 'macos-keychain': 'the macOS Keychain', 'secret-service': 'the Linux Secret Service', 'encrypted-file': 'an encrypted file' }
  return readyText(names[state.store.kind])
}

/** The prompt for the password of the encrypted secrets file. */
export function PasswordPrompt(props: { readonly onSubmit: (password: string) => void; readonly onCancel: () => void }) {
  const form = useForm({
    specs: [{ kind: 'secret', name: 'password', label: 'Password', hint: 'Opens the encrypted secrets file. A new file is created with this password.' }],
    onSubmit: (values) => ((values.password ?? '') === '' ? undefined : props.onSubmit(values.password ?? '')),
    onCancel: props.onCancel,
  })
  return (
    <ModalFrame title="Secrets file password" width={80} height={8}>
      <FormView form={form} width={76} />
      <RichLine line={[muted('No secret store was found on this machine. Enter submits. Esc skips.')]} />
    </ModalFrame>
  )
}
