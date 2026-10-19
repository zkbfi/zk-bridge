import { bytesToHex, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { ANVIL_MNEMONIC } from './constants.js'

/**
 * Returns the Anvil development account at the given index.
 * @param addressIndex - Position in the default Anvil mnemonic, from 0 to 9.
 */
export const anvilAccount = (addressIndex: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex })

/**
 * Returns the raw private key of the Anvil development account at the given index.
 * These keys are the public, well-known defaults that every Anvil instance starts with.
 */
export const anvilPrivateKey = (addressIndex: number): Hex => {
  const privateKey = anvilAccount(addressIndex).getHdKey().privateKey
  if (!privateKey) throw new Error(`Account ${addressIndex} has no private key`)
  return bytesToHex(privateKey)
}

/**
 * The roles that the tests use. Account 9 belongs to the prover oracle.
 * It is not listed here on purpose: only `prover/guest.ts` may use that key.
 */
export const roles = {
  deployer: anvilAccount(0),
  honestUser: anvilAccount(1),
  honestRelayer: anvilAccount(2),
  liquidityProvider: anvilAccount(3),
  secondHonestUser: anvilAccount(4),
  attacker: anvilAccount(5),
} as const

/** Index of the account that holds the prover oracle key. */
export const PROVER_ORACLE_ACCOUNT_INDEX = 9
