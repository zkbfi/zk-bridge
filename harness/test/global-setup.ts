import { startBothChains, stopChains } from '../src/anvil.js'

/** Starts both Anvil chains before any test file runs and stops them afterwards. */
export default async function setup() {
  const running = await startBothChains()
  return async () => {
    await stopChains(running)
  }
}
