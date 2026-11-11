/**
 * The planned transactions of the route steps that a visitor posts from their own wallet and that the gate steps do not
 * cover: the update of the fork registry's light client and the opening of a bridge's deposits. Each takes the proof
 * that the backend serves (`GET /steps/proofs/:kind/:subject`) and plans one call with its decode labels, so the review
 * dialog shows the contract, the function and the arguments. Pure: nothing here reads a chain, signs or sends.
 */
import { beaconLightClientAbi, displayArguments, messageBridgeAbi, type StepProof } from '@zk-bridge/shared'
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSignature, type Address, type AbiFunction, type Hex } from 'viem'
import type { ChainConfig } from '../model/types'
import { PlanInputError, type PlannedTransaction } from './plan'

/** The proof of an update of the fork registry's light client. */
export type RegistryUpdateProof = Extract<StepProof, { readonly kind: 'registry-light-client-update' }>

/** The opening proof of a bridge. */
export type OpenDepositsProof = Extract<StepProof, { readonly kind: 'open-deposits' }>

const functionOf = (abi: readonly unknown[], name: string): AbiFunction => (abi as readonly AbiFunction[]).find((item) => item.type === 'function' && item.name === name) as AbiFunction

/**
 * The planned transaction of an update of the fork registry's light client, for the review: `update(proof, publicValues)`
 * on that light client, no value. Anyone may send it; the light client checks the proof and that it starts at its head.
 * The backend's answer never chooses where the call goes: it goes to `lightClient`, read on chain from the configured
 * registry, and a proof that names another light client or chain is refused.
 *
 * @param chain The chain of the registry.
 * @param proof The backend's proof.
 * @param lightClient The registry's light client, read with `lightClient()` from the registry of the deployment.
 * @throws PlanInputError when the proof names another chain or another light client.
 */
export function planRegistryUpdate(chain: ChainConfig, proof: RegistryUpdateProof, lightClient: Address): PlannedTransaction {
  if (proof.chainId !== chain.chainId) throw new PlanInputError(`The proof is for another chain (${proof.chainId}), not ${chain.name} (${chain.chainId}).`)
  if (getAddress(proof.lightClient) !== getAddress(lightClient)) {
    throw new PlanInputError(`The proof names ${getAddress(proof.lightClient)}, which is not the ${chain.name} fork registry's light client (${getAddress(lightClient)}).`)
  }
  const item = functionOf(beaconLightClientAbi, 'update')
  const data: Hex = encodeFunctionData({ abi: beaconLightClientAbi, functionName: 'update', args: [proof.proof as Hex, proof.publicValues as Hex] })
  return {
    title: `Update the ${chain.name} fork registry light client`,
    chain,
    to: getAddress(lightClient),
    contractLabel: `${chain.name} fork registry light client (BeaconLightClient)`,
    functionSignature: toFunctionSignature(item),
    functionName: 'update',
    data,
    value: 0n,
    arguments: displayArguments(item.inputs, [proof.proof, proof.publicValues]),
    notes: [
      `The proof moves the registry's light client from slot ${proof.startSlot} to slot ${proof.newSlot} (header root ${proof.newRoot}), under program key ${proof.programKey}. The light client checks it against its own head and its program key.`,
      `It sends no ${chain.nativeSymbol}.`,
    ],
  }
}

/**
 * The planned transaction of the opening of a bridge's deposits, for the review: `openDeposits(proof)` on the bridge, no
 * value. The calldata is decoded with the bridge ABI. A call that is not `openDeposits`, or a proof whose bridge is not the
 * bridge of the chain, is refused.
 *
 * @param chain The chain of the bridge.
 * @param proof The backend's opening proof.
 * @throws PlanInputError when the calldata is not `openDeposits` or the bridge is not the chain's.
 */
export function planOpenDeposits(chain: ChainConfig, proof: OpenDepositsProof): PlannedTransaction {
  if (proof.chainId !== chain.chainId) throw new PlanInputError(`The opening proof is for another chain (${proof.chainId}), not ${chain.name} (${chain.chainId}).`)
  if (getAddress(proof.bridge) !== getAddress(chain.contracts.messageBridge)) {
    throw new PlanInputError(`The opening proof names ${getAddress(proof.bridge)}, which is not the ${chain.name} message bridge (${getAddress(chain.contracts.messageBridge)}).`)
  }
  let decoded: { readonly functionName: string; readonly args?: readonly unknown[] | undefined }
  try {
    decoded = decodeFunctionData({ abi: messageBridgeAbi, data: proof.calldata as Hex })
  } catch {
    throw new PlanInputError('The opening proof calldata is not a call to openDeposits.')
  }
  if (decoded.functionName !== 'openDeposits') throw new PlanInputError('The opening proof calldata is not a call to openDeposits.')
  const item = functionOf(messageBridgeAbi, 'openDeposits')
  return {
    title: `Open deposits on the ${chain.name} bridge`,
    chain,
    to: getAddress(chain.contracts.messageBridge),
    contractLabel: `${chain.name} message bridge (MessageBridge)`,
    functionSignature: toFunctionSignature(item),
    functionName: 'openDeposits',
    data: proof.calldata as Hex,
    value: 0n,
    arguments: displayArguments(item.inputs, decoded.args ?? []),
    notes: [
      `The proof shows the remote bridge at slot ${proof.remoteSlot} (block ${proof.remoteBlockNumber.toLocaleString('en-US')}) against the stored head at slot ${proof.storedSlot}. The bridge checks it on chain.`,
      `After it, the ${chain.name} bridge accepts deposits. It sends no ${chain.nativeSymbol}.`,
    ],
  }
}
