/**
 * Errors of the hardware wallets, with a stable code and a message that tells the user what to do.
 */

/** The reasons that a hardware wallet call fails, as far as the dashboard tells them apart. */
export type HardwareFailure =
  | 'rejected'
  | 'locked'
  | 'app-closed'
  | 'blind-signing-disabled'
  | 'no-device'
  | 'unavailable'
  | 'other'

/** A hardware wallet call failed. */
export class HardwareWalletError extends Error {
  override readonly name = 'HardwareWalletError'
  readonly failure: HardwareFailure

  constructor(failure: HardwareFailure, message: string) {
    super(message)
    this.failure = failure
  }
}

/** The messages for each failure. */
const MESSAGES: Readonly<Record<HardwareFailure, string>> = {
  rejected: 'You rejected the request on the device. Nothing was signed.',
  locked: 'The device is locked. Unlock it, then try again.',
  'app-closed': 'Open the Ethereum app on the device, then try again.',
  'blind-signing-disabled':
    'The device refused the contract data. Enable blind signing in the Ethereum app settings, then try again.',
  'no-device': 'No device found. Connect it by USB, unlock it, then try again.',
  unavailable: 'The device library is not available in this runtime.',
  other: 'The device returned an error.',
}

/** Builds an error with the standard message of a failure and an optional detail. */
export function hardwareError(failure: HardwareFailure, detail?: string): HardwareWalletError {
  const base = MESSAGES[failure]
  return new HardwareWalletError(failure, detail === undefined ? base : `${base} (${detail})`)
}
